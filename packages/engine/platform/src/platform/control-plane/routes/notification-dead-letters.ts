/**
 * notifications.deadLetters.* handlers over every notifier the host runs.
 *
 * Dead-letter ids are unique across notifiers (they name their channel), so a
 * replay hands each notifier the whole id list and an id is not-found only
 * when no notifier holds it.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type {
  NotificationDeadLetter,
  NotificationDeadLetterSource,
  NotificationReplayOptions,
  NotificationReplayResult,
} from '../../integrations/notification-dead-letters.js';
import type { NotificationDelivery } from '../../runtime/turn-notification.js';
import type { WebhookNotifierSendResult } from '../../integrations/webhooks.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The notifiers whose failed notifications are reachable, read at each call. */
export type NotificationDeadLetterSources = () => readonly NotificationDeadLetterSource[];

export function listNotificationDeadLetters(sources: NotificationDeadLetterSources, channel?: string): NotificationDeadLetter[] {
  return sources()
    .flatMap((source) => source.listDeadLetters())
    .filter((entry) => channel === undefined || entry.channel === channel)
    .sort((a, b) => a.deadAt - b.deadAt);
}

export async function replayNotificationDeadLetters(
  sources: NotificationDeadLetterSources,
  ids?: readonly string[],
  options: NotificationReplayOptions = {},
): Promise<NotificationReplayResult[]> {
  const settled = new Map<string, NotificationReplayResult>();
  for (const source of sources()) {
    for (const result of await source.replayDeadLetters(ids, options)) {
      const known = settled.get(result.id);
      if (!known || known.outcome === 'not-found') settled.set(result.id, result);
    }
  }
  for (const id of ids ?? []) {
    if (!settled.has(id)) settled.set(id, { id, outcome: 'not-found' });
  }
  return [...settled.values()];
}

export function createNotificationDeadLettersListHandler(sources: NotificationDeadLetterSources): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const channel = params['channel'];
    if (channel !== undefined && typeof channel !== 'string') {
      throw new GatewayVerbError('Invalid channel: expected slack, discord or webhook', 'INVALID_ARGUMENT', 400, 'channel');
    }
    const entries = listNotificationDeadLetters(sources, channel);
    return { entries, total: entries.length };
  };
}

export function createNotificationDeadLettersReplayHandler(sources: NotificationDeadLetterSources): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const ids = params['ids'];
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0))) {
      throw new GatewayVerbError('Invalid ids: expected a list of failed-notification ids from notifications.deadLetters.list', 'INVALID_ARGUMENT', 400, 'ids');
    }
    const toCurrent = params['toCurrent'];
    if (toCurrent !== undefined && typeof toCurrent !== 'boolean') {
      throw new GatewayVerbError('Invalid toCurrent: expected true or false', 'INVALID_ARGUMENT', 400, 'toCurrent');
    }
    const results = await replayNotificationDeadLetters(sources, ids as string[] | undefined, { toCurrent: toCurrent === true });
    const count = (outcome: NotificationReplayResult['outcome']) => results.filter((result) => result.outcome === outcome).length;
    return {
      results,
      delivered: count('delivered'),
      retrying: count('retrying'),
      failed: count('dead_letter'),
      notFound: count('not-found'),
      destinationChanged: count('destination-changed'),
    };
  };
}

/** The daemon's webhook notifier as `notifications.send` uses it: a typed notice queued, a text notice sent once. */
export interface ProgramNoticeNotifier {
  sendNotification(delivery: NotificationDelivery, event?: string): Promise<WebhookNotifierSendResult>;
  send(text: string): Promise<WebhookNotifierSendResult>;
}

/** The daemon's Slack and Discord notifier as `notifications.send` uses it: a typed notice queued to each channel. */
export interface ProgramNoticeChatNotifier {
  readonly channels: readonly string[];
  notifyNotification(delivery: NotificationDelivery, event?: string): Promise<void>;
}

/**
 * `notifications.send`: a terminal program's notice of its own event, sent to the daemon's one list of webhook
 * addresses and, for a typed notice, to the Slack and Discord channels the daemon posts notifications to; a typed
 * notice that fails every attempt lands in the daemon's failed list. No address is answered.
 */
export function createNotificationsSendHandler(
  notifier: ProgramNoticeNotifier,
  metadataOnly: () => boolean,
  chat: () => ProgramNoticeChatNotifier | undefined = () => undefined,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = params['kind'];
    const event = typeof params['event'] === 'string' && params['event'].trim() ? params['event'].trim().slice(0, 80) : 'notification';
    let result: WebhookNotifierSendResult;
    let chatOutcome: { attempted: number; failed: number } = { attempted: 0, failed: 0 };
    if (kind === 'text') {
      const text = params['text'];
      if (typeof text !== 'string' || text.trim().length === 0) throw new GatewayVerbError('A text notice needs its words in text.', 'INVALID_ARGUMENT', 400, 'text');
      result = await notifier.send(text);
    } else if (kind === 'turn' || kind === 'approval' || kind === 'budget') {
      const facts = params['facts'];
      if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) throw new GatewayVerbError('A notice needs its facts.', 'INVALID_ARGUMENT', 400, 'facts');
      try {
        result = await notifier.sendNotification({ kind, facts } as NotificationDelivery, event);
      } catch (error) {
        // Facts the notice cannot be worded from: the program's request is wrong, nothing was sent.
        if (error instanceof TypeError) throw new GatewayVerbError(`The ${kind} notice's facts could not be read, so nothing was sent.`, 'INVALID_ARGUMENT', 400, 'facts');
        throw error;
      }
      // The facts were worded above, so the same notice goes to Slack and Discord (a channel with nowhere to post is
      // not a channel); one that fails every attempt is in the daemon's failed list with the reason.
      const channels = chat();
      if (channels && channels.channels.length > 0) {
        chatOutcome = { attempted: channels.channels.length, failed: 0 };
        try { await channels.notifyNotification({ kind, facts } as NotificationDelivery, event); }
        catch (error) { chatOutcome.failed = error instanceof AggregateError ? error.errors.length : 1; }
      }
    } else {
      throw new GatewayVerbError('Invalid kind: expected turn, approval, budget or text.', 'INVALID_ARGUMENT', 400, 'kind');
    }
    return {
      attempted: result.attempted, delivered: result.delivered, failed: result.failed, textSent: !metadataOnly(),
      // Slack and Discord: how many channels it went to and how many did not take it (each failure is in the failed list).
      chat: chatOutcome,
      // Each address's outcome without the address (it carries its key).
      results: result.results.map((entry) => ({ ok: entry.ok, ...(entry.error ? { error: entry.error } : {}), ...(entry.status === undefined ? {} : { status: entry.status }), ...(entry.outcome ? { outcome: entry.outcome } : {}) })),
    };
  };
}

/** Attach `notifications.send` to its descriptor, over the daemon's webhook notifier and its Slack and Discord notifier. */
export function registerNotificationsSendGatewayMethod(
  catalog: GatewayMethodCatalog,
  notifier: ProgramNoticeNotifier,
  metadataOnly: () => boolean,
  chat?: () => ProgramNoticeChatNotifier | undefined,
): void {
  const descriptor = catalog.get('notifications.send');
  if (descriptor) catalog.register(descriptor, createNotificationsSendHandler(notifier, metadataOnly, chat), { replace: true });
}

/** Attach the notifications.deadLetters.* handlers to their descriptors. A missing descriptor is skipped. */
export function registerNotificationDeadLetterGatewayMethods(catalog: GatewayMethodCatalog, sources: NotificationDeadLetterSources): void {
  const handlers: Record<string, GatewayMethodHandler> = {
    'notifications.deadLetters.list': createNotificationDeadLettersListHandler(sources),
    'notifications.deadLetters.replay': createNotificationDeadLettersReplayHandler(sources),
  };
  for (const [id, handler] of Object.entries(handlers)) {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  }
}
