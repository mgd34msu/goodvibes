/**
 * How the owner's answer to a question reaches the conversation that asked it:
 * a running agent, or a session's conversation (a terminal app's, a headless
 * run's, a hosted session's).
 *
 * Every process that asks reads the one owner inbox store directly
 * ({@link useOwnerAnswerReader}). An asker remembers the questions it still
 * waits on. Just before it builds a model request it compares the store's
 * revision with the one it last looked at; only when that integer moved does it
 * read its questions, and each answer it finds it first records as taken (the
 * first taker wins, so two processes holding the same session never both use
 * it), then puts on that request (`replay`, sent once). An asker with nothing
 * pending does nothing; nothing polls and no timer runs.
 *
 * A session or agent opened again reads what waited for it once (one indexed
 * read) and takes it on its first request. A session leaves to a running agent
 * the answers that agent asked for; once the agent stops, the session takes
 * them. A run whose model gave its final reply while an answer was arriving
 * takes one more turn, so the agent acts on it.
 */
import type { HostInstructions } from '../core/host-instructions.js';
import {
  answerAgentOf,
  isAskedBySession,
  questionClosedText,
  type OwnerAnswerReader,
  type OwnerItem,
} from '../control-plane/owner-inbox.js';
import { logger } from '../utils/logger.js';
import { holdAskerRunning, sessionAskerKey, type OwnerAskerKind } from '../control-plane/owner-asker-liveness.js';

let reader: OwnerAnswerReader | null = null;

/**
 * Name the store this process reads answers from: the daemon's inbox, or a
 * terminal's view of the home's one store. Set once by the composition.
 */
export function useOwnerAnswerReader(next: OwnerAnswerReader | null): void {
  reader = next;
}

/** The store answers are read from in this process, when one is set. */
export function ownerAnswerReader(): OwnerAnswerReader | null {
  return reader;
}

/** Every watch in this process, so a question the model read itself is dropped from all of them. */
const watches = new Set<AnswerWatch>();

/**
 * What a watch does with a closed item: `take` it, `leave` it for another asker
 * in this process (the running agent that asked it) and look again later, or
 * `drop` it (it belongs to a session no longer open here; that session reads it
 * when it is opened again).
 */
type AnswerRoute = 'take' | 'leave' | 'drop';

/** An asker a watch speaks for, named as its liveness lock is. */
interface AskerKey {
  readonly kind: OwnerAskerKind;
  readonly id: string;
}

/**
 * Questions one asker waits on, and the store revision it last looked at.
 * While it waits on any, this process holds the asker's lock, the fact every
 * other process reads to tell the owner the asker is running
 * (control-plane/owner-asker-liveness.ts); it gives the lock up when it waits
 * on nothing, when the asker stops, and the kernel does if the process dies.
 */
class AnswerWatch {
  readonly #pending = new Set<string>();
  /** The conversation's host channel while the asker is open here; undefined: keep waiting. */
  readonly #host: () => Pick<HostInstructions, 'set'> | undefined;
  readonly #route: (item: OwnerItem) => AnswerRoute;
  /** The askers this watch speaks for right now. */
  readonly #askers: () => readonly AskerKey[];
  /** Lock path to its release, for each asker whose lock this watch holds. */
  readonly #held = new Map<string, () => void>();
  #seen = -1;

  constructor(
    host: () => Pick<HostInstructions, 'set'> | undefined,
    askers: () => readonly AskerKey[],
    route: (item: OwnerItem) => AnswerRoute = () => 'take',
  ) {
    this.#host = host;
    this.#askers = askers;
    this.#route = route;
    watches.add(this);
  }

  /** Hold exactly the locks of the askers this watch speaks for while it waits on something; none otherwise. */
  sync(): void {
    const source = reader;
    const wanted = new Set<string>();
    if (source && this.#pending.size > 0) {
      for (const asker of this.#askers()) wanted.add(source.askerLivenessPath(asker.kind, asker.id));
    }
    for (const [path, release] of this.#held) {
      if (!wanted.has(path)) { release(); this.#held.delete(path); }
    }
    for (const path of wanted) {
      if (this.#held.has(path)) continue;
      try {
        this.#held.set(path, holdAskerRunning(path));
      } catch (error) {
        logger.debug('[owner-inbox] could not mark an asker running', { path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  get size(): number {
    return this.#pending.size;
  }

  add(id: string): void {
    this.#pending.add(id);
    this.#seen = -1;
    this.sync();
  }

  forget(id: string): void {
    if (this.#pending.delete(id)) this.sync();
  }

  clear(): void {
    this.#pending.clear();
    this.#seen = -1;
    this.sync();
  }

  dispose(): void {
    this.clear();
    watches.delete(this);
  }

  /** Hand over what closed since the last look. Returns how many texts went onto the next request. */
  pull(): number {
    const source = reader;
    if (!source || this.#pending.size === 0) return 0;
    const host = this.#host();
    if (!host) return 0;
    let revision: number;
    try {
      revision = source.revision();
    } catch (error) {
      logger.debug('[owner-inbox] the owner inbox store could not be read; answers wait for the next request', { error: error instanceof Error ? error.message : String(error) });
      return 0;
    }
    if (revision === this.#seen) return 0;
    let handed = 0;
    let left = false;
    for (const id of [...this.#pending]) {
      const item = source.get(id);
      if (!item) { this.#pending.delete(id); continue; }
      if (item.status === 'open') continue;
      const route = this.#route(item);
      if (route === 'leave') { left = true; continue; }
      this.#pending.delete(id);
      if (route === 'drop') continue;
      // Taken elsewhere (another process holding this session, or the model read it with query show), or settled as not deliverable.
      if (item.status === 'answered' && !source.claim(id)) continue;
      host.set('replay', questionClosedText(item), { once: true, append: true });
      handed += 1;
    }
    // An item left to a running agent is looked at again on the next request, in case the agent stopped.
    this.#seen = left ? -1 : revision;
    this.sync();
    return handed;
  }
}

interface OpenInlet {
  readonly watch: AnswerWatch;
  readonly host: HostInstructions;
  readonly running: () => boolean;
  /** Texts handed in so far. */
  handed: number;
  /** Texts carried by a request the provider accepted. */
  read: number;
}

const inlets = new Map<string, OpenInlet>();

export interface AgentInlet {
  /** Call just before a model request is built; pass the mark to `accepted` once the provider took it. */
  beforeRequest(): number;
  accepted(mark: number): void;
  /** Text was handed in (or an answer arrived) that no accepted request has carried yet. */
  unread(): boolean;
  /** Takes no more text; a later hand-in is refused and the agent's session takes its answers. */
  close(): void;
}

export interface AgentInletOptions {
  /** A later run of an agent that ran before (a wake): what waited for it is read once. */
  readonly resumed?: boolean | undefined;
  /**
   * The session this run is the next turn of (a channel's shared session):
   * answers to questions an earlier turn of it asked, which no running agent
   * takes, come to this run.
   */
  readonly session?: string | undefined;
}

/** True while `agentId` runs in this process and takes its own answers. */
export function isAgentTakingAnswers(agentId: string): boolean {
  const inlet = inlets.get(agentId);
  return inlet !== undefined && inlet.running();
}

function leftToRunningAgent(item: OwnerItem, self?: string): boolean {
  const agent = answerAgentOf(item);
  return agent !== undefined && agent !== self && isAgentTakingAnswers(agent);
}

function agentRoute(self: string): (item: OwnerItem) => AnswerRoute {
  return (item) => (leftToRunningAgent(item, self) ? 'leave' : 'take');
}

/** Opens the run's inlet. `running` says whether the run still reads requests (its record reads running). */
export function openAgentInlet(agentId: string, host: HostInstructions, running: () => boolean, options: AgentInletOptions = {}): AgentInlet {
  const askers: readonly AskerKey[] = [
    { kind: 'agent', id: agentId },
    ...(options.session !== undefined ? [{ kind: 'session' as const, id: options.session }] : []),
  ];
  const inlet: OpenInlet = {
    watch: new AnswerWatch(() => (running() ? host : undefined), () => askers, agentRoute(agentId)),
    host, running, handed: 0, read: 0,
  };
  inlets.set(agentId, inlet);
  const source = reader;
  if (source && (options.resumed === true || options.session !== undefined)) {
    try {
      if (options.resumed === true) for (const item of source.pendingFor({ agent: agentId })) inlet.watch.add(item.id);
      if (options.session !== undefined) {
        for (const item of source.pendingFor({ session: options.session })) inlet.watch.add(item.id);
      }
    } catch (error) {
      logger.debug('[owner-inbox] reading what waited for an agent failed; it is read at its next run', { agentId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const take = (): void => { inlet.handed += inlet.watch.pull(); };
  return {
    beforeRequest: () => { take(); return inlet.handed; },
    accepted: (mark) => { if (mark > inlet.read) inlet.read = mark; },
    unread: () => { take(); return inlet.handed > inlet.read; },
    // A later run of the same agent (a wake) has its own inlet, which this one never closes.
    close: () => {
      if (inlets.get(agentId) === inlet) inlets.delete(agentId);
      inlet.watch.dispose();
    },
  };
}

/** A question `agentId` just asked: it takes the answer on a later request while it runs. False when it is not running here. */
export function watchAgentQuestion(agentId: string, questionId: string): boolean {
  const inlet = inlets.get(agentId);
  if (!inlet || !inlet.running()) return false;
  inlet.watch.add(questionId);
  return true;
}

/**
 * Hands text straight to a running agent's next model request, for an answer
 * that arrived from an inbox this process does not read directly (a connected
 * host on another machine). False when the agent is not running or is finishing.
 */
export function tellRunningAgent(agentId: string, text: string): boolean {
  const inlet = inlets.get(agentId);
  if (!inlet || !inlet.running()) return false;
  inlet.host.set('replay', text, { once: true, append: true });
  inlet.handed += 1;
  return true;
}

/** The model read this question itself (query show): no asker is told it again. */
export function forgetOwnerQuestion(questionId: string): void {
  for (const watch of watches) watch.forget(questionId);
}

/** A conversation that can be asked to look just before each model request. */
export interface RequestingConversation {
  readonly hostInstructions: Pick<HostInstructions, 'set'>;
  onRequest(hook: () => void): () => void;
}

/** The answers one conversation's session waits on. */
export interface SessionAnswerWatch {
  /** The session that is open in the conversation now, if any. */
  readonly sessionId: string | undefined;
  /**
   * `sessionId` is now the session open in this conversation: what waited for
   * it is read once (one indexed read) and taken on its next request. Returns
   * how many questions and answers it found.
   */
  open(sessionId: string): number;
  /** A question the open session (or one of its agents) just asked. */
  add(questionId: string): void;
  /**
   * The session open in the conversation may have changed (a new or forked
   * session): the running lock follows it, so a session that left reads as
   * closed at once.
   */
  refresh(): void;
  /** The session left the conversation; its answers wait for the next open. */
  close(): void;
  dispose(): void;
}

/**
 * Watch the answers to the session open in `conversation` (`currentSession`
 * reads which one it is): before each model request it takes what arrived. One
 * hook per conversation; it costs nothing while the session waits on nothing.
 *
 * `sessionFile` gives a terminal session's identity, its saved file (it names
 * the app and the project store, so a namesake elsewhere is another session);
 * a hosted session has none and is known by its id.
 */
export function watchSessionAnswers(
  conversation: RequestingConversation,
  currentSession: () => string | undefined,
  sessionFile: (sessionId: string) => string | undefined = () => undefined,
): SessionAnswerWatch {
  // The session the watched questions belong to; when another takes its place they wait in the store for its next open.
  let tracked: string | undefined;
  let closed = false;
  const current = (): string | undefined => (closed ? undefined : currentSession());
  const fileOf = (sessionId: string | undefined): string | undefined => (sessionId === undefined ? undefined : sessionFile(sessionId));
  const watch = new AnswerWatch(
    () => (current() !== undefined ? conversation.hostInstructions : undefined),
    () => (tracked !== undefined ? [{ kind: 'session', id: sessionAskerKey({ session: tracked, sessionFile: fileOf(tracked) }) }] : []),
    (item) => {
      const session = current();
      return !isAskedBySession(item, session, fileOf(session)) ? 'drop' : leftToRunningAgent(item) ? 'leave' : 'take';
    },
  );
  const follow = (): void => {
    const session = current();
    if (session === tracked) return;
    tracked = session;
    watch.clear();
  };
  const stop = conversation.onRequest(() => { follow(); watch.pull(); });
  return {
    get sessionId() { return current(); },
    open(sessionId) {
      closed = false;
      if (tracked !== sessionId) { tracked = sessionId; watch.clear(); }
      const source = reader;
      if (!source) return 0;
      try {
        const items = source.pendingFor({ session: sessionId, sessionFile: fileOf(sessionId) });
        for (const item of items) watch.add(item.id);
        return items.length;
      } catch (error) {
        logger.debug('[owner-inbox] reading what waited for a session failed; it is read when the session is next opened', { sessionId, error: error instanceof Error ? error.message : String(error) });
        return 0;
      }
    },
    add(questionId) {
      follow();
      if (tracked !== undefined) watch.add(questionId);
    },
    refresh() { follow(); },
    close() { closed = true; follow(); },
    dispose() { stop(); closed = true; tracked = undefined; watch.dispose(); },
  };
}
