/**
 * push/delivery.ts
 *
 * The single place a push message is actually encrypted and sent. Every send,
 * a `push.subscriptions.verify` test, or an approval/completion fan-out, flows
 * through `deliverToSubscription`, so the honesty rules live in one spot:
 *
 *  - A push service that answers 404/410 means the browser subscription is gone;
 *    the record is removed and the receipt says `pruned`, never a fake success.
 *  - Any other non-2xx (or a transport error) is reported as `failed` with the
 *    status/reason, never swallowed into a success. Only the push service
 *    rejecting the endpoint itself (a 4xx other than 408, 413 and 429) counts
 *    toward removal; a network error, a timeout, a rate limit or a 5xx never
 *    does, so an outage cannot cost a device its subscription.
 *  - One fan-out stamps every device's outcome in one store write.
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
import type { AppliedPushOutcome, PushOutcomeStamp, PushSubscriptionStore } from './subscription-store.js';
import { logger } from '../utils/logger.js';
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
 * Answers that say nothing about the endpoint: the request timed out (408), the
 * message was too large (413), or the service is rate limiting (429). Like a
 * 5xx or a network error, they are reported but never counted toward removal.
 */
const UNPROVEN_STATUSES = new Set([408, 413, 429]);
/**
 * Consecutive push-service rejections of an endpoint after which it is removed
 * when the composition root supplies no bound (`push.subscriptions.failureThreshold`).
 */
export const DELIVERY_FAILURE_PRUNE_THRESHOLD = 5;

/**
 * How long one push request may take. A push service that never answers would
 * otherwise hold its slot in the fan-out and the `verify` caller forever; a
 * timeout is reported as `failed` and does not count against the device.
 */
export const DEFAULT_PUSH_REQUEST_TIMEOUT_MS = 10_000;
/** Subscriptions sent to at the same time in one fan-out. */
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
   * Consecutive push-service rejections after which the endpoint is removed.
   * Absent ⇒ {@link DELIVERY_FAILURE_PRUNE_THRESHOLD}. The composition root
   * wires it to `push.subscriptions.failureThreshold`, the same key the store's
   * read filter uses, so the two cannot disagree.
   */
  readonly failureThreshold?: number | undefined;
  /** Per-request time limit; absent means {@link DEFAULT_PUSH_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number | undefined;
  /** Told the daemon's own reason whenever a message could not be sent at all (key custody, the message itself). */
  readonly onNotSent?: ((reason: string) => void) | undefined;
  /** A fan-out's devices: only those of people who may be told what it is about (push/service.ts `PushAudience`). */
  readonly recipients?: ((subscription: StoredPushSubscription) => boolean) | undefined;
}

/** The effective bound: the configured value when sane, else the module default. */
function failureBound(deps: DeliveryDeps): number {
  const configured = deps.failureThreshold;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DELIVERY_FAILURE_PRUNE_THRESHOLD;
}

/** One send, before anything is written to the store. */
interface SendResult {
  readonly receipt: PushDeliveryReceipt;
  /** What the attempt proved about the endpoint; absent when nothing was sent. */
  readonly stamp?: PushOutcomeStamp | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Encrypt and send one message to one subscription. Writes nothing. */
async function send(
  subscription: StoredPushSubscription,
  message: PushMessage,
  deps: DeliveryDeps,
  lifetime: DeliveryLifetime,
): Promise<SendResult> {
  const origin = endpointOrigin(subscription.endpoint);
  const transport = deps.transport ?? defaultTransport();
  const base = { subscriptionId: subscription.id, endpointOrigin: origin };

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
      // sent. That says nothing about the device, so nothing is written.
      const reason = errorText(error);
      deps.onNotSent?.(reason);
      return {
        receipt: { ...base, outcome: 'failed', detail: `not sent: ${reason} (this is not counted against the device)` },
      };
    }
    // The request never got an answer from the push service (DNS, a refused
    // connection, the timeout): nothing is known about the endpoint.
    const detail = `delivery request failed: ${errorText(error)}`;
    return {
      receipt: { ...base, outcome: 'failed', detail: `${detail} (not counted against the device)` },
      stamp: { subscriptionId: subscription.id, endpoint: subscription.endpoint, evidence: 'unproven', detail },
    };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      receipt: { ...base, outcome: 'delivered', httpStatus },
      stamp: { subscriptionId: subscription.id, endpoint: subscription.endpoint, evidence: 'delivered', detail: `push service accepted it (${httpStatus})` },
    };
  }
  if (GONE_STATUSES.has(httpStatus)) {
    const detail = `push endpoint reported ${httpStatus} gone`;
    return {
      receipt: { ...base, outcome: 'pruned', httpStatus, detail: `${detail}; subscription removed` },
      stamp: { subscriptionId: subscription.id, endpoint: subscription.endpoint, evidence: 'gone', detail },
    };
  }
  const detail = `push service returned ${httpStatus}`;
  if (httpStatus >= 500 || httpStatus < 400 || UNPROVEN_STATUSES.has(httpStatus)) {
    return {
      receipt: { ...base, outcome: 'failed', httpStatus, detail: `${detail} (not counted against the device)` },
      stamp: { subscriptionId: subscription.id, endpoint: subscription.endpoint, evidence: 'unproven', detail },
    };
  }
  return {
    receipt: { ...base, outcome: 'failed', httpStatus, detail },
    stamp: { subscriptionId: subscription.id, endpoint: subscription.endpoint, evidence: 'rejected', detail },
  };
}

/** The receipt as the store's write left it: a rejection at the bound becomes `pruned`. */
function settle(result: SendResult, applied: ReadonlyMap<string, AppliedPushOutcome>, bound: number): PushDeliveryReceipt {
  const { receipt, stamp } = result;
  if (stamp && applied.get(stamp.subscriptionId)?.superseded) {
    // Not counted and not removed: the device has a new endpoint since.
    return {
      ...receipt,
      outcome: receipt.outcome === 'pruned' ? 'failed' : receipt.outcome,
      detail: `${stamp.detail}; the device registered a new endpoint meanwhile, so this answer about the old one was not applied to its subscription`,
    };
  }
  if (!stamp || stamp.evidence !== 'rejected') return receipt;
  const outcome = applied.get(stamp.subscriptionId);
  if (!outcome) return receipt;
  if (outcome.removed) {
    return {
      ...receipt,
      outcome: 'pruned',
      detail: `${stamp.detail}; removed after ${outcome.consecutiveFailures} consecutive rejections by the push service`,
    };
  }
  return { ...receipt, detail: `${stamp.detail} (rejection ${outcome.consecutiveFailures} of ${bound} before removal)` };
}

/**
 * Stamp every outcome in one store write and settle the receipts. A write that
 * fails leaves each receipt saying what the push service did, plus that the
 * outcome was not saved.
 */
async function record(results: readonly SendResult[], deps: DeliveryDeps): Promise<PushDeliveryReceipt[]> {
  const stamps = results.flatMap((result) => (result.stamp ? [result.stamp] : []));
  const bound = failureBound(deps);
  try {
    const applied = await deps.store.applyOutcomes(stamps, bound);
    return results.map((result) => settle(result, applied, bound));
  } catch (error) {
    const reason = errorText(error);
    logger.warn('Push delivery outcomes could not be saved', { devices: stamps.length, error: reason });
    return results.map((result) => (result.stamp
      ? { ...result.receipt, detail: `${result.receipt.detail ?? result.receipt.outcome}; the outcome could not be saved: ${reason}` }
      : result.receipt));
  }
}

/**
 * Encrypt and send one message to one subscription and return an honest
 * receipt. The subscription's outcome is stamped in the same call.
 */
export async function deliverToSubscription(
  subscription: StoredPushSubscription,
  message: PushMessage,
  deps: DeliveryDeps,
  lifetime: DeliveryLifetime = {},
): Promise<PushDeliveryReceipt> {
  const [receipt] = await record([await send(subscription, message, deps, lifetime)], deps);
  return receipt!;
}

/**
 * Fan one message out to every stored subscription, a few at a time so one
 * endpoint that never answers cannot hold back the rest, and stamp every
 * outcome in one store write. One receipt per subscription, in store order; an
 * empty list when there are no subscriptions at all. A revoked lifetime ends
 * the fan-out; the outcomes of the sends already made are still stamped.
 */
export async function deliverToAll(
  message: PushMessage,
  deps: DeliveryDeps,
  lifetime: DeliveryLifetime = {},
): Promise<PushDeliveryReceipt[]> {
  const recipients = deps.recipients;
  const subscriptions = recipients ? (await deps.store.all()).filter((subscription) => recipients(subscription)) : await deps.store.all();
  const results = new Array<SendResult>(subscriptions.length);
  // One device registered twice is still one device: send it the message once.
  const firstByEndpoint = new Map<string, number>();
  const work: number[] = [];
  subscriptions.forEach((subscription, index) => {
    if (firstByEndpoint.has(subscription.endpoint)) {
      results[index] = {
        receipt: {
          subscriptionId: subscription.id,
          endpointOrigin: endpointOrigin(subscription.endpoint),
          outcome: 'skipped',
          detail: 'another subscription for the same endpoint was sent this message',
        },
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
      try {
        results[index] = await send(subscriptions[index]!, message, deps, lifetime);
      } catch (error) {
        // Revocation, or a publication that owns failure handling, ends the fan-out.
        ended.error ??= { cause: error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAN_OUT_CONCURRENCY, work.length) }, worker));
  const finished = results.filter((result): result is SendResult => result !== undefined);
  const receipts = await record(finished, deps);
  if (ended.error) throw ended.error.cause;
  return receipts;
}
