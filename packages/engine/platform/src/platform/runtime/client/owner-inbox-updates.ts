/**
 * owner-inbox-updates.ts, how a session that left the owner a question hears
 * the answer.
 *
 * The `query` tool posts a question and the agent carries on. The question is
 * recorded as asked by the session (its id, in `answerSession`). When the owner
 * answers (terminal, web UI, phone), the inbox publishes the item on
 * `owner-inbox-update`. {@link withAnswerDelivery} wraps the inbox the tool
 * posts to: while one of its questions is open it holds one subscription, and
 * when a question is answered the session reports the answer delivered (the
 * first report wins, so one terminal takes it) and puts it on the next model
 * request of the spawned agent that asked while it runs, otherwise of the
 * asking conversation. An answer given while the session was not open waits on
 * the question; {@link AnswerDeliveringInbox.openSession} hands it over when
 * the session is opened again. With nothing open there is no stream and no
 * request.
 */

import type { OwnerAnswerDeliveryReport, OwnerAnswerOutcome, OwnerInboxListFilter, OwnerItem } from '../../control-plane/owner-inbox.js';
import { OWNER_ANSWER_SESSION_METADATA, answerSessionOf, readOwnerItem } from '../../control-plane/owner-inbox.js';
import type { HostInstructions } from '../../core/host-instructions.js';
import type { QuestionInbox } from '../../tools/query/index.js';
import { openServerSentEventStream } from '../transports/sse-stream.js';
import { buildUrl } from '../transports/transport-paths.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { callingAgentId } from '../../agents/calling-agent.js';
import { tellRunningAgent } from '../../agents/agent-inlets.js';

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

/** The line the asking conversation is given when its question closes. */
export function questionClosedText(item: OwnerItem): string {
  const question = `question ${item.id} ("${item.title}")`;
  if (item.status === 'answered') {
    const parts = [item.answer?.option, item.answer?.text].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    const from = item.answeredBy ? ` from ${item.answeredBy.surface}` : '';
    return `[Owner answer] The owner answered your ${question}${from}: ${parts.length > 0 ? parts.join(' - ') : '(no text)'}`;
  }
  if (item.status === 'withdrawn') return `[Owner answer] Your ${question} was withdrawn${item.withdrawnReason ? `: ${item.withdrawnReason}` : ''}. It will not be answered.`;
  return `[Owner answer] Your ${question} expired unanswered. Decide without it or ask again.`;
}

/** The inbox under {@link withAnswerDelivery}: the query tool's inbox plus the asking session's delivery report. */
export type AnswerDeliveryPort = QuestionInbox & {
  reportDelivery(id: string, report: OwnerAnswerDeliveryReport): OwnerAnswerOutcome | Promise<OwnerAnswerOutcome>;
};

/** The query tool's inbox that also hands answers to the session that asked. */
export interface AnswerDeliveringInbox extends QuestionInbox {
  /**
   * The session `sessionId` was opened (resumed, loaded, continued, headless or
   * in a terminal): answers that waited for it go into its conversation, once,
   * and its open questions are watched again. Resolves with how many answers it
   * handed over. One inbox list read; nothing when no daemon or local inbox holds anything.
   */
  openSession(sessionId: string): Promise<number>;
  /**
   * The saved session `sessionId` was deleted: its open questions are withdrawn
   * and answers still waiting for it are reported not deliverable, so the owner
   * sees why. One inbox list read, and one write per such question.
   */
  deleteSession(sessionId: string): Promise<void>;
}

export interface AnswerDeliveryOptions {
  /** Opens the inbox update stream (or an in-process subscription). */
  readonly watch: OwnerInboxUpdateWatch;
  /**
   * The host channel of the conversation running `sessionId` in this process,
   * or undefined when that session is not the one open here. An answer goes
   * onto its next model request (`replay`, once).
   */
  readonly hostFor: (sessionId: string | undefined) => Pick<HostInstructions, 'set'> | undefined;
  /**
   * The session a question belongs to when the caller did not say: a spawned
   * agent's questions belong to the conversation that spawned it.
   */
  readonly sessionId?: (() => string | undefined) | undefined;
}

/** How many of one session's questions a session open or delete reads; a session asks far fewer. */
const SESSION_QUESTION_LIMIT = 500;

/**
 * The inbox the `query` tool posts to, plus delivery of each answer to the
 * asking agent or conversation. One subscription is held only while one of its
 * questions is open; it closes when the last one closes.
 */
export function withAnswerDelivery(inbox: AnswerDeliveryPort, options: AnswerDeliveryOptions): AnswerDeliveringInbox {
  const pending = new Set<string>();
  // The spawned agent that asked each open question, when one did.
  const askingAgents = new Map<string, string>();
  let subscription: OwnerInboxUpdateSubscription | null = null;
  let opening: Promise<void> | null = null;

  const closeWhenIdle = (): void => {
    if (pending.size === 0) { subscription?.close(); subscription = null; }
  };
  const forget = (id: string): void => {
    askingAgents.delete(id);
    if (pending.delete(id)) closeWhenIdle();
  };

  /**
   * Put a closed question in front of whoever asked it. An answer is first
   * reported delivered, and handed over only when that report is the one that
   * counted: a session that is not open here, a report another terminal made
   * first, or a daemon that cannot be reached leaves it waiting for the next
   * open. True when it was handed over.
   */
  const handOver = async (item: OwnerItem, agentId: string | undefined): Promise<boolean> => {
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

  const settle = (item: OwnerItem): void => {
    if (item.status === 'open' || !pending.delete(item.id)) return;
    const agentId = askingAgents.get(item.id);
    askingAgents.delete(item.id);
    closeWhenIdle();
    void handOver(item, agentId).catch((error: unknown) => {
      logger.debug('[owner-inbox] delivering an answer failed; it waits for the session to be opened again', { itemId: item.id, error: summarizeError(error) });
    });
  };

  const ensureWatching = (): void => {
    if (subscription || opening) return;
    opening = (async () => {
      const opened = await options.watch(
        (item) => { if (item.kind === 'question') settle(item); },
        () => { subscription = null; },
      );
      if (pending.size === 0) { opened?.close(); return; }
      subscription = opened;
      // An answer can land between the post and the subscription; one read per open question covers it.
      for (const id of [...pending]) {
        const item = await inbox.find(id).catch(() => undefined);
        if (item) settle(item);
      }
    })().catch((error: unknown) => {
      logger.debug('[owner-inbox] watching for answers failed', { error: summarizeError(error) });
    }).finally(() => { opening = null; });
  };

  const sessionId = (): string | undefined => options.sessionId?.() || undefined;

  const sessionQuestions = (id: string): Promise<readonly OwnerItem[]> =>
    inbox.list({ sessionId: id, kinds: ['question'], status: 'all', limit: SESSION_QUESTION_LIMIT });

  return {
    async post(item) {
      const session = item.sessionId ?? sessionId();
      const agentId = callingAgentId();
      // The asker is the session: the answer goes back into its conversation, now or when it is next opened.
      const outcome = await inbox.post(session ? {
        ...item,
        sessionId: session,
        askedBy: item.askedBy ?? (agentId !== undefined ? `agent ${agentId} in session ${session}` : `session ${session}`),
        metadata: { ...item.metadata, [OWNER_ANSWER_SESSION_METADATA]: session },
      } : item);
      if (outcome.item.status === 'open') {
        pending.add(outcome.item.id);
        if (agentId !== undefined && outcome.created) askingAgents.set(outcome.item.id, agentId);
        ensureWatching();
      }
      return outcome;
    },
    async find(id) {
      const item = await inbox.find(id);
      // The model read the answer itself; it is not told a second time.
      if (item && item.status !== 'open') forget(item.id);
      return item;
    },
    list(filter?: OwnerInboxListFilter) {
      const session = filter?.sessionId ?? sessionId();
      return inbox.list(session ? { ...filter, sessionId: session } : filter);
    },
    async withdraw(id, reason): Promise<OwnerAnswerOutcome> {
      forget(id);
      return await inbox.withdraw(id, reason);
    },
    async openSession(id) {
      let items: readonly OwnerItem[];
      try {
        items = await sessionQuestions(id);
      } catch (error) {
        logger.debug('[owner-inbox] reading the questions of an opened session failed; its answers wait for the next open', { sessionId: id, error: summarizeError(error) });
        return 0;
      }
      let handed = 0;
      for (const item of items) {
        if (item.status === 'open') { pending.add(item.id); continue; }
        if (item.status !== 'answered' || item.delivery?.state !== 'waiting') continue;
        try {
          if (await handOver(item, undefined)) handed += 1;
        } catch (error) {
          logger.debug('[owner-inbox] handing a waiting answer over failed; it waits for the next open', { itemId: item.id, error: summarizeError(error) });
        }
      }
      if (pending.size > 0) ensureWatching();
      return handed;
    },
    async deleteSession(id) {
      let items: readonly OwnerItem[];
      try {
        items = await sessionQuestions(id);
      } catch (error) {
        logger.debug('[owner-inbox] reading the questions of a deleted session failed', { sessionId: id, error: summarizeError(error) });
        return;
      }
      for (const item of items) {
        try {
          if (item.status === 'open') {
            forget(item.id);
            await inbox.withdraw(item.id, `its session ${id} was deleted`);
          } else if (item.status === 'answered' && item.delivery?.state === 'waiting') {
            await inbox.reportDelivery(item.id, { state: 'undeliverable', reason: `session ${id} was deleted before it was opened again. The answer is kept on the question.` });
          }
        } catch (error) {
          logger.debug('[owner-inbox] settling a question of a deleted session failed', { itemId: item.id, error: summarizeError(error) });
        }
      }
    },
  };
}
