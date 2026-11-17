/**
 * owner-inbox-updates.ts, how a terminal session that left the owner a question
 * hears the answer.
 *
 * The `query` tool posts a question and the agent carries on. The question is
 * recorded as asked by the session (its id in `answerSession`, the spawned
 * agent that asked in `answerAgent`, the session's saved file and liveness
 * marker so any process can tell whether it is open). The home's one store
 * holds it whether a daemon on this machine took the post or the terminal wrote
 * it itself, so the asker reads the answer there: the spawned agent that asked
 * takes it on its next model request while it runs, otherwise the session's
 * conversation does, comparing one integer before each request
 * (agents/agent-inlets.ts). An answer given while the session was closed waits
 * in the store; {@link AnswerDeliveringInbox.openSession} reads it once when the
 * session is opened again.
 *
 * A daemon on another machine (a connected host) keeps its own store, which
 * this terminal cannot read. For a question posted there the session holds the
 * host's update stream while the question is open and reports the answer taken
 * over the wire, as before; with nothing open there, there is no stream.
 */

import type { OwnerAnswerDeliveryReport, OwnerAnswerOutcome, OwnerAnswerReader, OwnerInbox, OwnerInboxListFilter, OwnerItem } from '../../control-plane/owner-inbox.js';
import {
  OWNER_ANSWER_AGENT_METADATA,
  OWNER_ANSWER_SESSION_METADATA,
  OWNER_ASKER_SESSION_FILE_METADATA,
  answerAgentOf,
  answerSessionOf,
  isAskedBySession,
  questionClosedText,
  readOwnerItem,
} from '../../control-plane/owner-inbox.js';
import type { HostInstructions } from '../../core/host-instructions.js';
import type { QuestionInbox } from '../../tools/query/index.js';
import { openServerSentEventStream } from '../transports/sse-stream.js';
import { buildUrl } from '../transports/transport-paths.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { callingAgentId } from '../../agents/calling-agent.js';
import { forgetOwnerQuestion, tellRunningAgent, watchAgentQuestion, type SessionAnswerWatch } from '../../agents/agent-inlets.js';

export { questionClosedText };

/** The wire event the daemon's owner inbox publishes question changes on. */
export const OWNER_INBOX_UPDATE_WIRE_EVENT = 'owner-inbox-update';
/** The event domain the inbox stream is tagged with (the same as approvals). */
export const OWNER_INBOX_UPDATE_DOMAIN = 'gate';

export interface OwnerInboxUpdateSubscription {
  close(): void;
}

/** Opens a subscription; null when it could not be opened. `onEnd` runs once when an opened stream ends by itself. */
export type OwnerInboxUpdateWatch = (
  onItem: (item: OwnerItem) => void,
  onEnd: () => void,
) => Promise<OwnerInboxUpdateSubscription | null> | OwnerInboxUpdateSubscription | null;

export interface WatchOwnerInboxUpdatesOptions {
  readonly baseUrl: string;
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  readonly onItem: (item: OwnerItem) => void;
  readonly onTerminate?: (() => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Open the daemon's event stream narrowed to the inbox's domain. Null when it could not be opened. */
export async function watchOwnerInboxUpdates(options: WatchOwnerInboxUpdatesOptions): Promise<OwnerInboxUpdateSubscription | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const url = new URL(buildUrl(options.baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', OWNER_INBOX_UPDATE_DOMAIN);
  try {
    const close = await openServerSentEventStream(
      fetchImpl,
      url.toString(),
      {
        onEvent: (eventName, payload) => {
          if (eventName !== OWNER_INBOX_UPDATE_WIRE_EVENT || typeof payload !== 'object' || payload === null) return;
          const item = readOwnerItem((payload as Record<string, unknown>)['item']);
          if (!item) return;
          try {
            options.onItem(item);
          } catch (error) {
            logger.debug('[owner-inbox] an update subscriber threw', { error: summarizeError(error) });
          }
        },
        onTerminate: () => options.onTerminate?.(),
        onClose: () => options.onTerminate?.(),
      },
      options.getAuthToken ? { getAuthToken: options.getAuthToken } : {},
    );
    let closed = false;
    return { close: () => { if (!closed) { closed = true; close(); } } };
  } catch (error) {
    logger.debug('[owner-inbox] the update stream could not be opened; answers are read with query show', { error: summarizeError(error) });
    return null;
  }
}

/** The inbox under {@link withAnswerDelivery}: the query tool's inbox plus the asking session's delivery report. */
export type AnswerDeliveryPort = QuestionInbox & {
  reportDelivery(id: string, report: OwnerAnswerDeliveryReport): OwnerAnswerOutcome | Promise<OwnerAnswerOutcome>;
};

/** The query tool's inbox that also hands answers to the session that asked. */
export interface AnswerDeliveringInbox extends QuestionInbox {
  /**
   * The session `sessionId` was opened (resumed, loaded, continued, headless or
   * in a terminal): answers that waited for it go into its next model request,
   * once, and its open questions are watched again. Resolves with how many
   * questions and answers it found. One indexed read of the home store; one
   * inbox list over the wire only while a daemon is reachable that is not known
   * to keep this home's store.
   */
  openSession(sessionId: string): Promise<number>;
  /**
   * The saved session `sessionId` was deleted: its open questions are withdrawn
   * and answers still waiting for it are marked not deliverable, so the owner
   * sees why. One transaction on the home store.
   */
  deleteSession(sessionId: string): Promise<void>;
}

export interface AnswerDeliveryOptions {
  /** The home's one store, read directly: where this terminal's sessions and agents take their answers. */
  readonly home: OwnerAnswerReader & Pick<OwnerInbox, 'settleSession'>;
  /** The watch of the live conversation's session; undefined until the app wired it. */
  readonly sessionWatch: () => SessionAnswerWatch | undefined;
  /**
   * Facts kept on a question about the session that asked it: its saved file,
   * which is also the session's identity (app, project store and id), so an
   * answer goes to that session and never to a namesake in another app.
   */
  readonly askerFacts?: ((sessionId: string) => Readonly<Record<string, string>>) | undefined;
  /** True while a daemon is reachable; its inbox may be another machine's (read over the wire only then). */
  readonly daemonReachable: () => boolean;
  /** The reachable daemon's own list, for the questions a session asked there. */
  readonly daemon: { list(filter?: OwnerInboxListFilter): Promise<readonly OwnerItem[]> };
  /** Opens the reachable daemon's update stream, for questions posted to a daemon that keeps another store. */
  readonly watch: OwnerInboxUpdateWatch;
  /** The host channel of the conversation running `sessionId` in this process, for those questions. */
  readonly hostFor: (sessionId: string | undefined) => Pick<HostInstructions, 'set'> | undefined;
  /**
   * The session a question belongs to when the caller did not say: a spawned
   * agent's questions belong to the conversation that spawned it.
   */
  readonly sessionId?: (() => string | undefined) | undefined;
}

/** How many of one session's questions a session open or delete reads over the wire; a session asks far fewer. */
const SESSION_QUESTION_LIMIT = 500;

// Whether the reachable daemon keeps this home's store, learned from the first item it returned (it is, or is
// not, also in the home store). Unknown until then; a daemon on this machine always does.
let daemonSharesStore: boolean | undefined;

/**
 * The inbox the `query` tool posts to, plus delivery of each answer to the
 * asking agent or conversation.
 */
export function withAnswerDelivery(inbox: AnswerDeliveryPort, options: AnswerDeliveryOptions): AnswerDeliveringInbox {
  const { home } = options;
  const held = (id: string): boolean => home.get(id) !== undefined;
  const learn = (id: string): boolean => {
    const local = held(id);
    if (options.daemonReachable()) daemonSharesStore = local;
    return local;
  };

  // Questions a daemon on another machine holds: one stream while one is open.
  const remotePending = new Set<string>();
  const remoteAgents = new Map<string, string>();
  let subscription: OwnerInboxUpdateSubscription | null = null;
  let opening: Promise<void> | null = null;

  const closeWhenIdle = (): void => {
    if (remotePending.size === 0) { subscription?.close(); subscription = null; }
  };
  const forgetRemote = (id: string): void => {
    remoteAgents.delete(id);
    if (remotePending.delete(id)) closeWhenIdle();
  };

  /** A closed remote question goes to whoever asked it; an answer is reported taken first, and handed over only when that report counted. */
  const handOverRemote = async (item: OwnerItem, agentId: string | undefined): Promise<boolean> => {
    const host = options.hostFor(item.sessionId);
    if (!host) return false;
    const text = questionClosedText(item);
    if (item.status === 'answered' && answerSessionOf(item) !== undefined) {
      const report = await inbox.reportDelivery(item.id, { state: 'delivered' });
      if (!report.applied) return false;
    }
    if (agentId === undefined || !tellRunningAgent(agentId, text)) host.set('replay', text, { once: true, append: true });
    return true;
  };

  const settleRemote = (item: OwnerItem): void => {
    if (item.status === 'open' || !remotePending.delete(item.id)) return;
    const agentId = remoteAgents.get(item.id);
    remoteAgents.delete(item.id);
    closeWhenIdle();
    void handOverRemote(item, agentId).catch((error: unknown) => {
      logger.debug('[owner-inbox] delivering an answer failed; it waits for the session to be opened again', { itemId: item.id, error: summarizeError(error) });
    });
  };

  const ensureWatching = (): void => {
    if (subscription || opening) return;
    opening = (async () => {
      const opened = await options.watch(
        (item) => { if (item.kind === 'question') settleRemote(item); },
        () => { subscription = null; },
      );
      if (remotePending.size === 0) { opened?.close(); return; }
      subscription = opened;
      // An answer can land between the post and the subscription; one read per open question covers it.
      for (const id of [...remotePending]) {
        const item = await inbox.find(id).catch(() => undefined);
        if (item) settleRemote(item);
      }
    })().catch((error: unknown) => {
      logger.debug('[owner-inbox] watching for answers failed', { error: summarizeError(error) });
    }).finally(() => { opening = null; });
  };

  const sessionId = (): string | undefined => options.sessionId?.() || undefined;
  /** A session's identity: its saved file, as recorded on the questions it asks. */
  const fileOf = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const file = options.askerFacts?.(id)[OWNER_ASKER_SESSION_FILE_METADATA];
    return file !== undefined && file.length > 0 ? file : undefined;
  };

  /** One session's questions on a daemon that may keep another store; empty when it keeps this one. */
  const remoteSessionQuestions = async (id: string): Promise<readonly OwnerItem[]> => {
    if (!options.daemonReachable() || daemonSharesStore === true) return [];
    const items = await options.daemon.list({ sessionId: id, kinds: ['question'], status: 'all', limit: SESSION_QUESTION_LIMIT });
    const file = fileOf(id);
    return items.filter((item) => !learn(item.id) && isAskedBySession(item, id, file));
  };

  return {
    async post(item) {
      const session = item.sessionId ?? sessionId();
      const agentId = callingAgentId();
      // The asker is the session (and the spawned agent asking, when one is): the answer goes back into it, now or when it is next opened.
      const outcome = await inbox.post(session ? {
        ...item,
        sessionId: session,
        askedBy: item.askedBy ?? (agentId !== undefined ? `agent ${agentId} in session ${session}` : `session ${session}`),
        metadata: {
          ...item.metadata,
          ...options.askerFacts?.(session),
          [OWNER_ANSWER_SESSION_METADATA]: session,
          ...(agentId !== undefined ? { [OWNER_ANSWER_AGENT_METADATA]: agentId } : {}),
        },
      } : item);
      const posted = outcome.item;
      const own = outcome.created || (isAskedBySession(posted, session, fileOf(session)) && answerAgentOf(posted) === agentId);
      if (posted.status !== 'open' || !own) return outcome;
      if (learn(posted.id)) {
        if (agentId !== undefined) watchAgentQuestion(agentId, posted.id);
        const watch = options.sessionWatch();
        if (watch && session !== undefined && watch.sessionId === session) watch.add(posted.id);
      } else {
        remotePending.add(posted.id);
        if (agentId !== undefined) remoteAgents.set(posted.id, agentId);
        ensureWatching();
      }
      return outcome;
    },
    async find(id) {
      const item = await inbox.find(id);
      if (item && item.status !== 'open') {
        // The model read the answer itself; it is taken, and it is not told a second time.
        forgetRemote(item.id);
        const session = sessionId();
        const mine = isAskedBySession(item, session, fileOf(session));
        if (item.status === 'answered' && mine && held(item.id) && home.claim(item.id)) forgetOwnerQuestion(item.id);
      }
      return item;
    },
    async list(filter?: OwnerInboxListFilter) {
      const session = filter?.sessionId ?? sessionId();
      const items = await inbox.list(session ? { ...filter, sessionId: session } : filter);
      if (!session) return items;
      // The store filters by id; a namesake session in another app or project asked the ones whose saved file differs.
      const file = fileOf(session);
      return items.filter((item) => answerSessionOf(item) !== session || isAskedBySession(item, session, file));
    },
    async withdraw(id, reason): Promise<OwnerAnswerOutcome> {
      forgetRemote(id);
      forgetOwnerQuestion(id);
      return await inbox.withdraw(id, reason);
    },
    async openSession(id) {
      let found = options.sessionWatch()?.open(id) ?? 0;
      let remote: readonly OwnerItem[] = [];
      try {
        remote = await remoteSessionQuestions(id);
      } catch (error) {
        logger.debug('[owner-inbox] reading the questions of an opened session from the daemon failed; its answers wait for the next open', { sessionId: id, error: summarizeError(error) });
      }
      for (const item of remote) {
        if (item.status === 'open') { remotePending.add(item.id); found += 1; continue; }
        if (item.status !== 'answered' || item.delivery?.state !== 'waiting') continue;
        found += 1;
        try {
          await handOverRemote(item, undefined);
        } catch (error) {
          logger.debug('[owner-inbox] handing a waiting answer over failed; it waits for the next open', { itemId: item.id, error: summarizeError(error) });
        }
      }
      if (remotePending.size > 0) ensureWatching();
      return found;
    },
    async deleteSession(id) {
      const why = `session ${id} was deleted`;
      try {
        home.settleSession(id, why, fileOf(id));
      } catch (error) {
        logger.debug('[owner-inbox] settling the questions of a deleted session failed', { sessionId: id, error: summarizeError(error) });
      }
      let remote: readonly OwnerItem[] = [];
      try {
        remote = await remoteSessionQuestions(id);
      } catch (error) {
        logger.debug('[owner-inbox] reading the questions of a deleted session from the daemon failed', { sessionId: id, error: summarizeError(error) });
      }
      for (const item of remote) {
        try {
          if (item.status === 'open') {
            forgetRemote(item.id);
            await inbox.withdraw(item.id, `${why}, so the question will not be answered there`);
          } else if (item.status === 'answered' && item.delivery?.state === 'waiting') {
            await inbox.reportDelivery(item.id, { state: 'undeliverable', reason: `${why} before it was opened again. The answer is kept on the question.` });
          }
        } catch (error) {
          logger.debug('[owner-inbox] settling a question of a deleted session failed', { itemId: item.id, error: summarizeError(error) });
        }
      }
    },
  };
}
