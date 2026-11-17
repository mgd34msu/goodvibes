/**
 * The owner inbox as a `query` tool sees it: each question is tagged with who
 * asked it (an agent, a session, and which process keeps that asker), and the
 * asker starts watching for the answer, which it takes on a later model request
 * (agent-inlets.ts). Inside the daemon this serves its agents (a channel's
 * turns and contract units included) and its hosted sessions; the terminal
 * apps tag their questions the same way (runtime/client/owner-inbox-updates.ts).
 *
 * Also here: where the daemon reads whether such an asker is open, can be
 * opened again, or is gone, from the records it already keeps. Nothing waits
 * or polls.
 */
import {
  OWNER_ANSWER_AGENT_METADATA,
  OWNER_ANSWER_SESSION_METADATA,
  OWNER_ASKER_HOST_METADATA,
  OWNER_ASKER_SESSION_FILE_METADATA,
  answerAgentOf,
  isAskedBySession,
  type OwnerAnswerReader,
  type OwnerAskerPresence,
  type OwnerAskerPresenceProbe,
  type OwnerItem,
} from '../control-plane/owner-inbox.js';
import { isSystemClosedSession } from '../control-plane/session-broker-sessions.js';
import type { SharedSessionRecord } from '../control-plane/session-types.js';
import type { QuestionInbox } from '../tools/query/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { callingAgentId } from './calling-agent.js';
import { forgetOwnerQuestion, watchAgentQuestion, type SessionAnswerWatch } from './agent-inlets.js';

/** Who is asking a question being posted now, and where the answer is watched for. */
export interface QuestionAsker {
  /** The agent asking, when one is; it takes the answer while it runs. */
  readonly agent?: string | undefined;
  /** The session the answer goes back to. */
  readonly session?: string | undefined;
  /** Which process keeps the asker: `hosted` session or `daemon` agent. Absent: a terminal app. */
  readonly host?: 'hosted' | 'daemon' | undefined;
  /** More facts about the asker kept on the question (a terminal session's saved file, which is also its identity). */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /** The watch of the asking session's conversation, when that conversation is in this process. */
  readonly sessionWatch?: SessionAnswerWatch | undefined;
}

/** An inbox the asker's process can also record "taken" in (the store itself, read directly). */
export type AskingInbox = QuestionInbox & Partial<Pick<OwnerAnswerReader, 'claim'>>;

function belongsTo(item: OwnerItem, asker: QuestionAsker): boolean {
  if (asker.agent !== undefined) return answerAgentOf(item) === asker.agent;
  return isAskedBySession(item, asker.session, asker.metadata?.[OWNER_ASKER_SESSION_FILE_METADATA]) && answerAgentOf(item) === undefined;
}

function askedByLabel(asker: QuestionAsker): string | undefined {
  if (asker.agent !== undefined) return asker.session !== undefined ? `agent ${asker.agent} in session ${asker.session}` : `agent ${asker.agent}`;
  return asker.session !== undefined ? `session ${asker.session}` : undefined;
}

/** Posts through `inbox` naming the asker; without one (`asker()` undefined) a post is left as it is. */
export function askingQuestions(inbox: AskingInbox, asker: () => QuestionAsker | undefined): QuestionInbox {
  const current = (): QuestionAsker | undefined => {
    const who = asker();
    return who && (who.agent !== undefined || who.session !== undefined) ? who : undefined;
  };
  return {
    async post(item) {
      const who = current();
      if (!who) return await inbox.post(item);
      const askedBy = item.askedBy ?? askedByLabel(who);
      const session = item.sessionId ?? who.session;
      const outcome = await inbox.post({
        ...item,
        ...(session !== undefined ? { sessionId: session } : {}),
        ...(askedBy !== undefined ? { askedBy } : {}),
        metadata: {
          ...item.metadata,
          ...who.metadata,
          ...(who.session !== undefined ? { [OWNER_ANSWER_SESSION_METADATA]: who.session } : {}),
          ...(who.agent !== undefined ? { [OWNER_ANSWER_AGENT_METADATA]: who.agent } : {}),
          ...(who.host !== undefined ? { [OWNER_ASKER_HOST_METADATA]: who.host } : {}),
        },
      });
      // A post under an open key returns the question someone already asked; only its own asker watches it.
      if (outcome.item.status === 'open' && (outcome.created || belongsTo(outcome.item, who))) {
        if (who.agent !== undefined) watchAgentQuestion(who.agent, outcome.item.id);
        if (who.sessionWatch && who.session !== undefined && who.sessionWatch.sessionId === who.session) who.sessionWatch.add(outcome.item.id);
      }
      return outcome;
    },
    async find(id) {
      const item = await inbox.find(id);
      // The model read the answer itself: it is taken, and no request carries it again.
      const who = current();
      if (item && item.status === 'answered' && who && belongsTo(item, who) && inbox.claim?.(item.id)) forgetOwnerQuestion(item.id);
      return item;
    },
    list: (filter) => inbox.list(filter),
    withdraw: async (id, reason) => {
      forgetOwnerQuestion(id);
      return await inbox.withdraw(id, reason);
    },
  };
}

/** The session id a channel's turn runs for, from the context the daemon spawns it with. */
export function sharedSessionOfContext(context: string | undefined): string | undefined {
  const match = context === undefined ? null : /(?:^|\n)shared-session:(\S+)/.exec(context);
  return match?.[1];
}

/**
 * The asker of a question a daemon agent's tool call posts: that agent, and
 * for a channel's turn its shared session, so a later turn of the session
 * takes an answer the asking turn did not live to read. Undefined outside an
 * agent's tool call.
 */
export function callingAgentAsker(agents: { getStatus(id: string): AgentRecord | null } | undefined): QuestionAsker | undefined {
  const agentId = callingAgentId();
  if (agentId === undefined) return undefined;
  const session = sharedSessionOfContext(agents?.getStatus(agentId)?.context);
  return { agent: agentId, host: 'daemon', ...(session !== undefined ? { session } : {}) };
}

/**
 * Where a daemon agent that asked is: running (`attached`); able to run again
 * (`closed`: a failed run can be woken, a contract unit reopened, a channel's
 * shared session gets its next turn, also after the idle reaper closed it,
 * since the next message reopens it); or gone (finished or cancelled for good,
 * its shared session closed by the owner or removed, or no longer known, as
 * after a daemon restart).
 */
export function daemonAgentPresence(
  agents: { getStatus(id: string): AgentRecord | null },
  sharedSessions?: { getSession(id: string): SharedSessionRecord | null },
): OwnerAskerPresenceProbe {
  return (asker, running): OwnerAskerPresence | undefined => {
    if (asker.host !== 'daemon' || asker.agent === undefined) return undefined;
    if (running) return { state: 'attached' };
    const record = agents.getStatus(asker.agent);
    if (record && (record.status === 'running' || record.status === 'pending')) return { state: 'attached' };
    if (asker.session !== undefined) {
      const shared = sharedSessions?.getSession(asker.session) ?? null;
      if (shared && (shared.status !== 'closed' || isSystemClosedSession(shared))) {
        const title = shared.title.trim();
        return { state: 'closed', ...(title ? { title } : {}), reopens: `the next message arrives in session ${asker.session}` };
      }
      return { state: 'gone', reason: `Session ${asker.session} was closed and agent ${asker.agent} is not running.` };
    }
    if (!record) return { state: 'gone', reason: `Agent ${asker.agent} is no longer known here: its record was cleared, or the daemon restarted since it asked.` };
    if (record.status === 'failed' || (record.status === 'completed' && record.contractUnitId !== undefined)) {
      return { state: 'closed', reopens: `agent ${asker.agent} runs again` };
    }
    return { state: 'gone', reason: record.status === 'cancelled'
      ? `Agent ${asker.agent} was cancelled and cannot run again.`
      : `Agent ${asker.agent} finished its run and cannot run again.` };
  };
}

/**
 * Where a hosted session (or an agent one of its turns started) that asked is:
 * running (`attached`); kept but idle, parked or restored after a restart
 * (`closed`: the session's conversation takes the answer when it is next
 * opened); ended or retired (`gone`).
 */
export function hostedSessionPresence(sessions: {
  get(id: string): { readonly status: string; readonly title?: string | undefined; readonly terminatedReason?: string | undefined } | null;
  liveTurnControls(id: string): unknown;
}): OwnerAskerPresenceProbe {
  return (asker, running): OwnerAskerPresence | undefined => {
    if (asker.host !== 'hosted') return undefined;
    if (running) return { state: 'attached' };
    if (asker.session === undefined) return { state: 'closed', reopens: `agent ${asker.agent ?? 'unknown'} runs again` };
    const record = sessions.get(asker.session);
    if (!record) return { state: 'gone', reason: `Hosted session ${asker.session} no longer exists.` };
    if (record.status === 'terminated') {
      return { state: 'gone', reason: `Hosted session ${asker.session} was ended${record.terminatedReason ? ` (${record.terminatedReason})` : ''} and cannot be reopened.` };
    }
    const title = record.title?.trim();
    const titled = title ? { title } : {};
    return sessions.liveTurnControls(asker.session) !== null ? { state: 'attached', ...titled } : { state: 'closed', ...titled };
  };
}
