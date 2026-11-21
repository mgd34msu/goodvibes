import { assertDeliveryCurrent, runDeliveryPublication, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { retireDeliveryResponse } from './delivery-diagnostics.js';
/** GoodVibes platform notification transport. */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect as http2Connect } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { HttpStatusError } from '@goodvibes/engine/errors';
import { parseRetryAfterMs } from '@goodvibes/engine/transport-http/http-core';
import type { ConfigManager } from '../config/manager.js';
import { surfaceConfigDefaults } from '../config/schema-domain-surfaces.js';

export const GOODVIBES_NTFY_ORIGIN = 'goodvibes-platform';
export const GOODVIBES_NTFY_ORIGIN_HEADER = 'X-Goodvibes-Origin';
export const GOODVIBES_NTFY_OUTBOUND_TAG = 'goodvibes-platform-outbound';
/**
 * The inbound topic names earlier builds shipped as defaults. On a public ntfy
 * server a topic name is the only secret, and these were the same on every
 * installation, so anyone could post work into them and read the replies. A
 * subscription to one of them on the public server is refused; new installs
 * get generated names (see {@link ensureNtfyTopics}).
 */
export const GOODVIBES_NTFY_CHAT_TOPIC = 'goodvibes-chat';
export const GOODVIBES_NTFY_AGENT_TOPIC = 'goodvibes-agent';
export const GOODVIBES_NTFY_REMOTE_TOPIC = 'goodvibes-ntfy';
export const GOODVIBES_NTFY_DEFAULT_TOPICS = [
  GOODVIBES_NTFY_CHAT_TOPIC,
  GOODVIBES_NTFY_AGENT_TOPIC,
  GOODVIBES_NTFY_REMOTE_TOPIC,
] as const;

/** The three inbound topic settings, by the role each topic plays. */
export const NTFY_TOPIC_SETTINGS = {
  chatTopic: 'surfaces.ntfy.chatTopic',
  agentTopic: 'surfaces.ntfy.agentTopic',
  remoteTopic: 'surfaces.ntfy.remoteTopic',
} as const;
type NtfyTopicRole = keyof typeof NTFY_TOPIC_SETTINGS;
const NTFY_TOPIC_ROLES = Object.keys(NTFY_TOPIC_SETTINGS) as NtfyTopicRole[];

export interface GoodVibesNtfyTopicConfig {
  readonly chatTopic?: string | null | undefined;
  readonly agentTopic?: string | null | undefined;
  readonly remoteTopic?: string | null | undefined;
  /** `surfaces.ntfy.baseUrl`; the public server refuses the old shipped names. */
  readonly baseUrl?: string | null | undefined;
}

/** A topic that is configured and not subscribed, with the setting to change. */
export interface RefusedNtfyTopic {
  readonly setting: string;
  readonly topic: string;
  readonly reason: string;
}

export interface GoodVibesNtfyTopics {
  /** Empty when the role has no usable topic. */
  readonly chatTopic: string;
  readonly agentTopic: string;
  readonly remoteTopic: string;
  /** The topics to subscribe to. */
  readonly all: readonly string[];
  readonly refused: readonly RefusedNtfyTopic[];
}

/** The server an empty `surfaces.ntfy.baseUrl` means: the setting's default. */
const DEFAULT_NTFY_BASE_URL: string = surfaceConfigDefaults.ntfy.baseUrl;

/** A `surfaces.ntfy.baseUrl` value as the server it names: trimmed, and the default server when empty. */
export function normalizeNtfyBaseUrl(value: unknown): string {
  return (typeof value === 'string' ? value.trim() : '') || DEFAULT_NTFY_BASE_URL;
}

/**
 * The ntfy server every part of the platform publishes to, reads from and
 * probes: `surfaces.ntfy.baseUrl`, or the setting's default when it is empty.
 */
export function ntfyBaseUrl(config: Pick<ConfigManager, 'get'>): string {
  return normalizeNtfyBaseUrl(config.get('surfaces.ntfy.baseUrl'));
}

/** True for the public ntfy server, where anyone who knows a topic name can publish to it and read it. */
export function isPublicNtfyServer(baseUrl: string | null | undefined): boolean {
  try {
    const host = new URL(normalizeNtfyBaseUrl(baseUrl)).hostname.toLowerCase();
    return host === 'ntfy.sh' || host.endsWith('.ntfy.sh');
  } catch {
    return false;
  }
}

/** A topic name nobody can guess: 96 random bits after a readable prefix. */
export function generateNtfyTopic(role: 'chat' | 'agent' | 'remote'): string {
  return `goodvibes-${role}-${randomBytes(12).toString('hex')}`;
}

/**
 * The inbound topics to subscribe to. An unset role has no topic (earlier
 * builds fell back to a shipped name); a shipped name on the public server is
 * refused, naming the setting and what to do.
 */
export function resolveGoodVibesNtfyTopics(config: GoodVibesNtfyTopicConfig = {}): GoodVibesNtfyTopics {
  const publicServer = isPublicNtfyServer(config.baseUrl);
  const refused: RefusedNtfyTopic[] = [];
  const topicFor = (role: NtfyTopicRole): string => {
    const topic = typeof config[role] === 'string' ? config[role]!.trim() : '';
    if (topic && publicServer && (GOODVIBES_NTFY_DEFAULT_TOPICS as readonly string[]).includes(topic)) {
      refused.push({
        setting: NTFY_TOPIC_SETTINGS[role],
        topic,
        reason: `${topic} is a name every installation shipped with, so on the public ntfy server anyone can post to it and read the replies; `
          + `clear ${NTFY_TOPIC_SETTINGS[role]} to have an unguessable name generated, or set a name of your own`,
      });
      return '';
    }
    return topic;
  };
  const chatTopic = topicFor('chatTopic');
  const agentTopic = topicFor('agentTopic');
  const remoteTopic = topicFor('remoteTopic');
  return {
    chatTopic,
    agentTopic,
    remoteTopic,
    all: [...new Set([chatTopic, agentTopic, remoteTopic].filter(Boolean))],
    refused,
  };
}

/**
 * What topic generation reads and writes. A topic setting is declared
 * secret-bearing (the name is the credential on a public server), so `store`
 * puts a generated name in the secret store and a reference in the setting.
 */
export interface NtfyTopicConfigStore {
  get(key: string): unknown;
  store(key: string, topic: string): Promise<void>;
}

/**
 * Give every unset inbound topic an unguessable name and save it, the way the
 * relay picks its rendezvous id the first time it is needed. Returns the
 * settings written, so the caller can say which names to subscribe to on the
 * phone. A topic already set, even to an old shipped name, is left to its owner.
 */
export async function ensureNtfyTopics(config: NtfyTopicConfigStore): Promise<readonly { readonly setting: string; readonly topic: string }[]> {
  const written: { setting: string; topic: string }[] = [];
  const roleNames: Record<NtfyTopicRole, 'chat' | 'agent' | 'remote'> = { chatTopic: 'chat', agentTopic: 'agent', remoteTopic: 'remote' };
  for (const role of NTFY_TOPIC_ROLES) {
    const setting = NTFY_TOPIC_SETTINGS[role];
    const current = config.get(setting);
    if (typeof current === 'string' && current.trim() !== '') continue;
    const topic = generateNtfyTopic(roleNames[role]);
    await config.store(setting, topic);
    written.push({ setting, topic });
  }
  return written;
}

/** The configured default priority, or undefined when it is not a whole number from 1 to 5. */
export function resolveNtfyDefaultPriority(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 ? n : undefined;
}

export function createNtfyLiveSubscriptionSince(nowMs = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

export interface NtfyPublishOptions extends DeliveryLifetime {
  readonly title?: string | undefined;
  readonly priority?: 1 | 2 | 3 | 4 | 5 | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly click?: string | undefined;
  readonly attach?: string | undefined;
  readonly actions?: readonly string[] | undefined;
  readonly markGoodVibesOrigin?: boolean | undefined;
  /**
   * Publish even if the identical body just went to this topic. For the rare
   * caller whose repeat IS the message (a heartbeat, a re-ask). Everything
   * else is deduplicated, see `ntfyOutboundDedup`.
   */
  readonly allowDuplicate?: boolean | undefined;
  /**
   * The identity of what this notification announces, for example
   * `agent:<id>:final:1` or `approval:<id>:pending`. Two publishes with the same
   * identity to one topic within the window are one announcement, whatever
   * their wording; two different identities are both sent even when their text
   * is the same. Without it the body text is the identity.
   */
  readonly announces?: string | undefined;
}

/** What a publish did: sent to the server, or suppressed as a repeat of an announcement just sent. */
export type NtfyPublishOutcome = 'sent' | 'suppressed';

/** How long an identical body to the same topic counts as a duplicate. */
const OUTBOUND_DEDUP_WINDOW_MS = 30_000;
const OUTBOUND_DEDUP_MAX_ENTRIES = 500;

/**
 * Last-line-of-defense suppression for identical outbound notifications.
 *
 * The reply pipeline already sends deltas and never republishes a body it just
 * sent, but that memory is per AGENT. A phone shows one topic, and several
 * publishers converge on it: the reply pipeline, surface delivery, automation
 * delivery, and every agent in a chain. Nothing above this point can see that
 * two of them are about to send byte-identical text seconds apart, which is
 * how one workstream produced nine copies of one line.
 *
 * Scope, stated plainly: this is per PROCESS. It cannot suppress a duplicate
 * published by a second, older client process still attached to the same
 * daemon, that is what the client compatibility floor is for.
 */
class NtfyOutboundDedup {
  private readonly seen = new Map<string, number>();

  /** True when this announcement may be published now. */
  claim(key: string, now = Date.now()): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && now - last < OUTBOUND_DEDUP_WINDOW_MS) return false;
    this.seen.set(key, now);
    if (this.seen.size > OUTBOUND_DEDUP_MAX_ENTRIES) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at >= OUTBOUND_DEDUP_WINDOW_MS) this.seen.delete(key);
    }
    // Still oversized after expiry (a burst of distinct bodies): drop oldest
    // first. Insertion order is chronological, so the head is the oldest.
    while (this.seen.size > OUTBOUND_DEDUP_MAX_ENTRIES) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }

  /** Give a claim back after the send it covered failed, so a retry is not mistaken for a duplicate. */
  release(key: string): void {
    this.seen.delete(key);
  }

  /** The suppression key: the announced identity when the publisher names one, else the text. */
  static key(topic: string, title: string | undefined, body: string, announces: string | undefined): string {
    return announces
      ? `${topic}\u0000id\u0000${announces}`
      : `${topic}\u0000text\u0000${title ?? ''}\u0000${body}`;
  }

  /** Test seam: forget everything. */
  reset(): void {
    this.seen.clear();
  }
}

export const ntfyOutboundDedup = new NtfyOutboundDedup();

/**
 * Drop a click target whose host is a bind address rather than a destination.
 * Returns the original string for every usable URL, including loopback (which
 * is genuinely correct when the notification is opened on the host itself).
 */
export function dropUnreachableClickTarget(click: string | undefined): string | undefined {
  if (!click) return undefined;
  if (!containsWildcardHostUrl(click)) return click;
  logger.debug('Dropped a notification click target pointing at a bind address', { click });
  return undefined;
}

/** True when the text is (or contains) a URL whose host is a wildcard bind address. */
export function containsWildcardHostUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const matches = value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s,;]+/gi) ?? [];
  for (const candidate of matches) {
    let host: string;
    try {
      host = new URL(candidate).hostname;
    } catch {
      continue;
    }
    const normalized = host.trim().toLowerCase();
    if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]' || normalized === '0:0:0:0:0:0:0:0') {
      return true;
    }
  }
  return false;
}

export interface NtfyMessage {
  readonly id?: string | undefined;
  readonly time?: number | undefined;
  readonly event: 'open' | 'keepalive' | 'message' | 'message_delete' | 'message_clear' | 'poll_request' | string;
  readonly topic?: string | undefined;
  readonly message?: string | undefined;
  readonly title?: string | undefined;
  readonly priority?: number | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly click?: string | undefined;
  readonly actions?: readonly unknown[] | undefined;
  readonly [key: string]: unknown;
}

export interface NtfySubscribeOptions {
  readonly since?: string | undefined;
  readonly scheduled?: boolean | undefined;
  readonly poll?: boolean | undefined;
  readonly filters?: Record<string, string | number | boolean | readonly string[]> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly reconnect?: boolean | undefined;
  /**
   * Wait before the first reconnect (default 1 s). Each further reconnect with
   * nothing received in between doubles it, up to `maxReconnectDelayMs`
   * (default 60 s); anything received resets it.
   */
  readonly reconnectDelayMs?: number | undefined;
  readonly maxReconnectDelayMs?: number | undefined;
  /**
   * Told each time a stream failure is about to be retried by reconnecting.
   * Without it a stream that drops every second is indistinguishable, from
   * outside, from one that is quietly connected.
   */
  readonly onReconnect?: ((error: unknown) => void) | undefined;
  /**
   * A stream that delivers nothing, not even ntfy's keepalive, for this long is
   * treated as dead and reconnected. A path that dies without a reset never
   * errors, so silence is the only signal. Default 90 s (ntfy keeps alive every
   * 30 s); 0 disables.
   */
  readonly idleTimeoutMs?: number | undefined;
}

export interface NtfyWebSocketOptions extends NtfySubscribeOptions {
  readonly WebSocketImpl?: typeof WebSocket | undefined;
}

/**
 * Reduce a title to something an HTTP header can actually carry.
 *
 * Replaces the punctuation that shows up in generated titles with ASCII
 * equivalents, drops anything still outside printable ASCII (control bytes and
 * header separators included, so a title can never inject a header), and caps
 * the length. Returns undefined when nothing usable is left, which publishes
 * the notification untitled rather than not at all.
 */
export function toHeaderSafeTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const normalized = title
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 250);
  return normalized.length > 0 ? normalized : undefined;
}

export class NtfyIntegration {
  /** `baseUrl` is the server to publish to; read it with {@link ntfyBaseUrl}. */
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  /**
   * Publish one notification. Resolves `'sent'` when the server accepted it,
   * `'suppressed'` when the same announcement (see `announces`) went to this
   * topic within the last 30 seconds and nothing was sent.
   */
  async publish(topic: string, message: string, options: NtfyPublishOptions = {}): Promise<NtfyPublishOutcome> {
    assertDeliveryCurrent(options);
    const key = NtfyOutboundDedup.key(topic, options.title, message, options.announces);
    if (!options.allowDuplicate && !ntfyOutboundDedup.claim(key)) {
      logger.info('Suppressed a repeated ntfy notification', { topic, ...(options.announces ? { announces: options.announces } : { bytes: message.length }) });
      return 'suppressed';
    }
    // The claim stands while the send is in flight (so a concurrent identical
    // publish is still suppressed) but is handed back when the send fails: a
    // body that never reached the server must not block its own retry.
    try {
      await this.send(topic, message, options);
      return 'sent';
    } catch (error) {
      if (!options.allowDuplicate) ntfyOutboundDedup.release(key);
      throw error;
    }
  }

  private async send(topic: string, message: string, options: NtfyPublishOptions): Promise<void> {
    const target = `${this.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
    const headers = new Headers({
      'Content-Type': 'text/plain; charset=utf-8',
    });
    // HTTP headers are latin-1 on the wire, so a title carrying any non-ASCII
    // character, an ellipsis, an em dash, an emoji, a name with an accent,
    // makes Headers.set throw and takes the WHOLE notification down, message
    // body and all. A real progress title of "Rate limited, retrying in 60s..." (with a Unicode ellipsis)
    // did exactly that. The title is decoration; the message is the point, so
    // an untransmittable title is degraded rather than allowed to drop the send.
    const title = toHeaderSafeTitle(options.title);
    if (title) headers.set('Title', title);
    if (options.priority) headers.set('Priority', String(options.priority));
    const tags = options.markGoodVibesOrigin
      ? [...new Set([...(options.tags ?? []), GOODVIBES_NTFY_OUTBOUND_TAG])]
      : options.tags ?? [];
    if (tags.length) headers.set('Tags', tags.join(','));
    // Last chokepoint before the wire. Callers are supposed to resolve a
    // reachable base URL (utils/reachable-base-url.ts) and omit the link when
    // there is none, but a click target pointing at a BIND address is dead
    // wherever it is tapped, so a wildcard host is dropped here no matter which
    // call site built it. This is a backstop, not the fix: it also covers a
    // publisher that predates the resolver.
    const click = dropUnreachableClickTarget(options.click);
    if (click) headers.set('Click', click);
    if (options.attach) headers.set('Attach', options.attach);
    const actions = (options.actions ?? []).filter((action) => !containsWildcardHostUrl(action));
    if (actions.length) headers.set('Actions', actions.join(';'));
    if (options.markGoodVibesOrigin) headers.set(GOODVIBES_NTFY_ORIGIN_HEADER, GOODVIBES_NTFY_ORIGIN);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);

    assertDeliveryCurrent(options);
    const response = await runDeliveryPublication(options, () => fetchWithTimeout(target, {
      method: 'POST',
      headers,
      body: message,
      ...(options.signal ? { signal: options.signal } : {}),
    }));
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // A 429 carries the wait the server names, which the caller's retry honours.
      const retryAfterMs = parseRetryAfterMs(response.headers);
      throw new HttpStatusError(`NtfyIntegration.publish failed (${response.status}): ${body}`, {
        status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    await retireDeliveryResponse(response);
  }

  buildSubscribeUrl(topic: string, mode: 'json' | 'sse' | 'raw' | 'ws' = 'json', options: NtfySubscribeOptions = {}): string {
    const pathTopic = topic.split(',').map((entry) => encodeURIComponent(entry.trim())).filter(Boolean).join(',');
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/${pathTopic}/${mode}`);
    if (options.poll) url.searchParams.set('poll', '1');
    if (options.since) url.searchParams.set('since', options.since);
    if (options.scheduled) url.searchParams.set('scheduled', '1');
    for (const [key, value] of Object.entries(options.filters ?? {})) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    if (mode === 'ws') {
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    }
    return url.toString();
  }

  async poll(topic: string, options: Omit<NtfySubscribeOptions, 'poll'> = {}): Promise<NtfyMessage[]> {
    const url = this.buildSubscribeUrl(topic, 'json', { ...options, poll: true });
    const headers = this.buildAuthHeaders();
    const response = await instrumentedFetch(url, {
      method: 'GET',
      headers,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    } as RequestInit);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpStatusError(`NtfyIntegration.poll failed (${response.status}): ${body}`, { status: response.status });
    }
    const raw = await response.text();
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NtfyMessage);
  }

  async subscribeJsonStream(
    topic: string,
    onMessage: (message: NtfyMessage) => void | Promise<void>,
    options: NtfySubscribeOptions = {},
  ): Promise<void> {
    const reconnect = options.reconnect ?? !options.poll;
    let resumeSince = options.since;
    const seenMessageIds = new NtfySeenMessageIds();
    const baseDelayMs = Math.max(0, options.reconnectDelayMs ?? 1_000);
    const maxDelayMs = Math.max(baseDelayMs, options.maxReconnectDelayMs ?? 60_000);
    let delayMs = baseDelayMs;
    // A server that refused HTTP/2 once is read over HTTP/1 from then on, so a
    // reconnect is one connection attempt, not two.
    const transport = { http1Only: false };
    while (!options.signal?.aborted) {
      const url = this.buildSubscribeUrl(topic, 'json', { ...options, since: resumeSince });
      try {
        await readNtfyJsonStreamWithNodeTransport(url, this.buildAuthHeaders(), async (message) => {
          const messageId = readNtfyMessageId(message);
          if (messageId && seenMessageIds.has(messageId)) return;
          await onMessage(message);
          // A handled message or a keepalive shows the stream works. `open` alone
          // does not: a server that accepts and drops at once keeps backing off.
          if (message.event === 'message' || message.event === 'keepalive') delayMs = baseDelayMs;
          if (messageId) {
            seenMessageIds.add(messageId);
            resumeSince = messageId;
          } else if (message.event === 'message' && typeof message.time === 'number' && Number.isFinite(message.time)) {
            resumeSince = String(Math.floor(message.time));
          }
        }, options.signal, options.idleTimeoutMs ?? NTFY_STREAM_IDLE_TIMEOUT_MS, transport);
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect || isFatalNtfyStreamError(error)) throw error;
        try { options.onReconnect?.(error); } catch { /* an observer cannot end the subscription */ }
      }
      if (!reconnect || options.signal?.aborted) return;
      await waitForNtfyReconnectDelay(options.signal, delayMs);
      delayMs = Math.min(maxDelayMs, Math.max(1, delayMs) * 2);
    }
  }

  connectWebSocket(
    topic: string,
    onMessage: (message: NtfyMessage) => void | Promise<void>,
    options: NtfyWebSocketOptions = {},
  ): WebSocket {
    const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    // A WebSocket cannot carry an Authorization header, so ntfy takes the same
    // value base64url-encoded in the `auth` query parameter. The URL is a
    // secret from here on: it is handed to the socket and never logged.
    const url = new URL(this.buildSubscribeUrl(topic, 'ws', options));
    if (this.token) url.searchParams.set('auth', Buffer.from(`Bearer ${this.token}`).toString('base64url'));
    const socket = new WebSocketImpl(url.toString());
    socket.addEventListener('message', (event) => {
      void (async () => {
        const raw = typeof event.data === 'string'
          ? event.data
          : event.data instanceof Buffer
            ? event.data.toString('utf-8')
            : String(event.data);
        if (!raw.trim()) return;
        await onMessage(JSON.parse(raw) as NtfyMessage);
      })().catch((error: unknown) => {
        logger.warn('[ntfy] websocket message handling failed', { error: summarizeError(error) });
      });
    });
    return socket;
  }

  private buildAuthHeaders(): Headers {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }
}

class NtfySeenMessageIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length <= 1_024) return;
    const expired = this.order.shift();
    if (expired) this.ids.delete(expired);
  }
}

function readNtfyMessageId(message: NtfyMessage): string | null {
  return message.event === 'message' && typeof message.id === 'string' && message.id.trim()
    ? message.id
    : null;
}

export function isGoodVibesNtfyDeliveryEcho(message: Record<string, unknown>): boolean {
  if (message.event !== 'message') return false;
  const tags = message.tags;
  // Actual earlier published notifications can remain in the incoming backlog.
  // Recognize their old delivery markers only here; fresh publications use the
  // current platform labels above. These tags identify echoes, not authority.
  if (Array.isArray(tags) && (tags.includes(GOODVIBES_NTFY_OUTBOUND_TAG) || tags.includes('goodvibes-sdk-outbound'))) return true;
  const headers = readRecord(message.headers);
  const originHeader = headers ? readCaseInsensitiveHeader(headers, GOODVIBES_NTFY_ORIGIN_HEADER) : undefined;
  return originHeader === GOODVIBES_NTFY_ORIGIN || originHeader === 'goodvibes-sdk';
}

const NTFY_STREAM_IDLE_TIMEOUT_MS = 90_000;

class NtfyStreamIdleError extends Error {
  constructor(idleMs: number) {
    super(`NtfyIntegration.subscribeJsonStream received nothing for ${idleMs} ms`);
    this.name = 'NtfyStreamIdleError';
  }
}

/** Calls `onIdle` once if `touch()` is not called again within `idleMs`. */
function createIdleWatch(idleMs: number, onIdle: () => void): { touch(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const touch = () => {
    stop();
    if (idleMs > 0) { timer = setTimeout(onIdle, idleMs); timer.unref?.(); }
  };
  return { touch, stop };
}

class NtfyStreamHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`NtfyIntegration.subscribeJsonStream failed (${status}): ${body}`);
    this.name = 'NtfyStreamHttpError';
  }
}

interface NtfyJsonStreamState {
  buffer: string;
  queue: Promise<void>;
}

async function readNtfyJsonStreamWithNodeTransport(
  url: string,
  headers: Headers,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
  signal: AbortSignal | undefined,
  idleMs: number,
  transport: { http1Only: boolean } = { http1Only: false },
): Promise<void> {
  // The handler's own failure is not a transport failure: it must not switch
  // protocols, and it reaches the caller as the handler threw it.
  const handle = async (message: NtfyMessage): Promise<void> => {
    try { await onMessage(message); }
    catch (error) { throw new NtfyHandlerError(error); }
  };
  const parsed = new URL(url);
  try {
    if (parsed.protocol === 'http:') {
      return await readNtfyJsonStreamWithHttp1(url, headers, handle, signal, httpRequest, idleMs);
    }
    if (parsed.protocol === 'https:') {
      if (transport.http1Only) return await readNtfyJsonStreamWithHttp1(url, headers, handle, signal, httpsRequest, idleMs);
      try {
        await readNtfyJsonStreamWithHttp2(url, headers, handle, signal, idleMs);
        return;
      } catch (error) {
        if (signal?.aborted || error instanceof NtfyStreamHttpError || error instanceof NtfyStreamIdleError || error instanceof NtfyHandlerError) throw error;
        transport.http1Only = true;
        return await readNtfyJsonStreamWithHttp1(url, headers, handle, signal, httpsRequest, idleMs);
      }
    }
  } catch (error) {
    throw error instanceof NtfyHandlerError ? error.handlerError : error;
  }
  throw new Error(`Unsupported ntfy stream protocol: ${parsed.protocol}`);
}

class NtfyHandlerError extends Error {
  constructor(readonly handlerError: unknown) {
    super('ntfy message handler failed');
    this.name = 'NtfyHandlerError';
  }
}

function readNtfyJsonStreamWithHttp1(
  url: string,
  headers: Headers,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
  signal: AbortSignal | undefined,
  requestImpl: typeof httpRequest,
  idleMs: number,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const state: NtfyJsonStreamState = { buffer: '', queue: Promise.resolve() };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      idle.stop();
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const idle = createIdleWatch(idleMs, () => fail(new NtfyStreamIdleError(idleMs)));
    // A failed stream is torn down, not just rejected: a response left open
    // keeps handing messages to onMessage behind the caller's reconnect, and
    // nothing can abort it once the signal listener is gone.
    const fail = (error: unknown) => settle(() => { req.destroy(); reject(error); });
    const finish = () => settle(resolve);
    const finishQueuedJson = () => {
      state.queue
        .then(() => flushNtfyJsonBuffer(state, onMessage))
        .then(finish)
        .catch(fail);
    };
    const abort = () => {
      aborted = true;
      req.destroy();
      finish();
    };
    const req = requestImpl(url, {
      method: 'GET',
      headers: headersToRecord(headers),
    }, (res) => {
      res.setEncoding('utf8');
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        let body = '';
        res.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => fail(new NtfyStreamHttpError(status, body)));
        res.on('error', fail);
        return;
      }
      res.on('data', (chunk: string) => {
        idle.touch();
        state.queue = state.queue
          .then(() => settled ? undefined : consumeNtfyJsonChunk(state, chunk, onMessage))
          .catch(fail);
      });
      res.on('end', () => {
        finishQueuedJson();
      });
      res.on('error', (error) => {
        if (aborted) finish();
        else fail(error);
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    idle.touch();
    req.on('error', (error) => {
      if (aborted) finish();
      else fail(error);
    });
    req.end();
  });
}

function readNtfyJsonStreamWithHttp2(
  url: string,
  headers: Headers,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
  signal: AbortSignal | undefined,
  idleMs: number,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = http2Connect(parsed.origin);
    const path = `${parsed.pathname}${parsed.search}`;
    const state: NtfyJsonStreamState = { buffer: '', queue: Promise.resolve() };
    let settled = false;
    let aborted = false;
    let status = 0;
    let errorBody = '';
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      idle.stop();
      signal?.removeEventListener('abort', abort);
      client.close();
      callback();
    };
    const idle = createIdleWatch(idleMs, () => fail(new NtfyStreamIdleError(idleMs)));
    const fail = (error: unknown) => settle(() => { stream.close(); reject(error); });
    const finish = () => settle(resolve);
    const finishQueuedJson = () => {
      state.queue
        .then(() => flushNtfyJsonBuffer(state, onMessage))
        .then(finish)
        .catch(fail);
    };
    const abort = () => {
      aborted = true;
      stream.close();
      finish();
    };
    const stream = client.request({
      ':method': 'GET',
      ':path': path,
      ...headersToRecord(headers),
    });
    signal?.addEventListener('abort', abort, { once: true });
    stream.setEncoding('utf8');
    stream.on('response', (responseHeaders) => {
      status = Number(responseHeaders[':status'] ?? 0);
    });
    idle.touch();
    stream.on('data', (chunk: string) => {
      idle.touch();
      if (status !== 0 && (status < 200 || status >= 300)) {
        if (errorBody.length < 4096) errorBody += chunk;
        return;
      }
      state.queue = state.queue
        .then(() => settled ? undefined : consumeNtfyJsonChunk(state, chunk, onMessage))
        .catch(fail);
    });
    stream.on('end', () => {
      if (status < 200 || status >= 300) {
        fail(new NtfyStreamHttpError(status, errorBody));
        return;
      }
      finishQueuedJson();
    });
    stream.on('error', (error) => {
      if (aborted) finish();
      else fail(error);
    });
    client.on('error', (error) => {
      if (aborted) finish();
      else fail(error);
    });
    stream.end();
  });
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

async function consumeNtfyJsonChunk(
  state: NtfyJsonStreamState,
  chunk: string,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
): Promise<void> {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    await onMessage(JSON.parse(trimmed) as NtfyMessage);
  }
}

async function flushNtfyJsonBuffer(
  state: NtfyJsonStreamState,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
): Promise<void> {
  const trimmed = state.buffer.trim();
  state.buffer = '';
  if (trimmed) await onMessage(JSON.parse(trimmed) as NtfyMessage);
}

function isFatalNtfyStreamError(error: unknown): boolean {
  return error instanceof NtfyStreamHttpError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429;
}

function waitForNtfyReconnectDelay(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  if (signal?.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => done();
    timeout = setTimeout(done, delayMs);
    timeout.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readCaseInsensitiveHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}
