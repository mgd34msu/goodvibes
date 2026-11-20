/**
 * push-client.ts, the browser half of Web Push.
 *
 * Ties the browser's PushManager to the daemon's push.* verbs (via the
 * src/lib/goodvibes.ts facade): read the public VAPID key, subscribe this
 * device with PushManager, register that subscription with the daemon, and the
 * reverse to unsubscribe. The capability URL + key material live in the browser
 * only long enough to hand to push.subscriptions.create; the daemon stores them
 * and never hands them back (it returns the redacted view).
 *
 * Every failure is a named PushSubscribeError.reason, never a silent false,
 * the settings UI renders each one honestly (insecure context → the HTTPS
 * pointer; denied → how to re-enable in browser settings; unsupported → plain).
 */

import { client as platformClient } from '../goodvibes';
import type { PublicPushSubscription, PushReconcileDrift } from '../goodvibes';
import { errorCode, formatError } from '../errors';
import { randomUuid } from '../uuid';
import { detectPushSupport, urlBase64ToUint8Array } from './push-support';

export type PushSubscribeFailure =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-registration'
  | 'subscribe-failed';

export class PushSubscribeError extends Error {
  readonly reason: PushSubscribeFailure;
  constructor(reason: PushSubscribeFailure, message: string) {
    super(message);
    this.name = 'PushSubscribeError';
    this.reason = reason;
  }
}

/**
 * Plain-language message for a push-subscription failure, shared by
 * NotificationSettings (the settings toggle) and PairingHandoffOffers (the
 * hand-off bundle's notifications offer), so the same failure reads the same
 * way regardless of which surface triggered it.
 */
export function describePushSubscribeError(error: unknown): string {
  if (error instanceof PushSubscribeError) {
    switch (error.reason) {
      case 'insecure-context':
        return 'Web Push needs a secure (HTTPS) connection. Open this app over HTTPS, for a home machine, `tailscale serve` fronts the daemon with an HTTPS hostname.';
      case 'permission-denied':
        return 'Notifications are blocked for this site. Re-enable them in your browser’s site settings, then try again.';
      case 'unsupported':
        return 'This browser does not support Web Push. On iOS, install the app to the Home Screen first (iOS 16.4+ delivers push only to an installed app).';
      case 'no-registration':
        return 'The service worker is not ready yet. Reload the page and try again.';
      default:
        return 'Could not complete the push subscription. Please try again.';
    }
  }
  return formatError(error);
}

/** The endpoint + key material extracted from a browser PushSubscription. */
export interface PushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

// The redacted daemon-side subscription id this device registered, kept so
// unsubscribe removes exactly this device's record (never every device the
// operator has, push.subscriptions.list is scoped to all of their devices).
const STORE_KEY = 'goodvibes.webui.push.subscriptionId';

function rememberSubscriptionId(id: string): void {
  try {
    window.localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage may be unavailable (private mode); non-fatal */
  }
}
function recallSubscriptionId(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}
function forgetSubscriptionId(): void {
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* non-fatal */
  }
}

// A stable per-install device identity (platform 1.8.0's deviceId), so a browser
// whose push endpoint rotates presents the SAME identity with a NEW endpoint,
// the daemon heals its one record in place (push.subscriptions.reconcile)
// instead of accumulating a stale duplicate. Generated once and persisted;
// unlike STORE_KEY (the daemon-assigned record id) this is minted client-side
// and never changes for the life of this browser profile. Exported (not just
// the constant, its NAME) so tests can seed/assert a specific device identity
// rather than depend on an unpredictable generated uuid.
export const PUSH_DEVICE_ID_STORAGE_KEY = 'goodvibes.webui.push.deviceId';
const DEVICE_ID_KEY = PUSH_DEVICE_ID_STORAGE_KEY;

export function ensureDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const minted = randomUuid();
    window.localStorage.setItem(DEVICE_ID_KEY, minted);
    return minted;
  } catch {
    // Storage unavailable (private mode): fall back to a per-call id. Reconcile
    // still functions this session; it just cannot recognize itself across a
    // reload, so a later reload registers as a distinct device.
    return randomUuid();
  }
}

/**
 * Pull the wire payload out of a browser PushSubscription's JSON. Pure and
 * browser-free so it is unit-testable; throws a named error when the browser
 * handed back a subscription missing its key material (never send a half one).
 */
export function extractSubscriptionPayload(json: PushSubscriptionJSON): PushSubscriptionPayload {
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new PushSubscribeError('subscribe-failed', 'The browser returned an incomplete push subscription.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new PushSubscribeError('unsupported', 'This browser has no service worker support.');
  }
  // serviceWorker.ready resolves once the SW controlling this page is active.
  return navigator.serviceWorker.ready;
}

/** True when this browser already has an active push subscription. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (detectPushSupport() !== 'ok') return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Prompt for notification permission if needed, then create (or reuse) a
 * PushManager subscription against the daemon's VAPID key and return the
 * extracted endpoint/keys. Pure browser-side work, does NOT register
 * anything with the daemon; callers decide how (subscribeToPush registers via
 * push.subscriptions.create, the pairing hand-off flow hands the same payload
 * to pairing.handoff.complete's notifications accept instead).
 */
export async function ensureBrowserPushSubscription(): Promise<PushSubscriptionPayload> {
  // Turning notifications on again replaces any turn-off that had not finished.
  clearRemovalPending();
  const support = detectPushSupport();
  if (support === 'insecure-context') {
    throw new PushSubscribeError('insecure-context', 'Web Push needs a secure (HTTPS) connection.');
  }
  if (support === 'unsupported') {
    throw new PushSubscribeError('unsupported', 'This browser does not support Web Push.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushSubscribeError('permission-denied', 'Notifications are blocked for this site.');
  }

  const registration = await ensureRegistration();

  // Reuse an existing browser subscription if one is already present; only mint
  // a new one against the daemon's VAPID key otherwise.
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const { publicKey } = await platformClient.operator.push.vapidKey();
    if (!publicKey) {
      throw new PushSubscribeError('subscribe-failed', 'The daemon returned no VAPID key.');
    }
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch {
      throw new PushSubscribeError('subscribe-failed', 'The browser refused to create a push subscription.');
    }
  }

  return extractSubscriptionPayload(subscription.toJSON());
}

/**
 * Subscribe this device: prompt for notification permission if needed, create
 * (or reuse) a PushManager subscription against the daemon's VAPID key, and
 * register it with the daemon. Returns the redacted daemon-side view.
 */
export async function subscribeToPush(): Promise<PublicPushSubscription> {
  const payload = await ensureBrowserPushSubscription();
  const { subscription: stored } = await platformClient.operator.push.subscribe({ ...payload, deviceId: ensureDeviceId() });
  rememberSubscriptionId(stored.id);
  return stored;
}

// Turning notifications off has two halves, the browser's subscription and the
// daemon's registration, and either can fail. The intent is kept here until both
// are done, so a half-finished removal is finished on the next open instead of
// being healed back into a registration (see reconcilePushSubscriptionOnOpen).
const REMOVAL_KEY = 'goodvibes.webui.push.removalPending';

function removalPending(): boolean {
  try {
    return window.localStorage.getItem(REMOVAL_KEY) !== null;
  } catch {
    return false;
  }
}
function markRemovalPending(): void {
  try {
    window.localStorage.setItem(REMOVAL_KEY, String(Date.now()));
  } catch {
    /* storage unavailable: the removal is attempted once, and any failure is reported */
  }
}
function clearRemovalPending(): void {
  try {
    window.localStorage.removeItem(REMOVAL_KEY);
  } catch {
    /* non-fatal */
  }
}

/** The daemon's registration for this browser: by the id remembered at subscribe time, else by device identity. */
function hostRecordFor(subscriptions: readonly PublicPushSubscription[]): PublicPushSubscription | null {
  const storedId = recallSubscriptionId();
  const deviceId = ensureDeviceId();
  return subscriptions.find((entry) => entry.id === storedId)
    ?? subscriptions.find((entry) => entry.deviceId === deviceId)
    ?? null;
}

/**
 * Unsubscribe this device: drop the browser PushManager subscription and remove
 * exactly this device's daemon-side registration (by the id remembered at
 * subscribe time, else by this browser's device identity), on every machine of
 * the daemon's group. Idempotent, safe to call when already unsubscribed.
 *
 * Nothing is swallowed: if the browser refuses to drop its subscription or the
 * daemon cannot be reached, the error propagates and the removal stays pending,
 * so the settings screen says it did not finish and the next open finishes it
 * rather than registering the device again.
 */
export async function unsubscribeFromPush(): Promise<void> {
  markRemovalPending();
  let browserFailure: unknown = null;
  if (detectPushSupport() === 'ok') {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription && !(await subscription.unsubscribe())) {
        browserFailure = new PushSubscribeError('subscribe-failed', 'The browser did not turn off its push subscription.');
      }
    } catch (error) {
      browserFailure = error;
    }
  }
  // The daemon half runs even when the browser half failed: the daemon stops
  // pushing either way, and a browser subscription with no registration
  // receives nothing.
  const { subscriptions } = await platformClient.operator.push.list();
  const host = hostRecordFor(subscriptions);
  if (host) {
    try {
      await platformClient.operator.push.unsubscribe(host.id);
    } catch (error) {
      // Already gone on the daemon: the goal state is reached for that half.
      if (errorCode(error) !== 'SUBSCRIPTION_NOT_FOUND') throw error;
    }
  }
  forgetSubscriptionId();
  if (browserFailure) {
    throw browserFailure instanceof Error ? browserFailure : new PushSubscribeError('subscribe-failed', 'The browser did not turn off its push subscription.');
  }
  clearRemovalPending();
}

/** What this browser and the daemon each hold for push, as the settings screen shows it. */
export interface PushRegistrationState {
  /** This browser has a live PushManager subscription. */
  readonly browserSubscribed: boolean;
  /** The daemon's registration for this browser, or null when it has none. */
  readonly registered: PublicPushSubscription | null;
  /** Turning notifications off was started and did not finish. */
  readonly removalPending: boolean;
}

/**
 * Read both halves: the browser's subscription and what the daemon has
 * registered for this device. A daemon that cannot be asked is an error for
 * the caller to show, never read as "registered".
 */
export async function readPushRegistrationState(): Promise<PushRegistrationState> {
  const browserSubscribed = (await currentSubscription()) !== null;
  const { subscriptions } = await platformClient.operator.push.list();
  return { browserSubscribed, registered: hostRecordFor(subscriptions), removalPending: removalPending() };
}

/** The outcome of a reconcile-on-open pass, for a caller that wants to react to it (e.g. a debug log). */
export interface PushReconcileOnOpenOutcome {
  /**
   * 'not-subscribed' when this browser holds no live PushManager subscription at
   * all, not an error; 'removal-finished' when a turn-off that had not finished
   * was finished instead of registering the device again.
   */
  readonly drift: PushReconcileDrift | 'not-subscribed' | 'removal-finished';
  readonly subscription: PublicPushSubscription | null;
}

/**
 * Reconcile-on-open: called once per connected+signed-in edge (see
 * usePushSubscriptionReconcile). Compares this browser's LIVE PushManager
 * subscription through the authenticated reconcile API. The daemon compares
 * its actual stored endpoint AND keys, heals in place, and avoids rewriting
 * an unchanged healthy record. No endpoint or key material is returned.
 *
 * This is the DURABLE convergence point for the self-heal story: a real
 * `pushsubscriptionchange` rotation (public/sw.js) re-subscribes the browser
 * side and best-effort notifies any already-open tab, but the browser can also
 * rotate the endpoint while this app is fully closed, with no tab to notify,
 * the next time the operator opens the app, this catches that drift by
 * comparing against the daemon's own record, which the SW alone cannot
 * authenticate to update. A closed-app rotation with no reconcile is a real gap
 * this function does not fully close (see public/sw.js's header), it converges
 * as soon as the app is next opened, which is the same "durable eventually,
 * not instantly" promise the rest of the self-heal story keeps.
 *
 * A missing/unreadable live subscription is not an error (never subscribed, or
 * the permission was revoked), it reports 'not-subscribed' and does nothing.
 */
export async function reconcilePushSubscriptionOnOpen(): Promise<PushReconcileOnOpenOutcome> {
  // The owner turned notifications off and it did not finish: finish it. A
  // registration is never healed back while a removal is pending.
  if (removalPending()) {
    await unsubscribeFromPush();
    return { drift: 'removal-finished', subscription: null };
  }
  if (detectPushSupport() !== 'ok') return { drift: 'not-subscribed', subscription: null };

  let subscription: PushSubscription | null;
  try {
    const registration = await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
  } catch {
    return { drift: 'not-subscribed', subscription: null };
  }
  if (!subscription) return { drift: 'not-subscribed', subscription: null };

  const deviceId = ensureDeviceId();
  const payload = extractSubscriptionPayload(subscription.toJSON());

  const { subscription: stored, drift } = await platformClient.operator.push.reconcile({ ...payload, deviceId });
  rememberSubscriptionId(stored.id);
  return { drift, subscription: stored };
}

/** Send a live test push to this device's registered subscription. */
export async function sendTestPush(): Promise<void> {
  const storedId = recallSubscriptionId() ?? hostRecordFor((await platformClient.operator.push.list()).subscriptions)?.id ?? null;
  if (!storedId) {
    throw new PushSubscribeError('no-registration', 'This device is not registered for push yet.');
  }
  await platformClient.operator.push.verify(storedId);
}
