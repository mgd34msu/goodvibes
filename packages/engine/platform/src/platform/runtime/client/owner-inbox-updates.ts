/**
 * owner-inbox-updates.ts, how an agent that left the owner a question hears the
 * answer.
 *
 * The `query` tool posts a question and the agent carries on. When the owner
 * answers (terminal, web UI, phone), the daemon publishes the item on
 * `owner-inbox-update`. {@link withAnswerDelivery} wraps the inbox the tool
 * posts to: while one of its questions is open it holds one subscription, and
 * when a question closes it hands the item to the host, which tells the asking
 * conversation on its next request. With nothing open there is no stream and
 * no request.
 */

import type { OwnerAnswerOutcome, OwnerInboxListFilter, OwnerItem } from '../../control-plane/owner-inbox.js';
import { readOwnerItem } from '../../control-plane/owner-inbox.js';
import type { QuestionInbox } from '../../tools/query/index.js';
import { openServerSentEventStream } from '../transports/sse-stream.js';
import { buildUrl } from '../transports/transport-paths.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

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

export interface AnswerDeliveryOptions {
  /** Opens the inbox update stream (or an in-process subscription). */
  readonly watch: OwnerInboxUpdateWatch;
  /** Hands a closed question to the conversation that asked it. */
  readonly deliver: (item: OwnerItem) => void;
  /**
   * The session a question belongs to when the caller did not say: a spawned
   * agent's questions belong to the conversation that spawned it.
   */
  readonly sessionId?: (() => string | undefined) | undefined;
}

/**
 * The inbox the `query` tool posts to, plus delivery of each answer to the
 * asking conversation. One subscription is held only while one of its
 * questions is open; it closes when the last one closes.
 */
export function withAnswerDelivery(inbox: QuestionInbox, options: AnswerDeliveryOptions): QuestionInbox {
  const pending = new Set<string>();
  let subscription: OwnerInboxUpdateSubscription | null = null;
  let opening: Promise<void> | null = null;

  const closeWhenIdle = (): void => {
    if (pending.size === 0) { subscription?.close(); subscription = null; }
  };

  const settle = (item: OwnerItem): void => {
    if (item.status === 'open' || !pending.delete(item.id)) return;
    try {
      options.deliver(item);
    } catch (error) {
      logger.debug('[owner-inbox] delivering an answer failed', { itemId: item.id, error: summarizeError(error) });
    }
    closeWhenIdle();
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

  return {
    async post(item) {
      const session = item.sessionId ?? sessionId();
      const outcome = await inbox.post(session ? { ...item, sessionId: session } : item);
      if (outcome.item.status === 'open') {
        pending.add(outcome.item.id);
        ensureWatching();
      }
      return outcome;
    },
    async find(id) {
      const item = await inbox.find(id);
      // The model read the answer itself; it is not told a second time.
      if (item && item.status !== 'open' && pending.delete(item.id)) closeWhenIdle();
      return item;
    },
    list(filter?: OwnerInboxListFilter) {
      const session = filter?.sessionId ?? sessionId();
      return inbox.list(session ? { ...filter, sessionId: session } : filter);
    },
    async withdraw(id, reason): Promise<OwnerAnswerOutcome> {
      if (pending.delete(id)) closeWhenIdle();
      return await inbox.withdraw(id, reason);
    },
  };
}
