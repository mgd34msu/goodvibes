/**
 * routes/push-composition.ts
 *
 * Builds the daemon's one `PushService`: VAPID key custody, the subscription
 * store, and the live config reads the delivery and escalation paths make per
 * event.
 *
 * Split out of register-gateway-verb-groups.ts so the composition root stays a
 * registration index rather than also being the place push policy is assembled.
 *
 * Every config read here is LIVE, evaluated per event or per write, never
 * captured at construction, so changing `push.*` or `notifications.push*`
 * takes effect without restarting the daemon. The exception is
 * `push.vapidSubject` (the VAPID manager is built with it once); a new value
 * applies from the next daemon start.
 */
import {
  DEFAULT_PUSH_ESCALATION,
  DEFAULT_PUSH_SUBSCRIPTION_POLICY,
  PushService,
  PushSubscriptionStore,
  VapidManager,
  isValidVapidSubject,
  type PushSubscriptionPolicy,
  type VapidSecretStore,
} from '../../push/index.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema.js';
import { logger } from '../../utils/logger.js';
import { controlPlaneStorePath } from '../control-plane-store-paths.js';
import type { AuthorityRecordFile } from '../../cluster/authority-record-file.js';

/** The slice of the gateway dependency bag push composition needs. */
export interface PushCompositionDeps {
  /** SecretsManager (get/set), VAPID keypair custody lives here, never in config. */
  readonly secretsManager: VapidSecretStore;
  /** Home-scoped path service; the subscription store file resolves under it. */
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
  /** Surface root the subscription store resolves under; required, never defaulted (control-plane-store-paths.ts). */
  readonly surfaceRoot: string;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  /** Explicit VAPID `sub` override; absent ⇒ the `push.vapidSubject` config key. */
  readonly vapidSubject?: string | undefined;
  /**
   * The daemon's receipt store: a reason the daemon itself cannot send pushes
   * (an unreadable key pair) is recorded there for the next attached surface.
   */
  readonly daemonReceipts?: { record(text: string): unknown } | undefined;
  /**
   * The authority record the registrations live on: a device registered, or
   * turned off, through any machine of the group is so on every machine.
   */
  readonly authority?: AuthorityRecordFile | undefined;
  /**
   * The sign-in users: a user deleted or no longer an admin loses the push
   * endpoints it registered (pushes of approvals and questions are for admins).
   */
  readonly users?: { onAdminWithdrawn(listener: (username: string) => void): () => void } | undefined;
}

function readNumber(deps: PushCompositionDeps, key: ConfigKey, fallback: number): number {
  const value = deps.configManager?.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The consecutive-rejection bound both the store's read filter and the delivery
 * path remove on. One reading of the config key for both, so a hand-edited 0 or
 * negative value cannot make the store treat every subscription (with zero
 * failures) as dead while delivery falls back to its default.
 */
export function resolveFailureThreshold(deps: PushCompositionDeps): number {
  const value = readNumber(deps, 'push.subscriptions.failureThreshold', DEFAULT_PUSH_SUBSCRIPTION_POLICY.failureThreshold);
  return value >= 1 ? Math.floor(value) : DEFAULT_PUSH_SUBSCRIPTION_POLICY.failureThreshold;
}

/**
 * The VAPID JWT `sub`, the contact a push service uses to report a delivery
 * problem. Explicit dep first (embedders), then the `push.vapidSubject` config
 * key, then the documented localhost fallback inside VapidManager. A configured
 * value that is not a mailto:/https: contact is refused by the config gate; if
 * one reaches here anyway (a hand-edited config file), it is reported and
 * dropped rather than signed into every JWT or crashing construction.
 */
export function resolveVapidSubject(deps: PushCompositionDeps): string | undefined {
  const explicit = deps.vapidSubject?.trim();
  if (explicit) return explicit;
  const configured = deps.configManager?.get('push.vapidSubject');
  const subject = typeof configured === 'string' ? configured.trim() : '';
  if (subject.length === 0) return undefined;
  if (!isValidVapidSubject(subject)) {
    logger.warn('push.vapidSubject is not a mailto:/https: contact; falling back to the built-in subject', {
      configured: subject,
    });
    return undefined;
  }
  return subject;
}

/**
 * The subscription store. Dead records are left out of every read and dropped
 * by the next write, so it needs no timer.
 *
 * `warnAbovePerPrincipal` is a WARNING line, never a cap: nothing that still
 * works is ever removed to make room (see push/subscription-housekeeping.ts).
 */
export function createPushSubscriptionStore(deps: PushCompositionDeps): PushSubscriptionStore {
  const policy = (): PushSubscriptionPolicy => ({
    warnAbovePerPrincipal: readNumber(
      deps,
      'push.subscriptions.warnAbovePerPrincipal',
      DEFAULT_PUSH_SUBSCRIPTION_POLICY.warnAbovePerPrincipal,
    ),
    failureThreshold: resolveFailureThreshold(deps),
  });
  return new PushSubscriptionStore(
    controlPlaneStorePath(deps.shellPaths, deps.surfaceRoot, 'push-subscriptions.json'),
    { policy, ...(deps.authority ? { authority: deps.authority } : {}) },
  );
}

/** The daemon's one PushService, with every policy read wired live to config. */
export function createPushService(deps: PushCompositionDeps): PushService {
  const store = createPushSubscriptionStore(deps);
  return new PushService({
    vapid: new VapidManager(deps.secretsManager, { subject: resolveVapidSubject(deps) }),
    store,
    receipts: deps.daemonReceipts,
    users: deps.users,
    // The rejection bound the delivery path removes on, read live from the same
    // config key the store's read filter uses so the two cannot disagree about
    // when a push service has proved an endpoint dead.
    failureThreshold: () => resolveFailureThreshold(deps),
    // Per-class silencing toggles (notifications.push*), read live per event.
    // Every class defaults ON, the toggles only ever turn a class OFF.
    isCategoryEnabled: (category) => {
      const key = category === 'approval'
        ? 'notifications.pushApproval'
        : category === 'needs-input'
          ? 'notifications.pushNeedsInput'
          : 'notifications.pushCompletion';
      return deps.configManager?.get(key) !== false;
    },
    // Blocked-too-long escalation policy, read LIVE at each block so a config
    // change takes effect for the next block without a restart. An escalated
    // push fires regardless of an attached surface once the grace elapses.
    escalation: () => ({
      blockedGraceMs: readNumber(deps, 'notifications.blockedEscalationGraceMs', DEFAULT_PUSH_ESCALATION.blockedGraceMs),
      followUpIntervalMs: readNumber(deps, 'notifications.blockedEscalationFollowUpMs', DEFAULT_PUSH_ESCALATION.followUpIntervalMs),
      maxFollowUps: readNumber(deps, 'notifications.blockedEscalationMaxFollowUps', DEFAULT_PUSH_ESCALATION.maxFollowUps),
    }),
  });
}
