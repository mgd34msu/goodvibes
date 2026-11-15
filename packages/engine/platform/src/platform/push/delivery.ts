/**
 * push/delivery.ts
 *
 * The single place a push message is actually encrypted and sent. Every send,
 * a `push.subscriptions.verify` test, or an approval/completion fan-out, flows
 * through `deliverToSubscription`, so the honesty rules live in one spot:
 *
 *  - A push service that answers 404/410 means the browser subscription is gone;
 *    the record is pruned and the receipt says `pruned`, never a fake success.
 *  - Any other non-2xx (or a transport error) is reported as `failed` with the
 *    status/reason, never swallowed into a success.
 *  - The request carries the RFC 8188 `Content-Encoding: aes128gcm` body plus
 *    the `TTL`, `Urgency`, and VAPID `Authorization` headers a push service
 *    requires.
 *
 * The endpoint is whatever the browser registered. In tests that is a local
 * HTTP sink; in production it is the browser vendor's push service. This module
 * never contacts a hard-coded external service of its own.
 */

import { encryptPushPayload, PUSH_MAX_PLAINTEXT_BYTES } from './encryption.js';
import { localPushEndpointsAllowed } from './subscription-validation.js';
import { assertDeliveryCurrent, runDeliveryPublication, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import type { VapidManager } from './vapid.js';
import type { PushSubscriptionStore } from './subscription-store.js';
import type {
  PushDeliveryReceipt,
  PushMessage,
  StoredPushSubscription,
} from './types.js';

/** The `fetch` slice used to POST an encrypted payload. Injectable for tests. */
export type PushTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer; signal?: AbortSignal | undefined },
) => Promise<{ status: number }>;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const GONE_STATUSES = new Set([404, 410]);
/**
 * Bounded retries before a dead endpoint that never answers 404/410 is pruned.
 * A push service that keeps returning 5xx/timeouts is treated as gone once the
 * consecutive-failure counter crosses this bound, reported as an honest `pruned`
 * receipt rather than an endless string of `failed`s.
 */
export const DELIVERY_FAILURE_PRUNE_THRESHOLD = 5;

/** How long one push request may take before it counts as a failed delivery. */
export const DEFAULT_PUSH_REQUEST_TIMEOUT_MS = 10_000;
/** Subscriptions delivered to at the same time in one fan-out. */
const FAN_OUT_CONCURRENCY = 4;

/**
 * The production transport. The endpoint is a URL a remote device chose, so the
 * request goes only to a public address that was checked after DNS resolution
 * and is not redirected anywhere else; the daemon's own network is not
 * reachable through it. A deployment that opted into local endpoints (a
 * development relay) gets a plain request that still never follows a redirect.
 */
function defaultTransport(): PushTransport {
  return async (url, init) => {
    // Re-wrap over a plain ArrayBuffer so the body matches fetch's BodyInit.
    const request = {
      method: init.method,
      headers: init.headers,
      body: new Uint8Array(init.body),
      ...(init.signal ? { signal: init.signal } : {}),
    };
    const res = localPushEndpointsAllowed()
      ? await fetch(url, { ...request, redirect: 'manual' })
      : await (await import('../utils/url-safety.js')).postToPublicWebhook(url, request, init.signal ? { signal: init.signal } : {});
    return { status: res.status };
  };
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'invalid';
  }
}

const TRUNCATION_MARK = '...';
const MAX_TITLE_CHARACTERS = 200;

/**
 * The notification as sent. A title or body that would not fit one push is cut
 * and marked, because a long approval summary must still reach the person; the
 * structured `data` is never cut.
 */
function messagePlaintext(message: PushMessage): Buffer {
  const data = message.data ?? {};
  const encode = (title: string, body: string): Buffer => Buffer.from(JSON.stringify({ title, body, data }), 'utf8');
  const title = message.title.length > MAX_TITLE_CHARACTERS
    ? `${message.title.slice(0, MAX_TITLE_CHARACTERS - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
    : message.title;
  let body = message.body;
  let plaintext = encode(title, body);
  while (plaintext.length > PUSH_MAX_PLAINTEXT_BYTES && body.length > 0) {
    // Escaping can make a character cost several bytes, so shrink by the excess and re-measure.
    const keep = Math.max(0, body.length - (plaintext.length - PUSH_MAX_PLAINTEXT_BYTES) - TRUNCATION_MARK.length);
    body = keep === 0 ? '' : `${body.slice(0, keep)}${TRUNCATION_MARK}`;
    plaintext = encode(title, body);
  }
  return plaintext;
}

export interface DeliveryDeps {
  readonly vapid: VapidManager;
  readonly store: PushSubscriptionStore;
  readonly transport?: PushTransport | undefined;
  /**
   * Consecutive refused deliveries after which the endpoint is treated as dead.
   * Absent ⇒ {@link DELIVERY_FAILURE_PRUNE_THRESHOLD}. The composition root
   * wires it to `push.subscriptions.failureThreshold`, the same key the
   * subscription sweep reads, so delivery and housekeeping cannot disagree
   * about when a push service has proved an endpoint gone.
   */
  readonly failureThreshold?: number | undefined;
  /** Per-request time limit; absent means {@link DEFAULT_PUSH_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number | undefined;
}

/** The effective bound: the configured value when sane, else the module default. */
function failureBound(deps: DeliveryDeps): number {
  const configured = deps.failureThreshold;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DELIVERY_FAILURE_PRUNE_THRESHOLD;
}

/**
 * Encrypt and send one message to one subscription, prune-on-gone, and return
 * an honest receipt. The subscription's `lastOutcome` is stamped either way.
 */
export async function deliverToSubscription(
  subscription: StoredPushSubscription,
  message: PushMessage,
  deps: DeliveryDeps,
  lifetime: DeliveryLifetime = {},
): Promise<PushDeliveryReceipt> {
  const origin = endpointOrigin(subscription.endpoint);
  const transport = deps.transport ?? defaultTransport();

  let httpStatus: number;
  let dispatched = false;
  try {
    assertDeliveryCurrent(lifetime);
    const encrypted = encryptPushPayload(subscription.keys, messagePlaintext(message));
    const authorization = await deps.vapid.buildAuthorizationHeader(subscription.endpoint);
    const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_PUSH_REQUEST_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = lifetime.signal ? AbortSignal.any([lifetime.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      'content-encoding': encrypted.contentEncoding,
      'content-type': 'application/octet-stream',
      ttl: String(message.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      urgency: message.urgency ?? 'normal',
      authorization,
    };
    const result = await runDeliveryPublication(lifetime, () => {
      dispatched = true;
      return transport(subscription.endpoint, {
        method: 'POST', headers, body: encrypted.body, signal,
      });
    });
    httpStatus = result.status;
  } catch (error) {
    // Revocation before dispatch is not evidence that the endpoint failed.
    if (!dispatched) {
      assertDeliveryCurrent(lifetime);
      if (lifetime.withPublication) throw error;
      // The message or the daemon's own key custody failed before anything was
      // sent. That says nothing about the device, so it is reported but never
      // counted toward pruning a healthy subscription.
      return {
        subscriptionId: subscription.id,
        endpointOrigin: origin,
        outcome: 'failed',
        detail: `not sent: ${error instanceof Error ? error.message : String(error)} (this is not counted against the device)`,
      };
    }
    const failures = await deps.store.recordOutcome(subscription.id, 'failed');
    const reason = `delivery request failed: ${error instanceof Error ? error.message : String(error)}`;
    return prunedOrFailed(subscription, origin, deps, failures, reason);
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    await deps.store.recordOutcome(subscription.id, 'delivered');
    return { subscriptionId: subscription.id, endpointOrigin: origin, outcome: 'delivered', httpStatus };
  }

  if (GONE_STATUSES.has(httpStatus)) {
    // The subscription is gone at the push service, prune it (delete means
    // delete) and report the prune with the status that proved it dead.
    await deps.store.remove(subscription.id);
    return {
      subscriptionId: subscription.id,
      endpointOrigin: origin,
      outcome: 'pruned',
      httpStatus,
      detail: `push endpoint reported ${httpStatus} gone; subscription removed`,
    };
  }

  const failures = await deps.store.recordOutcome(subscription.id, 'failed');
  return prunedOrFailed(subscription, origin, deps, failures, `push service returned ${httpStatus}`, httpStatus);
}

/**
 * A non-gone delivery failure: report `failed` while the bounded retries remain,
 * but once the consecutive-failure counter crosses the threshold, prune the
 * dead endpoint (delete means delete) and report an honest `pruned` receipt.
 */
async function prunedOrFailed(
  subscription: StoredPushSubscription,
  origin: string,
  deps: DeliveryDeps,
  failures: number,
  reason: string,
  httpStatus?: number,
): Promise<PushDeliveryReceipt> {
  const bound = failureBound(deps);
  if (failures >= bound) {
    await deps.store.remove(subscription.id);
    return {
      subscriptionId: subscription.id,
      endpointOrigin: origin,
      outcome: 'pruned',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      detail: `${reason}; pruned after ${failures} consecutive delivery failures`,
    };
  }
  return {
    subscriptionId: subscription.id,
    endpointOrigin: origin,
    outcome: 'failed',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    detail: `${reason} (failure ${failures} of ${bound} before prune)`,
  };
}

/**
 * Fan one message out to every stored subscription, a few at a time so one
 * endpoint that never answers cannot hold back the rest. Returns one receipt
 * per subscription, in store order, an empty array when there are no
 * subscriptions at all (the honest "nobody to notify" result, not a silent
 * success). A bookkeeping failure on one subscription becomes that
 * subscription's `failed` receipt; it never loses the other receipts. A revoked
 * lifetime still ends the whole fan-out.
 */
export async function deliverToAll(
  message: PushMessage,
  deps: DeliveryDeps,
  lifetime: DeliveryLifetime = {},
): Promise<PushDeliveryReceipt[]> {
  const subscriptions = await deps.store.all();
  const receipts = new Array<PushDeliveryReceipt>(subscriptions.length);
  // One device registered twice is still one device: send it the message once.
  const firstByEndpoint = new Map<string, number>();
  const work: number[] = [];
  subscriptions.forEach((subscription, index) => {
    if (firstByEndpoint.has(subscription.endpoint)) {
      receipts[index] = {
        subscriptionId: subscription.id,
        endpointOrigin: endpointOrigin(subscription.endpoint),
        outcome: 'skipped',
        detail: 'another subscription for the same endpoint was sent this message',
      };
      return;
    }
    firstByEndpoint.set(subscription.endpoint, index);
    work.push(index);
  });

  let next = 0;
  // Held in an object so the checks below see changes made by the workers.
  const ended: { error?: { readonly cause: unknown } } = {};
  const worker = async (): Promise<void> => {
    while (ended.error === undefined && next < work.length) {
      const index = work[next++]!;
      const subscription = subscriptions[index]!;
      try {
        receipts[index] = await deliverToSubscription(subscription, message, deps, lifetime);
      } catch (error) {
        try {
          // Revocation, or a publication that owns failure handling, ends the fan-out.
          assertDeliveryCurrent(lifetime);
          if (lifetime.withPublication) throw error;
        } catch (ending) {
          ended.error ??= { cause: ending };
          return;
        }
        receipts[index] = {
          subscriptionId: subscription.id,
          endpointOrigin: endpointOrigin(subscription.endpoint),
          outcome: 'failed',
          detail: `delivery could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAN_OUT_CONCURRENCY, work.length) }, worker));
  if (ended.error) throw ended.error.cause;
  return receipts;
}
