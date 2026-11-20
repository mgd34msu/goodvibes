import { revealOrNull, type Secret } from '@goodvibes-jev/engine/platform/platform/security';
import { postToPublicWebhook } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@/runtime/index.ts';
import { readJsonStore, runStoreFileUpdate, writeJsonStore, type JsonStoreContents, type JsonStoreSpec } from '@goodvibes-jev/engine/terminal-shell/agent-turn/store-file';
import {
  SubscriptionStore,
  expandEvents,
  maskFeedUrl,
  recordCalendarEventIngest,
  DEFAULT_REFRESH_INTERVAL_MS,
  type CalendarEvent,
  type CalendarUntrustedIngestRecorder,
  type FeedFetcher,
  type SubscriptionHealth,
} from '@goodvibes-jev/engine/platform/platform/calendar';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { resolveCredentialWriteScope } from '../config/credential-scope.ts';
import type { SecretScope } from '../config/secrets.ts';

/**
 * Agent-side registry for READ-ONLY external calendar SUBSCRIPTIONS (iCalendar
 * feeds, Google "secret address", Outlook published .ics, or any .ics URL).
 *
 * The parse/RRULE/fetch-status engine is the platform's `platform/calendar`
 * (SubscriptionStore + expandEvents). This class owns the two things the platform
 * deliberately leaves to the consumer:
 *  - PERSISTENCE. Feed events are cached to a JSON store next to the local
 *    calendar so `/calendar all` merges them with no network call; subscription
 *    metadata (name, cadence, validators, last-status) lives there too.
 *  - SECRET STORAGE. The feed URL is secrets-adjacent (a Google secret address
 *    grants read access to the calendar), so it is stored ONLY through the
 *    SecretsManager under a per-subscription key; the JSON store holds the secret
 *    KEY, never the URL. `maskFeedUrl` is used anywhere a URL would be shown.
 *
 * Consent = subscribing. Nothing here fetches a URL the user did not explicitly
 * add. The subscribe verb states what will be fetched and how often before saving.
 *
 * Subscribed events are READ-ONLY: they carry a `sub:<name>:` id namespace so the
 * local-store edit/delete paths can refuse them with a plain reason.
 *
 * ## Feed content is untrusted content
 *
 * A subscribed event's summary, location and description are written by whoever
 * controls the feed, the same class of input as a message body or a web page,
 * arriving in a runtime that can also send and buy. So a turn that READS them
 * records an untrusted ingest, which is what arms `evaluateOutwardEffect` for
 * the rest of that turn. The recorder is INJECTED (`recordUntrustedIngest`),
 * exactly as `EmailService` takes it, so this class reaches for no ledger of its
 * own and a test can observe every recording.
 *
 * The recording happens in `seeds()` and `occurrencesInWindow()` and NOWHERE
 * ELSE. Those two are the turn reads: they run because the owner typed
 * `/calendar all` or `/calendar upcoming`, and they hand event text straight to
 * a caller that is about to display it.
 *
 * `subscribe()` and `refresh()` are ARRIVAL, and must never record. A refresh
 * runs on a timer or at boot, with nobody watching, and the ledger is scoped by
 * a turn watermark, so a recording made when a feed body lands would attach to
 * whatever turn happened to be open and refuse that turn's outward action over
 * an event no turn read and nobody asked for. That hands anyone who can get an
 * event onto a subscribed feed a remote off switch for the agent's outward
 * actions. Both paths therefore keep the platform's plain `events()` accessor rather
 * than a recording one.
 */

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

/** The platform CalendarEvent as cached on disk (structurally identical; JSON-safe). */
export type CachedFeedEvent = CalendarEvent;

interface SubscriptionMeta {
  readonly name: string;
  /** SecretsManager key holding the feed URL. */
  readonly secretKey: string;
  /**
   * The feed URL as `maskFeedUrl` renders it, `https://host/…tail`, never the
   * raw value, which is a read capability for the whole calendar.
   *
   * Persisted because the read paths need it and cannot get it. `seeds()` and
   * `occurrencesInWindow()` are synchronous, read only this JSON file, and are
   * built by `subscriptionRegistryForRead` with a secret store that may be a
   * stub returning null, so the raw URL is genuinely unavailable there, and
   * plumbing the secret manager into a display read to fetch a value that would
   * only be masked again is the wrong trade. Written by `subscribe()` and
   * refreshed by `refresh()`, both of which already hold the URL.
   *
   * Optional because stores written before this field existed do not carry it;
   * those records fall back to a plain "unavailable" note in the origin.
   */
  readonly maskedUrl?: string;
  readonly refreshIntervalMs: number;
  /** The owner subscribed with `--allow-private-host`: this feed is fetched from a loopback, LAN or other private address, on purpose. */
  readonly allowPrivateHost?: true;
  readonly lastFetchedAt?: number;
  readonly lastSucceededAt?: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly lastResult?: 'ok' | 'not-modified' | 'unreachable' | 'parse-error';
  readonly lastDetail?: string;
  readonly eventCount?: number;
  readonly events: readonly CachedFeedEvent[];
}

interface SubscriptionStoreFile {
  readonly version: 1;
  readonly subscriptions: readonly SubscriptionMeta[];
}

/** A subscription's status as shown by `/calendar subscriptions`. */
export interface SubscriptionStatus {
  readonly name: string;
  readonly maskedUrl: string;
  readonly health: SubscriptionHealth;
  readonly detail?: string;
  readonly refreshIntervalMs: number;
  readonly allowPrivateHost?: true;
  readonly lastSucceededAt?: number;
  readonly eventCount: number;
}

/** One subscribed occurrence, flattened for a merged, source-labeled view. */
export interface SubscribedOccurrence {
  /** Read-only namespaced id: `sub:<subscriptionName>:<uid>`. */
  readonly id: string;
  readonly subscription: string;
  readonly title: string;
  /** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm:ss[Z]'. */
  readonly start: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly tzid?: string;
  /** True when the source RRULE was not fully expanded, shown as a marker. */
  readonly recurrenceNotFullyExpanded: boolean;
  /**
   * True on a window row for a repeating series whose rule could not be
   * expanded and that began before the window: it may repeat inside the window,
   * but no occurrence can be shown. `start` is when the series began.
   */
  readonly repeatsNotShown?: boolean;
}

export type SubscribeResult =
  | { readonly ok: true; readonly name: string; readonly eventCount: number; readonly calendarName?: string; readonly refreshIntervalMs: number }
  | { readonly ok: false; readonly stage: 'fetch' | 'parse' | 'duplicate'; readonly detail: string };

export type ValidateResult =
  | { readonly ok: true; readonly derivedName: string; readonly eventCount: number; readonly calendarName?: string }
  | { readonly ok: false; readonly stage: 'fetch' | 'parse'; readonly detail: string };

export interface UnsubscribeReport {
  readonly removed: boolean;
  /** What became of the stored feed URL: `none` when there was no such subscription, `unsupported` when the secret store cannot delete. */
  readonly secret: 'none' | 'deleted' | 'failed' | 'unsupported';
  readonly secretKey?: string;
  readonly secretError?: string;
}

export interface RefreshOutcome {
  readonly name: string;
  readonly outcome: 'updated' | 'not-modified' | 'skipped' | 'unreachable' | 'parse-error';
  readonly detail?: string;
  readonly eventCount?: number;
}

/**
 * The SecretsManager surface this registry needs.
 *
 * `set`/`delete` carry write options because the feed URL has to land in a tier
 * the DAEMON reads: the refresh loop runs on a schedule with no terminal open,
 * and a URL filed in this surface's silo makes every scheduled refresh report
 * "Stored feed URL is missing from the secret manager" while the subscription
 * list keeps showing the subscription as configured. The narrower two-argument
 * shape this used to declare made passing a scope impossible, so every
 * subscription silently took the store's default (project) tier.
 */
export interface SubscriptionSecretStore {
  readonly get: (key: string) => Promise<Secret | null>;
  readonly set: (key: string, value: string, options?: { readonly scope?: SecretScope }) => Promise<void>;
  readonly delete?: (key: string, options?: { readonly scope?: SecretScope }) => Promise<void>;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const STORE_VERSION = 1;
/** Data older than this multiple of the refresh interval reads as stale. */
const STALE_MULTIPLE = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secretKeyForName(name: string): string {
  const slug = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `GOODVIBES_CALENDAR_SUB_${slug || 'FEED'}`;
}

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function subscriptionStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'calendar', 'subscriptions.json');
}

/** How long a feed host may take to answer, headers and body together. */
const FEED_TIMEOUT_MS = 30_000;
/** A calendar feed larger than this is refused rather than buffered and cached whole. */
const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FEED_MAX_REDIRECTS = 5;

export interface HttpFeedFetcherOptions {
  /** Sends one request to an already scheme-checked URL. Defaults to the platform's public-host request, which refuses private addresses and does not follow redirects. */
  readonly send?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /**
   * Fetch from loopback, LAN and other private addresses. Off unless the owner
   * subscribed to that feed with `--allow-private-host`; https is still required.
   */
  readonly allowPrivateHosts?: boolean;
}

/** webcal:// is https:// under another name; any other scheme than https is refused. */
function feedRequestUrl(raw: string): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string } {
  let parsed: URL;
  try { parsed = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://')); } catch { return { ok: false, message: 'Feed URL is not a valid address' }; }
  if (parsed.protocol !== 'https:') return { ok: false, message: `Feed URL must use https or webcal, not ${parsed.protocol.replace(/:$/, '')}` };
  return { ok: true, url: parsed.toString() };
}

async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await res.body?.cancel(); return null; }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel(); return null; }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The real HTTP fetcher, conditional GET with etag/last-modified, mapped to FeedFetchResult.
 *
 * A feed URL is typed by the owner but can be steered by what a model read, so
 * it is treated as an outward request to a public host: https (or webcal) only,
 * a host that is not loopback, link-local or private (the platform's check,
 * which resolves the name and pins the connection; `allowPrivateHosts` is the
 * owner's per-feed opt-in for a calendar server on their own network), every redirect hop checked
 * the same way, a time limit, and a size cap. Applied on every refresh, not only
 * at subscribe, because the stored address is fetched again later.
 */
export function createHttpFeedFetcher(options: HttpFeedFetcherOptions = {}): FeedFetcher {
  const send = options.send ?? (options.allowPrivateHosts
    ? (url, init) => fetch(url, init)
    : (url, init) => postToPublicWebhook(url, init));
  const timeoutMs = options.timeoutMs ?? FEED_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
  return async (req) => {
    try {
      const headers: Record<string, string> = { Accept: 'text/calendar, text/plain, */*' };
      if (req.etag) headers['If-None-Match'] = req.etag;
      if (req.lastModified) headers['If-Modified-Since'] = req.lastModified;
      const signal = AbortSignal.timeout(timeoutMs);
      let target = feedRequestUrl(req.url);
      let res: Response | undefined;
      for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop += 1) {
        if (!target.ok) return { kind: 'error', message: target.message };
        res = await send(target.url, { method: 'GET', headers, signal, redirect: 'manual' });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (location === null) break;
        await res.body?.cancel();
        target = feedRequestUrl(new URL(location, target.url).toString());
        res = undefined;
      }
      if (!res) return { kind: 'error', message: `Feed redirected more than ${FEED_MAX_REDIRECTS} times` };
      if (res.status === 304) {
        return { kind: 'not-modified', ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}), ...(res.headers.get('last-modified') ? { lastModified: res.headers.get('last-modified')! } : {}) };
      }
      if (!res.ok) {
        return { kind: 'error', status: res.status, message: res.statusText || `HTTP ${res.status}` };
      }
      const body = await readCappedText(res, maxBytes);
      if (body === null) return { kind: 'error', message: `Feed is larger than ${Math.floor(maxBytes / 1024 / 1024)} MiB` };
      return { kind: 'ok', body, ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}), ...(res.headers.get('last-modified') ? { lastModified: res.headers.get('last-modified')! } : {}) };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Webhook URL/, 'Feed URL');
      // The platform's refusal names the webhook setting; for a feed the owner's way past it is the per-feed opt-in.
      const privateHost = !options.allowPrivateHosts && /host is not allowed|resolves to .*address/.test(message);
      return { kind: 'error', message: privateHost
        ? `${message}. If this calendar server is on your own network, subscribe again with --allow-private-host (in the subscribe form: Allow private host = yes)`
        : message };
    }
  };
}

// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

export interface CalendarSubscriptionRegistryOptions {
  readonly storePath: string;
  readonly secrets: SubscriptionSecretStore;
  readonly fetcher: FeedFetcher;
  /** Fetcher for subscriptions the owner allowed to use a private host; defaults to `fetcher`. */
  readonly privateHostFetcher?: FeedFetcher;
  readonly clock?: () => number;
  readonly defaultRefreshIntervalMs?: number;
  /**
   * Called once per externally-sourced event whose text a TURN read, see the
   * class header. Injected rather than imported so this class holds no ledger;
   * the composition root binds the session ledger.
   */
  readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder;
}

export class CalendarSubscriptionRegistry {
  private readonly storePath: string;
  private readonly secrets: SubscriptionSecretStore;
  private readonly fetcher: FeedFetcher;
  private readonly privateHostFetcher: FeedFetcher;
  private readonly clock: () => number;
  private readonly defaultInterval: number;
  private readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder;

  public constructor(options: CalendarSubscriptionRegistryOptions) {
    this.storePath = options.storePath;
    this.secrets = options.secrets;
    this.fetcher = options.fetcher;
    this.privateHostFetcher = options.privateHostFetcher ?? options.fetcher;
    this.clock = options.clock ?? (() => Date.now());
    this.defaultInterval = options.defaultRefreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (options.recordUntrustedIngest) this.recordUntrustedIngest = options.recordUntrustedIngest;
  }

  /**
   * Serializes the read-merge-write critical section of
   * subscribe/unsubscribe/refresh. The network calls those operations make
   * (feed fetch, secret-store reads) stay OUTSIDE this section, so a slow
   * refresh never blocks a concurrent subscribe from making progress; only
   * the final read-fresh/merge/write is held, which is what stops the two
   * from blind-overwriting each other.
   *
   * Queued on the store path rather than on this instance: the CLI and the
   * TUI build separate registries over the same file, and a per-instance
   * chain lets those two overlap.
   */
  private withMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return runStoreFileUpdate(this.storePath, fn);
  }

  public static create(
    shellPaths: AgentLocalStorePaths,
    secrets: SubscriptionSecretStore,
    fetcher?: FeedFetcher,
    recordUntrustedIngest?: CalendarUntrustedIngestRecorder,
  ): CalendarSubscriptionRegistry {
    return new CalendarSubscriptionRegistry({
      storePath: subscriptionStorePath(shellPaths),
      secrets,
      fetcher: fetcher ?? createHttpFeedFetcher(),
      privateHostFetcher: fetcher ?? createHttpFeedFetcher({ allowPrivateHosts: true }),
      ...(recordUntrustedIngest !== undefined ? { recordUntrustedIngest } : {}),
    });
  }

  /** Fetch a feed WITHOUT saving it, the subscribe preview / wizard validate step. */
  public async validate(url: string, requestedName?: string, options: { readonly allowPrivateHost?: boolean } = {}): Promise<ValidateResult> {
    const store = new SubscriptionStore({ fetcher: this.fetcherFor(options.allowPrivateHost), clock: this.clock });
    const res = await store.validateByFetch(url, requestedName);
    if (!res.ok) return { ok: false, stage: res.stage, detail: res.detail };
    return { ok: true, derivedName: res.derivedName, eventCount: res.eventCount, ...(res.calendarName !== undefined ? { calendarName: res.calendarName } : {}) };
  }

  /**
   * Subscribe: fetch once, derive the name, store the URL as a secret, and cache
   * events. The network fetch/validate (`store.add`) runs unlocked, it is the
   * slow part and does not need exclusive access to the store, but the
   * duplicate-name check, the secret write, and the file write all happen
   * inside one locked read-merge-write section (F2) so a concurrent refresh
   * finishing its own write in between can never cause this subscribe to be
   * silently reverted: the section always re-reads the store fresh right
   * before writing.
   */
  public async subscribe(url: string, requestedName?: string, refreshIntervalMs?: number, options: { readonly allowPrivateHost?: boolean } = {}): Promise<SubscribeResult> {
    const store = new SubscriptionStore({ fetcher: this.fetcherFor(options.allowPrivateHost), clock: this.clock, ...(refreshIntervalMs !== undefined ? { defaultRefreshIntervalMs: refreshIntervalMs } : { defaultRefreshIntervalMs: this.defaultInterval }) });
    const result = await store.add({ url, ...(requestedName !== undefined ? { name: requestedName } : {}), ...(refreshIntervalMs !== undefined ? { refreshIntervalMs } : {}) });
    if (!result.ok) return { ok: false, stage: result.stage, detail: result.detail };
    const sub = result.subscription;
    const events = store.events(sub.name);

    return this.withMutationLock(async () => {
      const read = this.readContents();
      const file = toStoreFile(read);
      const secretKey = secretKeyForName(sub.name);
      // Names that differ only in case or punctuation share one secret key, and
      // a second subscription would overwrite the first one's feed URL. Names
      // are matched case-insensitively everywhere else (unsubscribe, refresh).
      const clash = file.subscriptions.find((s) => s.name.toLowerCase() === sub.name.toLowerCase() || s.secretKey === secretKey);
      if (clash) {
        return { ok: false, stage: 'duplicate', detail: `A subscription named '${clash.name}' already exists and would share its stored address with '${sub.name}': unsubscribe first or pass a different --name.` };
      }
      await this.secrets.set(secretKey, url, { scope: resolveCredentialWriteScope(secretKey) });
      const meta: SubscriptionMeta = {
        name: sub.name,
        secretKey,
        maskedUrl: maskFeedUrl(url),
        refreshIntervalMs: sub.refreshIntervalMs,
        ...(options.allowPrivateHost ? { allowPrivateHost: true as const } : {}),
        ...(sub.lastFetchedAt !== undefined ? { lastFetchedAt: sub.lastFetchedAt } : {}),
        ...(sub.lastSucceededAt !== undefined ? { lastSucceededAt: sub.lastSucceededAt } : {}),
        ...(sub.etag !== undefined ? { etag: sub.etag } : {}),
        ...(sub.lastModified !== undefined ? { lastModified: sub.lastModified } : {}),
        lastResult: 'ok',
        ...(sub.detail !== undefined ? { lastDetail: sub.detail } : {}),
        eventCount: events.length,
        events: [...events],
      };
      this.writeStore(read, [...file.subscriptions, meta]);
      return { ok: true as const, name: sub.name, eventCount: events.length, refreshIntervalMs: sub.refreshIntervalMs };
    });
  }

  /**
   * Remove a subscription, its cached events, and its stored URL secret. The
   * whole read-find-delete-write body is one locked section (F2): small and
   * fast, so there is no benefit to splitting it, and it guarantees the write
   * is always based on a store read taken after every earlier queued mutation
   * (including a refresh's write) has already landed.
   */
  public async unsubscribe(name: string): Promise<boolean> {
    return (await this.unsubscribeWithReport(name)).removed;
  }

  /**
   * {@link unsubscribe}, saying whether the stored feed URL went with it. The URL
   * is a read capability for the whole calendar, so a delete the secret store
   * refused is reported with the key to remove by hand, not swallowed.
   */
  public async unsubscribeWithReport(name: string): Promise<UnsubscribeReport> {
    return this.withMutationLock(async () => {
      const read = this.readContents();
      const file = toStoreFile(read);
      const target = file.subscriptions.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
      if (!target) return { removed: false, secret: 'none' as const };
      let secret: UnsubscribeReport['secret'] = 'unsupported';
      let secretError: string | undefined;
      if (this.secrets.delete) {
        // No scope on the delete: sweep every tier. A feed URL stored before the
        // daemon-tier write shipped is sitting in the project tier, and a delete
        // narrowed to the daemon tier would drop the subscription from the list
        // while leaving the live URL on disk.
        try { await this.secrets.delete(target.secretKey); secret = 'deleted'; }
        catch (error) { secret = 'failed'; secretError = error instanceof Error ? error.message : String(error); }
      }
      this.writeStore(read, file.subscriptions.filter((s) => s !== target));
      return { removed: true, secret, secretKey: target.secretKey, ...(secretError === undefined ? {} : { secretError }) };
    });
  }

  /**
   * Refresh one named subscription (or all when name omitted). Network, on
   * demand / on boot.
   *
   * F2 fix: the per-target network fetches run unlocked (so a concurrent
   * subscribe/unsubscribe is never blocked behind them), but the write is a
   * single locked section that re-reads the store fresh and merges each
   * refreshed record onto that fresh read, never onto the stale snapshot
   * this method started with. Concretely: `merged = freshRead.map(record =>
   * refreshedByName.get(record.name) ?? record)`. Because the merge maps
   * over the FRESH list rather than over this call's original target list, a
   * record removed by a concurrent unsubscribe is simply absent from the
   * fresh list and is never resurrected, and a record added by a concurrent
   * subscribe is already present in the fresh list and passes through
   * untouched. Two concurrent refresh() calls still only ever commit through
   * this same locked section one at a time, so neither can double-write or
   * clobber the other's result.
   */
  public async refresh(name?: string, opts: { force?: boolean } = {}): Promise<RefreshOutcome[]> {
    const file = this.readStore();
    const targets = name
      ? file.subscriptions.filter((s) => s.name.toLowerCase() === name.trim().toLowerCase())
      : file.subscriptions;
    if (targets.length === 0) return [];

    const refreshedByName = new Map<string, SubscriptionMeta>();
    const baseByName = new Map<string, SubscriptionMeta>();
    const outcomes: RefreshOutcome[] = [];
    for (const target of targets) {
      const url = revealOrNull(await this.secrets.get(target.secretKey), 'dispatch');
      if (url === null) {
        outcomes.push({ name: target.name, outcome: 'unreachable', detail: 'Stored feed URL is missing from the secret manager: unsubscribe and re-add.' });
        continue;
      }
      const store = new SubscriptionStore({ fetcher: this.fetcherFor(target.allowPrivateHost), clock: this.clock });
      store.restore([{ name: target.name, url, refreshIntervalMs: target.refreshIntervalMs, ...(target.lastFetchedAt !== undefined ? { lastFetchedAt: target.lastFetchedAt } : {}), ...(target.lastSucceededAt !== undefined ? { lastSucceededAt: target.lastSucceededAt } : {}), ...(target.etag !== undefined ? { etag: target.etag } : {}), ...(target.lastModified !== undefined ? { lastModified: target.lastModified } : {}) }], { callerKeepsEvents: true });
      const report = (await store.refresh(target.name, { force: opts.force ?? true }))!;
      const sub = store.get(target.name)!;
      const events = report.outcome === 'updated' ? store.events(target.name) : target.events;
      baseByName.set(target.name, target);
      refreshedByName.set(target.name, {
        name: target.name,
        secretKey: target.secretKey,
        // Backfills the field for a record written before it existed; the URL
        // is already in hand here and masking it costs nothing.
        maskedUrl: maskFeedUrl(url),
        refreshIntervalMs: sub.refreshIntervalMs,
        ...(target.allowPrivateHost ? { allowPrivateHost: true as const } : {}),
        ...(sub.lastFetchedAt !== undefined ? { lastFetchedAt: sub.lastFetchedAt } : {}),
        ...(sub.lastSucceededAt !== undefined ? { lastSucceededAt: sub.lastSucceededAt } : {}),
        ...(sub.etag !== undefined ? { etag: sub.etag } : {}),
        ...(sub.lastModified !== undefined ? { lastModified: sub.lastModified } : {}),
        lastResult: report.outcome === 'skipped' ? target.lastResult : this.resultOf(report.outcome),
        ...(report.detail !== undefined ? { lastDetail: report.detail } : {}),
        eventCount: events.length,
        events: [...events],
      });
      outcomes.push({ name: target.name, outcome: report.outcome, ...(report.detail !== undefined ? { detail: report.detail } : {}), eventCount: events.length });
    }
    if (refreshedByName.size === 0) return outcomes;

    await this.withMutationLock(() => {
      const read = this.readContents();
      const fresh = toStoreFile(read);
      // A subscription unsubscribed and created again under the same name during
      // the fetch is a different record: it has another fetch time, and its
      // cached events must not be replaced by the old feed's.
      const merged = fresh.subscriptions.map((s) => {
        const base = baseByName.get(s.name);
        return base && base.secretKey === s.secretKey && base.lastFetchedAt === s.lastFetchedAt ? (refreshedByName.get(s.name) ?? s) : s;
      });
      this.writeStore(read, merged);
    });
    return outcomes;
  }

  /** Subscription statuses for `/calendar subscriptions`, no network, masked URLs. */
  public async statuses(): Promise<readonly SubscriptionStatus[]> {
    const file = this.readStore();
    const now = this.clock();
    const out: SubscriptionStatus[] = [];
    for (const s of file.subscriptions) {
      const url = revealOrNull(await this.secrets.get(s.secretKey), 'owner-screen');
      out.push({
        name: s.name,
        maskedUrl: url ? maskFeedUrl(url) : '(url missing from secret manager)',
        health: this.healthOf(s, now),
        ...(this.detailOf(s, now) !== undefined ? { detail: this.detailOf(s, now)! } : {}),
        refreshIntervalMs: s.refreshIntervalMs,
        ...(s.allowPrivateHost ? { allowPrivateHost: true as const } : {}),
        ...(s.lastSucceededAt !== undefined ? { lastSucceededAt: s.lastSucceededAt } : {}),
        eventCount: s.eventCount ?? s.events.length,
      });
    }
    return out;
  }

  private fetcherFor(allowPrivateHost: boolean | undefined): FeedFetcher {
    return allowPrivateHost ? this.privateHostFetcher : this.fetcher;
  }

  public hasAny(): boolean {
    return this.readStore().subscriptions.length > 0;
  }

  public names(): readonly string[] {
    return this.readStore().subscriptions.map((s) => s.name);
  }

  /**
   * One row per cached subscribed event (the seed, unexpanded), the merged
   * `/calendar all` view. A recurring event is marked so the reader knows more
   * occurrences exist; `occurrencesInWindow` is the date-windowed expansion.
   */
  public seeds(): readonly SubscribedOccurrence[] {
    const file = this.readStore();
    const out: SubscribedOccurrence[] = [];
    for (const s of file.subscriptions) {
      this.recordReadOfFeedContent(s);
      for (const event of s.events) {
        const recurring = event.recurrence !== undefined;
        out.push({
          id: `sub:${s.name}:${event.uid}`,
          subscription: s.name,
          title: event.summary,
          start: event.start.value,
          allDay: event.start.kind === 'date',
          ...(event.location !== undefined ? { location: event.location } : {}),
          ...(event.start.zone === 'tzid' && event.start.tzid !== undefined ? { tzid: event.start.tzid } : {}),
          recurrenceNotFullyExpanded: recurring && event.recurrence?.expansion === 'unsupported',
        });
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  /**
   * All subscribed occurrences within [fromDate, toDate] (inclusive, 'YYYY-MM-DD'),
   * flattened and source-labeled for a merged read-only view. Recurring events are
   * expanded through the platform; an unsupported RRULE surfaces its seed with a marker
   * when the seed is in the window, and otherwise one `repeatsNotShown` row, so a series
   * that began earlier does not vanish from the agenda.
   */
  public occurrencesInWindow(fromDate: string, toDate: string): readonly SubscribedOccurrence[] {
    const file = this.readStore();
    const out: SubscribedOccurrence[] = [];
    for (const s of file.subscriptions) {
      this.recordReadOfFeedContent(s);
      const row = (event: CalendarEvent, start: string): SubscribedOccurrence => ({
        id: `sub:${s.name}:${event.uid}`,
        subscription: s.name,
        title: event.summary,
        start,
        allDay: event.start.kind === 'date',
        ...(event.location !== undefined ? { location: event.location } : {}),
        ...(event.start.zone === 'tzid' && event.start.tzid !== undefined ? { tzid: event.start.tzid } : {}),
        recurrenceNotFullyExpanded: event.recurrence?.expansion === 'unsupported',
      });
      const { occurrences, unexpandedSeries } = expandEvents(s.events, { from: fromDate, to: toDate });
      for (const o of occurrences) out.push(row(o.event, o.start));
      // A series whose seed is in the window already shows as that seed; one that began earlier gets its own row.
      const shown = new Set(occurrences.map((o) => o.event));
      for (const series of unexpandedSeries) {
        if (!shown.has(series)) out.push({ ...row(series, series.start.value), repeatsNotShown: true });
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  // ── internals ────────────────────────────────────────────────────

  /**
   * Record that a turn read this subscription's cached event text.
   *
   * Called ONLY from `seeds()` and `occurrencesInWindow()`. One entry per event
   * rather than one per feed, because an origin names the party whose words an
   * outward action might turn out to repeat; the platform drops events whose readable
   * fields are all empty, so an event with nothing an outsider wrote records
   * nothing.
   *
   * `expandEvent` is irrelevant here on purpose: a recurring event's text is the
   * same text on every occurrence, so `occurrencesInWindow` records per EVENT,
   * not per occurrence, and a weekly meeting does not produce fifty-two
   * identical entries.
   */
  private recordReadOfFeedContent(s: SubscriptionMeta): void {
    if (this.recordUntrustedIngest === undefined) return;
    recordCalendarEventIngest({
      record: this.recordUntrustedIngest,
      provenance: {
        kind: 'subscription',
        name: s.name,
        maskedUrl: s.maskedUrl ?? '(feed url unavailable)',
      },
      events: s.events,
      at: new Date(this.clock()).toISOString(),
    });
  }

  private resultOf(outcome: RefreshOutcome['outcome']): SubscriptionMeta['lastResult'] {
    if (outcome === 'updated') return 'ok';
    if (outcome === 'not-modified') return 'not-modified';
    if (outcome === 'unreachable') return 'unreachable';
    if (outcome === 'parse-error') return 'parse-error';
    return 'ok';
  }

  private healthOf(s: SubscriptionMeta, now: number): SubscriptionHealth {
    if (s.lastResult === undefined) return 'never-fetched';
    if (s.lastResult === 'unreachable') return 'unreachable';
    if (s.lastResult === 'parse-error') return 'parse-error';
    if (s.lastSucceededAt === undefined) return 'never-fetched';
    if (now - s.lastSucceededAt > s.refreshIntervalMs * STALE_MULTIPLE) return 'stale';
    return 'ok';
  }

  private detailOf(s: SubscriptionMeta, now: number): string | undefined {
    if (this.healthOf(s, now) === 'stale' && s.lastSucceededAt !== undefined) {
      const ageMin = Math.round((now - s.lastSucceededAt) / 60000);
      return `Last updated ${ageMin} min ago (past the ${Math.round(s.refreshIntervalMs / 60000)} min refresh window).`;
    }
    return s.lastDetail;
  }

  private readContents(): JsonStoreContents<SubscriptionMeta> {
    return readJsonStore(this.storePath, SUBSCRIPTION_STORE);
  }

  private readStore(): SubscriptionStoreFile {
    return toStoreFile(this.readContents());
  }

  /** Writes over what `read` found, so a record this version cannot read keeps its cached events and feed pointer. */
  private writeStore(read: JsonStoreContents<SubscriptionMeta>, subscriptions: readonly SubscriptionMeta[]): void {
    writeJsonStore(read, SUBSCRIPTION_STORE, { entries: subscriptions });
  }
}

const SUBSCRIPTION_STORE: JsonStoreSpec<SubscriptionMeta> = {
  label: 'calendar subscription store',
  entriesKey: 'subscriptions',
  version: STORE_VERSION,
  parseEntry: (value) => (isRecord(value) ? coerceMeta(value) : null),
};

function toStoreFile(read: JsonStoreContents<SubscriptionMeta>): SubscriptionStoreFile {
  return { version: STORE_VERSION, subscriptions: read.entries };
}

function coerceMeta(value: Record<string, unknown>): SubscriptionMeta | null {
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const secretKey = typeof value.secretKey === 'string' ? value.secretKey : '';
  if (!name || !secretKey) return null;
  const refreshIntervalMs = typeof value.refreshIntervalMs === 'number' ? value.refreshIntervalMs : DEFAULT_REFRESH_INTERVAL_MS;
  const events = Array.isArray(value.events) ? (value.events.filter(isRecord) as unknown as CachedFeedEvent[]) : [];
  const lastResult = value.lastResult === 'ok' || value.lastResult === 'not-modified' || value.lastResult === 'unreachable' || value.lastResult === 'parse-error' ? value.lastResult : undefined;
  return {
    name,
    secretKey,
    ...(typeof value.maskedUrl === 'string' && value.maskedUrl.length > 0 ? { maskedUrl: value.maskedUrl } : {}),
    refreshIntervalMs,
    ...(value.allowPrivateHost === true ? { allowPrivateHost: true as const } : {}),
    ...(typeof value.lastFetchedAt === 'number' ? { lastFetchedAt: value.lastFetchedAt } : {}),
    ...(typeof value.lastSucceededAt === 'number' ? { lastSucceededAt: value.lastSucceededAt } : {}),
    ...(typeof value.etag === 'string' ? { etag: value.etag } : {}),
    ...(typeof value.lastModified === 'string' ? { lastModified: value.lastModified } : {}),
    ...(lastResult !== undefined ? { lastResult } : {}),
    ...(typeof value.lastDetail === 'string' ? { lastDetail: value.lastDetail } : {}),
    ...(typeof value.eventCount === 'number' ? { eventCount: value.eventCount } : {}),
    events,
  };
}
