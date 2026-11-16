/**
 * Notification dispatch: routes domain notifications into the shared feed.
 *
 * The platform's NotificationRouter decides where each domain notification goes
 * (conversation / status_bar / panel_only) and collapses bursts and batches.
 * This module builds the router, records every routed notification (whatever
 * its target, including burst-collapsed and held ones) into the shared feed, and
 * bridges the runtime event bus so real domain events become notifications. The
 * feed is the one consumer of every target: each decision is one history entry,
 * and a warning or critical one also shows as a toast. The feed folds a
 * notification and the conversation notice restating the same runtime event
 * (same event key) into one entry.
 */

import { randomUUID } from 'node:crypto';
import { createNotificationRouter, type NotificationRouter } from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import type { Notification, RoutingDecision, RuntimeEventBus, RuntimeEventDomain } from '@/runtime/index.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { getSharedNotificationFeed, type NotificationFeed } from '../views/notifications-feed.ts';
import { publishNotice, type NoticeSink } from '../core/notices.ts';
import { memoryPressureLine, memoryPressureLevel, type MemoryPressurePayload } from '@goodvibes-jev/engine/platform/platform/runtime/memory';
import { runtimeEventKey } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';

export interface NotificationDispatcher {
  /**
   * Route a notification; every decision lands in the feed (warning and
   * critical ones also toast). `eventKey` names the runtime event it came from (the platform's
   * runtimeEventKey), so the feed keeps one entry when the same event also
   * arrives as a conversation notice. Returns the decision.
   */
  dispatch(notification: Notification, eventKey?: string): RoutingDecision;
  /** Surface batch-held notifications (call on a timer / when quiet-typing ends). */
  flush(): void;
  /**
   * Whether the person is typing right now and the print level allows holding
   * routine notifications meanwhile. Read at each notification; a held one
   * goes to the history, where it can be read once typing stops.
   */
  setTypingProbe(probe: () => boolean): void;
  readonly router: NotificationRouter;
}

/**
 * The runtime event domains whose events surface as operational notifications.
 * Deliberately a curated set of user-relevant, completion/attention-shaped
 * domains, not every domain, so the notifications modal reflects meaningful operational
 * activity rather than raw event churn. The router's per-domain verbosity and
 * burst/batch policies still collapse floods within these.
 */
export const NOTIFICATION_BRIDGE_DOMAINS: readonly RuntimeEventDomain[] = [
  'agents',
  'tasks',
  'contracts',
  'automation',
  'deliveries',
  'security',
];

/** A runtime event a person reads in the notification history: its plain title and severity. */
export interface PersonFacingEvent {
  readonly title: string;
  readonly level: Notification['level'];
}

/**
 * The runtime events that become notification-history entries, by event type,
 * with the plain title each one shows. Everything else on the bridged domains
 * (stream deltas, progress ticks, gate results, state changes, queue and start
 * events) is internal traffic and never enters the history: this table is an
 * allowlist, so a new platform event type stays out until someone names it here.
 */
export const PERSON_FACING_EVENTS: Readonly<Record<string, PersonFacingEvent>> = {
  // agents
  AGENT_COMPLETED: { title: 'Agent finished', level: 'info' },
  AGENT_FAILED: { title: 'Agent failed', level: 'warning' },
  AGENT_CANCELLED: { title: 'Agent cancelled', level: 'info' },
  AGENT_AWAITING_MESSAGE: { title: 'Agent is waiting for a reply', level: 'info' },
  // tasks
  TASK_COMPLETED: { title: 'Task finished', level: 'info' },
  TASK_FAILED: { title: 'Task failed', level: 'warning' },
  TASK_BLOCKED: { title: 'Task blocked', level: 'warning' },
  TASK_CANCELLED: { title: 'Task cancelled', level: 'info' },
  // contracts: cancellation and commit outcomes are distinct lifecycle facts.
  CONTRACT_PASSED: { title: 'Workstream passed', level: 'info' },
  CONTRACT_FAILED: { title: 'Workstream failed', level: 'warning' },
  CONTRACT_CANCELLED: { title: 'Workstream cancelled', level: 'info' },
  CONTRACT_COMMITTED: { title: 'Workstream commit updated', level: 'info' },
  CONTRACT_CRITERION_REGRESSED: { title: 'Requirement regressed', level: 'warning' },
  // automation (scheduled jobs)
  AUTOMATION_RUN_COMPLETED: { title: 'Scheduled job finished', level: 'info' },
  AUTOMATION_RUN_FAILED: { title: 'Scheduled job failed', level: 'warning' },
  AUTOMATION_JOB_AUTO_DISABLED: { title: 'Scheduled job turned off after repeated failures', level: 'warning' },
  // deliveries (outgoing channel messages)
  DELIVERY_FAILED: { title: 'Message delivery failed', level: 'warning' },
  DELIVERY_DEAD_LETTERED: { title: 'Message could not be delivered', level: 'warning' },
  // security
  AUTH_FAILED: { title: 'Sign-in failed', level: 'warning' },
  COMPANION_PAIR_REQUESTED: { title: 'Device pairing requested', level: 'info' },
  COMPANION_PAIR_VERIFIED: { title: 'Device paired', level: 'info' },
  COMPANION_TOKEN_REVOKED: { title: 'Device access revoked', level: 'info' },
  TOKEN_ROTATION_WARNING: { title: 'Access token expires soon', level: 'warning' },
  TOKEN_ROTATION_EXPIRED: { title: 'Access token expired', level: 'warning' },
  TOKEN_BLOCKED: { title: 'Access token blocked', level: 'warning' },
  TOKEN_SCOPE_VIOLATION: { title: 'Request refused: outside the token\'s permissions', level: 'warning' },
};

/** The history entry an event type makes, or undefined for internal traffic that is not recorded. */
export function personFacingEvent(type: string, payload?: unknown): PersonFacingEvent | undefined {
  if (type === 'CONTRACT_COMMITTED' && payload && typeof payload === 'object') {
    // This event reports all four commit results. Prose such as "committed"
    // in a note cannot turn a skipped or failed result into a success.
    switch ('status' in payload ? payload.status : undefined) {
      case 'committed': return { title: 'Changes committed', level: 'info' };
      case 'applied': return { title: 'Changes applied', level: 'info' };
      case 'skipped': return { title: 'Commit skipped', level: 'info' };
      case 'failed': return { title: 'Commit failed', level: 'warning' };
      default: return undefined;
    }
  }
  return Object.prototype.hasOwnProperty.call(PERSON_FACING_EVENTS, type) ? PERSON_FACING_EVENTS[type] : undefined;
}

/** The detail line an event payload carries (an error or cancel reason, a chain's landing outcome, or the commit it made), if any. */
export function eventDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  // `note`: a passed review chain's landing outcome (committed, or why not, e.g. a refusing commit hook).
  for (const field of ['error', 'reason', 'note']) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const commit = record['hash'] ?? record['commitHash'];
  if (typeof commit === 'string' && commit.trim()) return `commit ${commit.trim().slice(0, 7)}`;
  return undefined;
}

export function createNotificationDispatcher(
  configManager: Pick<ConfigManager, 'get'>,
  feed: NotificationFeed = getSharedNotificationFeed(),
): NotificationDispatcher {
  const router = createNotificationRouter(undefined, undefined, configManager);
  /** Event keys of notifications the router is holding in a batch, for when the batch is flushed. */
  const heldEventKeys = new WeakMap<Notification, string>();
  /** Notifications already in the feed, so a periodic flush does not count a batch head twice. */
  const recorded = new WeakSet<Notification>();
  let typing: () => boolean = () => false;
  const recordInFeed = (notification: Notification, decision: RoutingDecision, eventKey: string | undefined): void => {
    // A notification held back from the screen (quiet while typing, a quiet
    // mode) is still something that happened: it goes to the history, where it
    // can be read later, rather than being dropped. Nothing flushes the held
    // ones, so this is the only place they would ever surface. conversation
    // and status_bar decisions have no other consumer in the terminal: the feed entry is what shows them (a toast at warning and
    // critical) and keeps them. The feed keeps only panel-bound entries, so
    // every decision is handed to it as one, with its reason and batch key.
    feed.record(notification, decision.target === 'panel_only' ? decision : { ...decision, target: 'panel_only' }, eventKey);
    recorded.add(notification);
  };
  return {
    router,
    setTypingProbe(probe) {
      typing = probe;
    },
    dispatch(notification, eventKey) {
      router.setQuietWhileTyping(typing());
      const decision = router.route(notification);
      if (eventKey) heldEventKeys.set(notification, eventKey);
      recordInFeed(notification, decision, eventKey);
      return decision;
    },
    flush() {
      for (const { notification } of router.flush()) {
        if (recorded.has(notification)) continue;
        // A flushed batch head surfaces as a batch-collapsed feed entry; the
        // feed folds all sharing this batch key into one running-count row.
        feed.record(notification, {
          target: 'panel_only',
          reasonCode: 'batch_window_collapsed',
          batchKey: `${notification.domain}:${notification.level}`,
        }, heldEventKeys.get(notification));
      }
    },
  };
}

/** How often held batch notifications are surfaced: the router's batch window. */
export const NOTIFICATION_FLUSH_INTERVAL_MS = 2_000;

/** The timer functions the flush loop uses; injectable so a test can drive ticks. */
export interface NotificationFlushScheduler {
  readonly setInterval: (handler: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const SYSTEM_SCHEDULER: NotificationFlushScheduler = {
  setInterval: (handler, ms) => {
    const handle = setInterval(handler, ms);
    // A pending flush must not keep the process alive.
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Surface batch-held notifications on a timer: the router queues a collapsed
 * burst until flushed, and nothing else flushes it, so the "N more" row would
 * never appear. Returns a function that stops the timer.
 */
export function startNotificationFlush(
  dispatcher: Pick<NotificationDispatcher, 'flush'>,
  scheduler: NotificationFlushScheduler = SYSTEM_SCHEDULER,
  intervalMs: number = NOTIFICATION_FLUSH_INTERVAL_MS,
): () => void {
  const handle = scheduler.setInterval(() => dispatcher.flush(), intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    scheduler.clearInterval(handle);
  };
}

/**
 * Bridge OPS_MEMORY_PRESSURE specifically into the notification feed as an
 * attention line. The MemoryGovernor emits this on the 'ops' domain when the
 * pressure tier changes or the leak tripwire fires; that domain also carries
 * high-churn audit/metric events, so it is deliberately NOT in
 * NOTIFICATION_BRIDGE_DOMAINS, this targeted bridge lifts only the
 * memory-pressure event into notices (critical at the critical tier / on a
 * tripwire, warning at high), leaving the rest of the ops churn out of the
 * feed. Returns an unsubscribe function.
 */
export function wireMemoryPressureNotice(
  runtimeBus: RuntimeEventBus,
  dispatcher: Pick<NotificationDispatcher, 'dispatch'>,
): () => void {
  return runtimeBus.onDomain('ops', (envelope) => {
    if (envelope.type !== 'OPS_MEMORY_PRESSURE') return;
    const payload = envelope.payload as MemoryPressurePayload;
    dispatcher.dispatch({
      id: randomUUID(),
      domain: 'ops',
      level: memoryPressureLevel(payload),
      title: memoryPressureLine(payload),
      timestamp: envelope.ts,
    }, runtimeEventKey(envelope.type, payload));
  });
}

/**
 * Bridge the runtime event bus to the dispatcher: each person-facing event
 * (PERSON_FACING_EVENTS) in a curated domain becomes a notification with its
 * plain title and is routed. Internal events are not recorded at all. Returns
 * an unsubscribe function that detaches every domain listener.
 */
export function wireRuntimeNotificationBridge(
  runtimeBus: RuntimeEventBus,
  dispatcher: Pick<NotificationDispatcher, 'dispatch'>,
  domains: readonly RuntimeEventDomain[] = NOTIFICATION_BRIDGE_DOMAINS,
): () => void {
  const unsubscribes = domains.map((domain) =>
    runtimeBus.onDomain(domain, (envelope) => {
      const event = personFacingEvent(envelope.type, envelope.payload);
      if (!event) return;
      const body = eventDetail(envelope.payload);
      // Notification.id identifies this delivery only. A trace and timestamp
      // can be shared by distinct outcomes. Only producer-declared occurrence
      // provenance is a cross-path key. Legacy keyless deliveries stay visible.
      dispatcher.dispatch({
        id: randomUUID(),
        domain,
        ...(domain === 'contracts' ? { panelId: 'agents' } : {}),
        level: event.level,
        title: event.title,
        ...(body ? { body } : {}),
        timestamp: envelope.ts,
      }, runtimeEventKey(envelope.type, envelope.payload));
    }),
  );
  return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
}

/** The shell's conversation notice sink: every system notice is a toast and a history entry (core/notices.ts). */
export function createShellNoticeSink(feed: NotificationFeed = getSharedNotificationFeed()): NoticeSink {
  return async (content, options) => { await publishNotice(feed, content, options); };
}
