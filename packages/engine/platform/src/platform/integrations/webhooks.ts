import { deliveryHttpStatus, describeStructuralDeliveryError } from './delivery-diagnostics.js';
import { NotificationEnvelope, type NotificationPrivacyReader } from '../runtime/notification-envelope.js';
import type { NotificationDelivery } from '../runtime/turn-notification.js';
import { logger } from '../utils/logger.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { classifyHostTrustTier, extractHostname, emitSsrfDeny } from '../tools/fetch/trust-tiers.js';
import { sanitizeUrlForLog } from '../utils/fetch-with-timeout.js';
import { postToPublicWebhook } from '../utils/url-safety.js';
import { isNotifySuppressed } from '../utils/notify.js';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { assertDeliveryCurrent, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { DeliveryError, DeliveryQueue, type DeliveryOutcome, type DeliveryQueueConfig } from './delivery.js';
import { attachRuntimeNotifications, type RuntimeNotificationOptions } from './notification-dispatcher.js';
import {
  describeDeadLetters, notificationDeadLetterCodec,
  type NotificationDeadLetter, type NotificationDeadLetterSource, type NotificationReplayResult,
} from './notification-dead-letters.js';
import type { ConfigManager } from '../config/manager.js';

const WEBHOOK_POLICY_ERRORS = {
  blocked: 'WebhookNotifier: blocked URL',
  closed: 'WebhookNotifier: closed',
  suppressed: 'WebhookNotifier: delivery suppressed under test (pass { force: true } to enable)',
  privacy: 'Notification privacy changed before delivery',
} as const;
class WebhookPolicyError extends Error {
  /** A refusal by policy is not cleared by sending again. */
  readonly retryable = false;
  constructor(readonly kind: keyof typeof WEBHOOK_POLICY_ERRORS) {
    super(WEBHOOK_POLICY_ERRORS[kind]);
    Object.freeze(this);
  }
}
function describeWebhookError(error: unknown): string {
  try {
    if (error instanceof WebhookPolicyError) {
      const kind = error.kind;
      if (kind === 'blocked' || kind === 'suppressed' || kind === 'privacy' || kind === 'closed') return WEBHOOK_POLICY_ERRORS[kind];
    }
  } catch { /* Even prototype/field inspection of an unknown rejection may throw. */ }
  return describeStructuralDeliveryError(error);
}

// ---------------------------------------------------------------------------
// WebhookNotifier
// ---------------------------------------------------------------------------

/**
 * WebhookNotifier, sends HTTP POST notifications to configured webhook URLs.
 *
 * Defaults to ntfy.sh-compatible format: plain text body, no auth required.
 * Works with any service that accepts a plain POST with a text/plain body,
 * including ntfy.sh, generic webhooks, and custom endpoints.
 *
 * Runtime notifications ({@link attachToRuntimeBus}, {@link sendNotification})
 * go through the delivery queue: retried with backoff, then kept in the
 * failed-notification list, which {@link persistDeadLetters} keeps on disk.
 * A direct {@link send} or {@link test} makes one attempt and reports it.
 *
 * Usage:
 *   const notifier = new WebhookNotifier(['https://ntfy.sh/my-topic']);
 *   notifier.attachToRuntimeBus(runtimeBus);
 */
export class WebhookNotifier implements NotificationDeadLetterSource {
  private urls: string[];
  private unsubscribe: (() => void) | undefined;
  private readonly queue: DeliveryQueue<NotificationEnvelope | string>;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly active = new Set<Promise<void>>();
  private readonly requests = new Set<AbortController>();
  private readonly timeoutMs: number;
  private readonly metadataOnly: NotificationPrivacyReader | undefined;
  private readonly maxConcurrent: number;
  private readonly maxBodyBytes: number;
  private readonly signingSecret?: string | Uint8Array | undefined;
  /**
   * Bypass test suppression for every delivery from this instance. Intended
   * only for tests that specifically exercise the real HTTP delivery layer
   * (e.g. the SSRF filter tests, which need a real `fetch` attempt to
   * distinguish "blocked" from "not blocked"). Every other caller should
   * leave this unset so `bun test` never fires a real webhook.
   */
  private readonly force: boolean;

  constructor(urls: string[] = [], options: WebhookNotifierOptions = {}) {
    this.urls = validateWebhookUrls(urls);
    this.metadataOnly = options.metadataOnly;
    this.timeoutMs = normalizeWebhookTimeoutMs(options.timeoutMs);
    this.maxConcurrent = normalizePositiveInteger(options.maxConcurrent, 8, 1, 32);
    this.maxBodyBytes = normalizePositiveInteger(options.maxBodyBytes, 64 * 1024, 1_024, 256 * 1024);
    this.signingSecret = normalizeSigningSecret(options.signingSecret);
    this.force = options.force === true;
    this.queue = new DeliveryQueue<NotificationEnvelope | string>({
      ...(options.delivery ?? {}),
      configManager: options.configManager,
      diagnosticMode: 'structural',
    });
  }

  /**
   * Create a WebhookNotifier from a list of URLs (e.g. from persisted config).
   */
  static fromConfig(urls: string[], options: WebhookNotifierOptions = {}): WebhookNotifier {
    return new WebhookNotifier(urls, options);
  }

  // -------------------------------------------------------------------------
  // URL management
  // -------------------------------------------------------------------------

  /** Add a webhook URL. Ignores duplicates. Throws on invalid URL. */
  addUrl(url: string): void {
    new URL(url); // throws TypeError if url is invalid
    if (!this.urls.includes(url)) {
      this.urls.push(url);
      logger.info('WebhookNotifier: added URL', { url: sanitizeUrlForLog(url) });
    }
  }

  /** Remove a webhook URL. */
  removeUrl(url: string): boolean {
    const before = this.urls.length;
    this.urls = this.urls.filter((u) => u !== url);
    const removed = this.urls.length < before;
    if (removed) logger.info('WebhookNotifier: removed URL', { url: sanitizeUrlForLog(url) });
    return removed;
  }

  /** Replace all webhook URLs. */
  setUrls(urls: string[]): void {
    this.urls = validateWebhookUrls(urls);
  }

  /** Get a copy of all configured webhook URLs. */
  getUrls(): string[] {
    return [...this.urls];
  }

  /** Returns true if at least one URL is configured. */
  isConfigured(): boolean {
    return this.urls.length > 0;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send a plain-text notification to all configured webhooks.
   *
   * Uses ntfy.sh format by default: POST with text/plain body.
   * URLs are delivered with bounded concurrency; individual failures are
   * logged and returned but do not throw, remaining URLs still receive the notification.
   */
  send(text: string, lifetime: DeliveryLifetime = {}): Promise<WebhookNotifierSendResult> {
    return this.dispatch(() => NotificationEnvelope.legacy(text, this.metadataOnly), lifetime);
  }

  /**
   * Snapshot typed facts once; each recipient independently checks current
   * privacy. Each URL's copy is retried by the delivery queue, so a result is
   * `delivered`, `retrying` (still queued) or `dead_letter` (in the failed list).
   */
  sendNotification(delivery: NotificationDelivery, event = 'notification'): Promise<WebhookNotifierSendResult> {
    const urls = [...this.urls];
    if (this.closed) return Promise.resolve(this.closedReceipt(urls));
    return this.own(() => this.queueEnvelope(event, NotificationEnvelope.typed(delivery, this.metadataOnly), urls));
  }

  private async queueEnvelope(event: string, envelope: NotificationEnvelope, urls: readonly string[]): Promise<WebhookNotifierSendResult> {
    const lastErrors = new Map<string, unknown>();
    const results = await mapSettledWithConcurrency(urls, this.maxConcurrent, (url) =>
      this.queue.enqueue('webhook', event, envelope, async () => {
        try { await this.postOne(url, envelope, {}); }
        catch (error) { lastErrors.set(url, error); throw error; }
      }, { target: url }));
    const failure = (url: string, reason: unknown) => {
      const status = deliveryHttpStatus(reason);
      return { url, ok: false, error: describeWebhookError(reason), ...(status === undefined ? {} : { status }) };
    };
    const deliveries = urls.map((url, i): WebhookNotifierDeliveryResult => {
      const result = results[i]!;
      if (result.status === 'rejected') {
        // The queue refuses once this notifier is closed; say so by name.
        return this.closed ? { url, ok: false, error: WEBHOOK_POLICY_ERRORS.closed } : failure(url, result.reason);
      }
      const outcome = result.value;
      return outcome === 'delivered' ? { url, ok: true, outcome } : { ...failure(url, lastErrors.get(url)), outcome };
    });
    return {
      attempted: deliveries.length,
      delivered: deliveries.filter((result) => result.ok).length,
      failed: deliveries.filter((result) => !result.ok).length,
      results: deliveries,
    };
  }

  /**
   * Keep failed notifications in `path` so they survive a restart and can
   * still be listed and resent. Entries already in the file are loaded now.
   */
  persistDeadLetters(path: string): void {
    this.queue.persistDeadLetters(path, notificationDeadLetterCodec(this.metadataOnly));
  }

  /** The failed notifications, oldest first, in their metadata-only form. URLs are not shown. */
  listDeadLetters(): readonly NotificationDeadLetter[] {
    return describeDeadLetters(this.queue.getDlq(), (payload) => this.queuedEnvelope(payload).describe());
  }

  /**
   * Resend failed notifications: all of them, or those named in `ids`. A
   * notification whose URL was removed since is not sent there.
   */
  async replayDeadLetters(ids?: readonly string[]): Promise<NotificationReplayResult[]> {
    if (this.closed) throw new DeliveryError('The webhook notifier is closed.', 'terminal');
    const results: NotificationReplayResult[] = await this.own(() => this.queue.replay(async (entry) => {
      const target = entry.target;
      if (!target || !this.urls.includes(target)) {
        throw new DeliveryError('The webhook this notification was for is no longer configured.', 'terminal');
      }
      await this.postOne(target, this.queuedEnvelope(entry.payload), {});
    }, ids));
    const found = new Set(results.map((result) => result.id));
    for (const id of ids ?? []) {
      if (!found.has(id)) results.push({ id, outcome: 'not-found' });
    }
    return results;
  }

  /** Told each time a notification moves to the failed list. Returns the unsubscribe function. */
  onDeadLetter(listener: () => void): () => void {
    return this.queue.onDeadLetter(() => listener());
  }

  private queuedEnvelope(payload: NotificationEnvelope | string): NotificationEnvelope {
    return payload instanceof NotificationEnvelope ? payload : NotificationEnvelope.restoredLegacy();
  }

  private dispatch(create: () => NotificationEnvelope, lifetime: DeliveryLifetime = {}): Promise<WebhookNotifierSendResult> {
    assertDeliveryCurrent(lifetime);
    const urls = [...this.urls];
    if (this.closed) return Promise.resolve(this.closedReceipt(urls));
    // Register before privacy readers, formatters or transport can reenter close.
    return this.own(() => this.sendEnvelope(create(), urls, lifetime));
  }

  private closedReceipt(urls: readonly string[]): WebhookNotifierSendResult {
    return { attempted: urls.length, delivered: 0, failed: urls.length,
      results: urls.map((url) => ({ url, ok: false, error: WEBHOOK_POLICY_ERRORS.closed })) };
  }

  private async sendEnvelope(envelope: NotificationEnvelope, urls: readonly string[], lifetime: DeliveryLifetime): Promise<WebhookNotifierSendResult> {
    if (urls.length === 0) {
      return { attempted: 0, delivered: 0, failed: 0, results: [] };
    }

    const results = await mapSettledWithConcurrency(urls, this.maxConcurrent, (url) => this.postOne(url, envelope, lifetime));
    const deliveries = urls.map((url, i): WebhookNotifierDeliveryResult => {
      const result = results[i]!;
      if (result.status === 'fulfilled') {
        return { url, ok: true };
      }
      const error = describeWebhookError(result.reason);
      const status = deliveryHttpStatus(result.reason);
      return { url, ok: false, error, ...(status === undefined ? {} : { status }) };
    });

    for (const delivery of deliveries) {
      if (!delivery.ok) {
        logger.warn('WebhookNotifier: delivery failed', { url: sanitizeUrlForLog(delivery.url), error: delivery.error, ...(delivery.status === undefined ? {} : { status: delivery.status }) });
      }
    }
    return {
      attempted: deliveries.length,
      delivered: deliveries.filter((result) => result.ok).length,
      failed: deliveries.filter((result) => !result.ok).length,
      results: deliveries,
    };
  }

  /**
   * Send a test notification to all configured webhooks.
   */
  test(): Promise<WebhookNotifierDeliveryResult[]> {
    return this.dispatch(() => NotificationEnvelope.probe()).then((receipt) => [...receipt.results]);
  }

  /**
   * Fence new work synchronously, remove subscriptions, abort owned requests,
   * and await every admitted operation including response-body cleanup.
   * Uncooperative signing, fetch or cleanup remains pending until it settles.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let resolve!: () => void;
    this.closing = new Promise<void>((done) => { resolve = done; });
    // Publish the stable promise before unsubscribe/abort can call close again.
    this.detach();
    for (const controller of this.requests) controller.abort(new WebhookPolicyError('closed'));
    void Promise.all([...this.active, this.queue.close()]).then(() => resolve());
    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  private own<T>(work: () => Promise<T>): Promise<T> {
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    this.active.add(settled);
    return (async () => {
      try { return await work(); }
      finally { this.active.delete(settled); resolve(); }
    })();
  }

  // -------------------------------------------------------------------------
  // Runtime event integration
  // -------------------------------------------------------------------------

  /**
   * Announce agent and workstream outcomes from `bus` to every configured URL
   * (see notification-dispatcher.ts for the events and their wording).
   */
  attachToRuntimeBus(bus: RuntimeEventBus, options: RuntimeNotificationOptions = {}): void {
    this.detach();
    if (this.closed) return;
    this.unsubscribe = attachRuntimeNotifications(bus, (delivery, event) => this.sendNotification(delivery, event), options);
    logger.info('WebhookNotifier: attached to RuntimeEventBus', { urlCount: this.urls.length });
  }

  /** Remove subscriptions only; admitted deliveries continue. Use close to drain. */
  detach(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (!unsubscribe) return;
    try { unsubscribe(); }
    catch { logger.warn('WebhookNotifier: subscription cleanup failed'); }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async postOne(url: string, envelope: NotificationEnvelope, lifetime: DeliveryLifetime): Promise<void> {
    assertDeliveryCurrent(lifetime);
    this.assertOpen();
    // SSRF tier filter, block requests to internal/private hosts.
    const hostname = extractHostname(url);
    if (hostname !== null) {
      const trustResult = classifyHostTrustTier(hostname);
      // Automated webhook egress has no interactive approval flow: loopback
      // targets stay refused here alongside the absolute SSRF block.
      if (trustResult.tier === 'blocked' || trustResult.tier === 'localhost') {
        emitSsrfDeny(hostname, url, trustResult.reason);
        throw new WebhookPolicyError('blocked');
      }
    }

    // Real webhook delivery must never fire from an automated test run,
    // suppressed the same way as desktop notifications (NODE_ENV==='test' or
    // GOODVIBES_SUPPRESS_NOTIFY), with `force` as the sanctioned opt-back-in
    // for tests that exercise this delivery layer itself.
    if (isNotifySuppressed(this.force)) {
      logger.debug('WebhookNotifier: delivery suppressed under test', { url: sanitizeUrlForLog(url) });
      throw new WebhookPolicyError('suppressed');
    }

    this.assertOpen();
    const controller = new AbortController();
    const abort = () => controller.abort(lifetime.signal?.reason);
    lifetime.signal?.addEventListener('abort', abort, { once: true });
    if (lifetime.signal?.aborted) abort();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), this.timeoutMs);
    timer.unref?.();
    try {
      // The envelope can only downgrade once. If signing yielded while any
      // recipient observed restriction, discard that body/signature pair and
      // prepare/sign the redacted body once. No unbounded retry is possible.
      for (let preparation = 0; preparation < 2; preparation += 1) {
        assertDeliveryCurrent(lifetime);
        this.assertOpen(controller.signal);
        const prepared = envelope.prepare();
        this.assertOpen(controller.signal);
        const body = truncateUtf8(prepared.text, this.maxBodyBytes);
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
        if (this.signingSecret) {
          Object.assign(headers, await createWebhookSignatureHeaders(body, this.signingSecret));
        }
        this.assertOpen(controller.signal);
        const current = envelope.isCurrent(prepared.revision);
        this.assertOpen(controller.signal);
        if (!current) continue;
        assertDeliveryCurrent(lifetime);
        const res = await postToPublicWebhook(url, {
          method: 'POST', headers, body, signal: controller.signal,
        }, { ...lifetime, allowHttp: true, assertCurrent: () => { assertDeliveryCurrent(lifetime); this.assertOpen(controller.signal);
          if (!envelope.isCurrent(prepared.revision)) throw new WebhookPolicyError('privacy'); } });
        // Own both successful and failed response cleanup. Never retain body
        // text: a remote response can echo previously permitted private content.
        try {
          envelope.refreshPrivacy();
          if (!res.ok) throw new HttpStatusError(`HTTP ${res.status}`, { status: res.status });
        } finally {
          try { await res.body?.cancel(); } catch { /* status remains authoritative */ }
        }
        return;
      }
      throw new WebhookPolicyError('privacy');
    } finally {
      try { envelope.refreshPrivacy(); }
      finally { clearTimeout(timer); this.requests.delete(controller); lifetime.signal?.removeEventListener('abort', abort); }
    }
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed) throw new WebhookPolicyError('closed');
    signal?.throwIfAborted();
  }
}

export interface WebhookNotifierOptions {
  /** Read live on admission and every actual attempt; only literal false permits content. */
  metadataOnly?: NotificationPrivacyReader | undefined;
  timeoutMs?: number | undefined;
  maxConcurrent?: number | undefined;
  maxBodyBytes?: number | undefined;
  signingSecret?: string | Uint8Array | undefined;
  /** Retry, backoff and dead-letter limits for queued notifications; defaults come from `configManager`. */
  delivery?: Partial<DeliveryQueueConfig> | undefined;
  /** Source of the integrations.delivery.* settings. */
  configManager?: Pick<ConfigManager, 'get'> | null | undefined;
  /**
   * Bypass test suppression for every delivery from this instance. Only
   * tests that exercise the real HTTP delivery layer itself should set this
   *, everything else should be left unset so `bun test` never sends a real
   * webhook request.
   */
  force?: boolean | undefined;
}

export interface WebhookNotifierDeliveryResult {
  readonly url: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
  /** Validated HTTP status without arbitrary response wording. */
  readonly status?: number | undefined;
  /** For a queued notification: delivered, still queued for retry, or moved to the failed list. */
  readonly outcome?: DeliveryOutcome | undefined;
}

export interface WebhookNotifierSendResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly results: readonly WebhookNotifierDeliveryResult[];
}

function normalizeWebhookTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return 10_000;
  }
  return Math.min(60_000, Math.max(1_000, Math.trunc(timeoutMs)));
}

function normalizePositiveInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validateWebhookUrls(urls: readonly string[]): string[] {
  return urls.map((url) => {
    new URL(url);
    return url;
  });
}

function normalizeSigningSecret(secret: string | Uint8Array | undefined): string | Uint8Array | undefined {
  if (typeof secret === 'string') return secret.trim().length > 0 ? secret : undefined;
  if (secret instanceof Uint8Array) return secret.byteLength > 0 ? secret : undefined;
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const next = encoder.encode(char).byteLength;
    if (bytes + next > maxBytes) break;
    out += char;
    bytes += next;
  }
  return out;
}

async function createWebhookSignatureHeaders(
  body: string,
  secret: string | Uint8Array,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encoder = new TextEncoder();
  const keyBytes = typeof secret === 'string'
    ? encoder.encode(secret)
    : new Uint8Array(secret);
  const rawKey = new Uint8Array(keyBytes).buffer;
  if (!globalThis.crypto?.subtle) {
    throw new Error('Webhook signing requires Web Crypto HMAC support.');
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = encoder.encode(`${timestamp}.${body}`);
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, payload);
  return {
    'X-GoodVibes-Webhook-Timestamp': timestamp,
    'X-GoodVibes-Webhook-Signature': `v1=${hex(new Uint8Array(signature))}`,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function mapSettledWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(values[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
