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
  NotificationReplayResult,
} from '../../integrations/notification-dead-letters.js';
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
): Promise<NotificationReplayResult[]> {
  const settled = new Map<string, NotificationReplayResult>();
  for (const source of sources()) {
    for (const result of await source.replayDeadLetters(ids)) {
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
    const results = await replayNotificationDeadLetters(sources, ids as string[] | undefined);
    const count = (outcome: NotificationReplayResult['outcome']) => results.filter((result) => result.outcome === outcome).length;
    return {
      results,
      delivered: count('delivered'),
      retrying: count('retrying'),
      failed: count('dead_letter'),
      notFound: count('not-found'),
    };
  };
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
