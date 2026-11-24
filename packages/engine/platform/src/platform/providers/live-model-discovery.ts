/**
 * Live model discovery, shared fetch/cache/diff/report machinery so a
 * provider's model list can never go stale silently.
 *
 * Each provider that has its own model-listing API (Anthropic, OpenAI,
 * Gemini today) calls `runLiveModelRefresh()` with a small fetch function.
 * The shared logic here handles:
 *   - an on-disk TTL cache (same envelope shape as model-catalog-cache.ts,
 *     via json-ttl-cache.ts's shared helpers) so a restart doesn't re-fetch
 *     immediately and an offline boot still has the last known-good list;
 *   - diffing against the previous list so a refresh can report what
 *     actually changed ("3 new, 1 retired") instead of a silent no-op;
 *   - an honest fallback chain: live fetch -> last on-disk cache (even if
 *     stale) -> nothing of its own, so the pinned model catalog's rows for the
 *     provider stand. No provider keeps a hand-written list in source: a list
 *     written down once goes stale the day a model ships.
 */

import fs from 'node:fs';
import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes/judgment/decisions';
import { classifyFailure } from '@goodvibes/engine/errors';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { summarizeError } from '../utils/error-display.js';
import { instrumentedFetch, fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { TTL_24H_MS, isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { knownFallbackContextWindow } from './context-window-fallback.js';
import { resolveReasoningEffortSpec } from './reasoning-effort-families.js';
import { readChatModelIds } from '../routing/model-limit-readings.js';
import type { ModelDefinition } from './registry-types.js';

const LIVE_FETCH_TIMEOUT_MS = 15_000;

/** Where a provider's list came from: its endpoint now, its last answer on disk, or (no answer yet) the pinned model catalog. */
export type LiveModelDiscoverySource = 'live' | 'cache' | 'catalog';

export interface LiveModelDiscoveryResult {
  /** The provider's own list right now. Empty when it has never answered: the pinned catalog's rows for it are the list then. */
  readonly models: readonly string[];
  /** Where `models` came from. */
  readonly source: LiveModelDiscoverySource;
  /** Model ids present now that weren't in the previous known list. */
  readonly added: readonly string[];
  /** Model ids that were in the previous known list but are gone now. */
  readonly removed: readonly string[];
  /** Set when `source !== 'live'` because a live fetch was attempted and failed. Honest failure reason. */
  readonly error?: string | undefined;
  /** When the list was read from the provider (epoch ms); absent when it never answered. */
  readonly listedAt?: number | undefined;
  /** Listed models kept although neither the endpoint nor the catalog states their capabilities. */
  readonly unclassifiedModels?: readonly string[] | undefined;
  /** What the listing does not establish, shown with the report (for example a list read from a related account). */
  readonly note?: string | undefined;
  readonly skippedReason?: 'local-endpoint-unavailable' | undefined;
  /**
   * Per-model max output tokens the listing itself reported, by model id, for a provider whose
   * listing carries them (Anthropic). The same on a live, cached or lent listing; absent when the
   * listing reported none or came from a cache file written before this field existed.
   */
  readonly maxOutputTokens?: Readonly<Record<string, number>> | undefined;
  /**
   * Set with `error` when the failure says the provider cannot serve calls now: nothing answered, the
   * credentials were refused, the bill is unpaid, or the service failed. Routing then holds the provider
   * out until a call succeeds. A listing the endpoint refused as a request (a 400 or 404 from a model-list
   * route the sign-in does not offer) says nothing about calls, and leaves the provider routable.
   */
  readonly cannotServe?: boolean | undefined;
}

/** Failure categories of a listing that say the provider's calls fail too. */
const CANNOT_SERVE_CATEGORIES: ReadonlySet<string> = new Set(['authentication', 'authorization', 'billing', 'network', 'timeout', 'service']);

/** Whether a failed model listing says the provider cannot serve calls now (see `LiveModelDiscoveryResult.cannotServe`). */
export function listingFailureMeansCannotServe(error: unknown): boolean {
  const failure = classifyFailure(error);
  return failure !== undefined && CANNOT_SERVE_CATEGORIES.has(failure.category);
}

/** A model listing's HTTP failure, with its status, so `listingFailureMeansCannotServe` can read what it says about the provider. */
export function listingHttpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** What a provider's live fetch returns: the ids, or the ids with what the listing also said about them. */
export type LiveModelListing = string[] | {
  readonly models: string[];
  readonly unclassifiedModels?: string[] | undefined;
  readonly maxOutputTokens?: Readonly<Record<string, number>> | undefined;
};

interface ModelListCacheFile {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: string[];
  unclassifiedModels?: string[];
  /** Whose list this is (a sign-in's identity); a different one makes the file stale. */
  key?: string;
  /** Per-model max output tokens the listing reported; absent in files older releases wrote. */
  maxOutputTokens?: Record<string, number>;
}

/** The well-formed entries of a stored output-limit record, or undefined when it holds none. */
function storedMaxOutputTokens(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const limits: Record<string, number> = {};
  for (const [id, limit] of Object.entries(value as Record<string, unknown>)) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) limits[id] = Math.floor(limit);
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/** Cache file path for a provider's live-discovered model list. */
export function getProviderModelsCachePath(persistenceRoot: string, providerId: string): string {
  return join(persistenceRoot, 'provider-models', `${providerId}.json`);
}

/**
 * The model list a provider stored at its last read (not tied to a sign-in),
 * so a provider starts from what it read last while the fresh read runs.
 */
export function storedProviderModelIds(cachePath: string | undefined): string[] | undefined {
  if (!cachePath) return undefined;
  const stored = loadModelListCache(cachePath);
  return stored && stored.key === undefined && stored.models.length > 0 ? [...stored.models] : undefined;
}

function loadModelListCache(cachePath: string): ModelListCacheFile | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const { cache, reason } = validateTtlCacheEnvelope<ModelListCacheFile>(parsed, 'models', 'array');
    if (!cache) {
      logger.warn('[provider-models] Ignoring malformed model list cache', { cachePath, reason: reason ?? 'unknown' });
      return null;
    }
    return cache;
  } catch (err) {
    const msg = summarizeError(err);
    if (!msg.includes('ENOENT') && !msg.includes('no such file')) {
      logger.warn('[provider-models] Model list cache load failed', { cachePath, error: msg });
    }
    return null;
  }
}

function saveModelListCache(
  models: readonly string[],
  cachePath: string,
  unclassifiedModels: readonly string[] = [],
  key?: string,
  maxOutputTokens?: Readonly<Record<string, number>>,
): void {
  try {
    fs.mkdirSync(dirname(cachePath), { recursive: true });
    const payload: ModelListCacheFile = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: TTL_24H_MS,
      models: [...models],
      ...(unclassifiedModels.length ? { unclassifiedModels: [...unclassifiedModels] } : {}),
      ...(key ? { key } : {}),
      ...(maxOutputTokens ? { maxOutputTokens: { ...maxOutputTokens } } : {}),
    };
    // A unique temporary file per write: the TUI and the daemon may refresh the same cache at once.
    writeJsonFileAtomic(cachePath, payload);
  } catch (err) {
    logger.warn('[provider-models] Model list cache write failed', { cachePath, error: summarizeError(err) });
  }
}

/** Diff two model id lists. Order-independent. */
export function diffModelIds(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !previousSet.has(id)),
    removed: previous.filter((id) => !nextSet.has(id)),
  };
}

/** Human-readable one-line summary of a refresh, for surfaces that just want a status line. */
export function formatModelDiscoveryReport(providerName: string, result: LiveModelDiscoveryResult): string {
  if (result.source === 'live') {
    const pending = result.unclassifiedModels?.length ?? 0;
    if (result.added.length === 0 && result.removed.length === 0 && pending === 0) {
      return `${providerName}: no changes (${result.models.length} models)`;
    }
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`${result.added.length} new`);
    if (result.removed.length > 0) parts.push(`${result.removed.length} retired`);
    if (pending > 0) parts.push(`${pending} unclassified`);
    return `${providerName}: ${parts.join(', ')}${result.note ? ` (${result.note})` : ''}`;
  }
  if (result.error) {
    const fallback = result.source === 'cache' ? 'its last listed models' : 'the pinned model catalog';
    return `${providerName}: live model refresh failed (${result.error}), using ${fallback}`;
  }
  if (result.source === 'cache') return `${providerName}: using its last listed models (${result.models.length})`;
  return `${providerName}: not listed yet, using the pinned model catalog`;
}

export interface LiveModelRefreshOptions {
  readonly providerName: string;
  /** Where the list is read from (scheme, host and port), for the words of a failed read. */
  readonly address?: string | undefined;
  /**
   * Absolute path to this provider's on-disk model-list cache file. When
   * omitted, refresh runs in-memory only (no on-disk persistence, no TTL
   * skip), used by tests and any caller that hasn't wired a persistence
   * root through yet.
   */
  readonly cachePath?: string | undefined;
  /**
   * Whose list this is, for a provider whose list depends on the sign-in (a
   * subscription account): a cached list stored under another key is stale.
   */
  readonly cacheKey?: string | undefined;
  /** Whether the provider has credentials configured. When false, live fetch is skipped entirely. */
  readonly isConfigured: boolean;
  /** Performs the live fetch. Should reject on any failure (network, auth, parse). */
  readonly fetchLive: () => Promise<LiveModelListing>;
  /**
   * Bypass the TTL cache and always re-check live. Set this for an explicit
   * user-triggered refresh or a picker-open re-check; leave false for
   * routine background refreshes so they respect the on-disk TTL cache
   * instead of hitting the network on every boot.
   */
  readonly force?: boolean | undefined;
  /** Host restriction before publication. Retirement rejects instead of using stale account data. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Bulk discovery may skip an unused optional loopback server that is not running. */
  readonly skipUnavailableLocal?: boolean | undefined;
  /** Where this refresh's listing is recorded for a second registry to borrow; see {@link LiveModelListings}. */
  readonly recordTo?: LiveModelListings | undefined;
  /** A host registry's listings this refresh takes instead of reading and fetching again, unless `force`. */
  readonly borrowFrom?: LiveModelListings | undefined;
}

/** What a registry hands each provider's `refreshModels` beside `force`. */
export interface ProviderModelRefreshOptions {
  /** Bulk discovery may skip an unused optional loopback server that is not running. */
  readonly skipUnavailableLocal?: boolean | undefined;
  readonly recordTo?: LiveModelListings | undefined;
  readonly borrowFrom?: LiveModelListings | undefined;
}

/**
 * The model listings one registry's refreshes produced, by provider name, so a
 * second registry over the same providers and persistence root (a daemon's
 * hosted-session workspace floor, built again whenever a workspace's next
 * session starts) takes them instead of reading every provider's cache file
 * and probing every unconfigured loopback server the host has just probed.
 *
 * A listing is lent while it is younger than the on-disk list's lifetime
 * (a cached list counts from when it was fetched); the host records every
 * refresh it runs, so the borrower knows what the host knows. An older listing,
 * or a provider the host never listed, is refreshed by the borrower itself.
 * A borrowed listing is reported as `cache`: the borrower fetched nothing.
 */
export class LiveModelListings {
  readonly #byProvider = new Map<string, { readonly result: LiveModelDiscoveryResult; readonly listedAt: number }>();

  /** `now` is injectable so a listing's lifetime can be driven without waiting. */
  constructor(private readonly now: () => number = Date.now) {}

  record(providerName: string, result: LiveModelDiscoveryResult, listedAt: number): void {
    this.#byProvider.set(providerName, { result, listedAt });
  }

  lend(providerName: string): LiveModelDiscoveryResult | undefined {
    const entry = this.#byProvider.get(providerName);
    if (!entry || this.now() - entry.listedAt > TTL_24H_MS) return undefined;
    const { result } = entry;
    return { ...result, source: result.source === 'live' ? 'cache' : result.source, added: [], removed: [] };
  }
}

/** A host registry's listings as it lends them: the store, and when the host's startup sweep has settled. */
export interface LentModelListings {
  readonly listings: LiveModelListings;
  readonly settled: () => Promise<void>;
}

/**
 * Run a single live-discovery refresh cycle for one provider: take a host
 * registry's current listing when one is lent, otherwise try the cache for a
 * diff baseline, attempt a live fetch when configured, fall back to
 * cache-then-pinned-catalog on failure, and persist a successful fetch.
 */
export async function runLiveModelRefresh(opts: LiveModelRefreshOptions): Promise<LiveModelDiscoveryResult> {
  if (!opts.force && opts.borrowFrom) {
    const lent = opts.borrowFrom.lend(opts.providerName);
    if (lent) return lent;
  }
  const { result, listedAt } = await refreshListing(opts);
  opts.recordTo?.record(opts.providerName, result, listedAt);
  return result;
}

/** One refresh, with when its listing was taken: a cached list's fetch time, otherwise now. */
async function refreshListing(opts: LiveModelRefreshOptions): Promise<{ result: LiveModelDiscoveryResult; listedAt: number }> {
  const listed = (result: LiveModelDiscoveryResult, listedAt = Date.now()) => ({ result, listedAt });
  const sourceCurrent = opts.assertCurrent;
  const assertCurrent = (): void => {
    try {
      assertSynchronousJudgmentGuard(sourceCurrent, () => new Error());
    } catch (error) {
      drainOwned(error);
      throw new Error('The original model-discovery owner is no longer current.');
    }
  };
  assertCurrent();
  const stored = opts.cachePath ? loadModelListCache(opts.cachePath) : null;
  // A list another sign-in read is not this one's.
  const cache = stored && (opts.cacheKey === undefined || stored.key === opts.cacheKey) ? stored : null;
  const baseline = cache?.models ?? [];
  const cachedLimits = storedMaxOutputTokens(cache?.maxOutputTokens);
  const cachedFacts = cachedLimits ? { maxOutputTokens: cachedLimits } : {};
  assertCurrent();

  if (cache && !opts.force && !isTtlCacheStale(cache)) {
    return listed({ models: cache.models, source: 'cache', added: [], removed: [], listedAt: cache.fetchedAt, ...cachedFacts }, cache.fetchedAt);
  }

  if (!opts.isConfigured) {
    // No fetch is made without credentials, so this answer is current at any age of the file.
    if (cache) return listed({ models: cache.models, source: 'cache', added: [], removed: [], listedAt: cache.fetchedAt, ...cachedFacts });
    return listed({ models: [], source: 'catalog', added: [], removed: [] });
  }

  try {
    const listing = await opts.fetchLive();
    assertCurrent();
    const fetched = Array.isArray(listing) ? listing : listing.models;
    const unclassifiedModels = Array.isArray(listing) ? [] : listing.unclassifiedModels ?? [];
    const maxOutputTokens = Array.isArray(listing) ? undefined : storedMaxOutputTokens(listing.maxOutputTokens);
    if (fetched.length === 0) {
      throw new Error('live model list was empty');
    }
    const { added, removed } = diffModelIds(baseline, fetched);
    if (opts.cachePath) saveModelListCache(fetched, opts.cachePath, unclassifiedModels, opts.cacheKey, maxOutputTokens);
    assertCurrent();
    return listed({ models: fetched, source: 'live', added, removed, listedAt: Date.now(),
      ...(unclassifiedModels.length ? { unclassifiedModels } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}) });
  } catch (err) {
    assertCurrent();
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (opts.skipUnavailableLocal && !cache && (code === 'ConnectionRefused' || code === 'ECONNREFUSED')) {
      return listed({ models: [], source: 'catalog', added: [], removed: [], skippedReason: 'local-endpoint-unavailable' });
    }
    const cannotServe = listingFailureMeansCannotServe(err) ? { cannotServe: true } : {};
    // The runtime's own words go to the log; the row says it plainly.
    logger.warn('[provider-models] Live model discovery failed', { provider: opts.providerName, address: opts.address, error: summarizeError(err) });
    const message = unreachableListingWords(opts.providerName, opts.address, err, cache?.fetchedAt);
    if (cache) {
      return listed({ models: cache.models, source: 'cache', added: [], removed: [], error: message, ...cannotServe, listedAt: cache.fetchedAt, ...cachedFacts }, cache.fetchedAt);
    }
    return listed({ models: [], source: 'catalog', added: [], removed: [], error: message, ...cannotServe });
  }
}

/** The scheme, host and port of a listing URL, for the words of a failed read (never its path or query). */
export function listingAddress(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
}

/** Why a listing failed, in plain words (the raw error is logged, not shown). */
function plainListingReason(err: unknown): string {
  const status = err && typeof err === 'object' && 'status' in err && typeof err.status === 'number' ? err.status : undefined;
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'it did not accept the key';
    if (status === 404) return 'it has no model list at that address';
    if (status === 429) return 'it is limiting requests right now';
    if (status >= 500) return `it had an error of its own (HTTP ${status})`;
    return `it answered HTTP ${status}`;
  }
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  if (code === 'ConnectionRefused' || code === 'ECONNREFUSED') return 'nothing is listening at that address';
  if (code === 'ENOTFOUND' || code === 'DNSException' || code === 'EAI_AGAIN') return 'that name could not be found';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'Timeout') return 'it did not answer in time';
  if (code === 'FailedToOpenSocket' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'this computer could not open a connection to it';
  if (code === 'ConnectionClosed' || code === 'ECONNRESET') return 'it closed the connection';
  if (code.startsWith('CERT_') || code.includes('CERT') || code.includes('SSL')) return 'its certificate was not trusted';
  if (text === 'live model list was empty') return 'it listed no models';
  if (text.endsWith('returned no model array')) return 'its answer was not a model list';
  return 'the request failed';
}

/**
 * A provider row whose read failed: "Could not reach <provider> at <address>:
 * <plain reason>. Showing the list read <when>."
 */
export function unreachableListingWords(provider: string, address: string | undefined, err: unknown, storedAt: number | undefined): string {
  const where = address ? ` at ${address}` : '';
  const shown = storedAt !== undefined
    ? `Showing the list read ${new Date(storedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'No list was read from it yet; showing the models it came with.';
  return `Could not reach ${provider}${where}: ${plainListingReason(err)}. ${shown}`;
}

const CHAT_MODEL_SITE = 'providers.live-model-discovery.chat-model';

/** One entry of an OpenAI-style model listing, with the fields some backends add. */
interface ListedModelEntry {
  readonly id?: unknown;
  readonly model_id?: unknown;
  readonly type?: unknown;
  readonly capabilities?: unknown;
}

/** Explicit capabilities and published model types supplied by the endpoint. */
function listedChatCapability(entry: ListedModelEntry): boolean | undefined {
  const capabilities = entry.capabilities;
  if (capabilities && typeof capabilities === 'object') {
    const completionChat = (capabilities as { readonly completion_chat?: unknown }).completion_chat;
    if (typeof completionChat === 'boolean') return completionChat;
  }
  if (typeof entry.type === 'string' && ['chat', 'embedding', 'reranking', 'image', 'video', 'speech', 'transcription', 'decision', 'realtime'].includes(entry.type)) return entry.type === 'chat';
  return undefined;
}

/** Endpoint facts take precedence; repository facts resolve otherwise unstated capabilities. */
async function chatModelIds(providerName: string, entries: readonly { readonly id: string; readonly entry: ListedModelEntry }[],
  onUnclassifiedModel?: (modelId: string) => void, options: { readonly keepUnclassified?: boolean } = {}): Promise<string[]> {
  const unstated = entries.filter(({ entry }) => listedChatCapability(entry) === undefined).map(({ id }) => id);
  const readAsChat = new Set(await readChatModelIds(providerName, unstated, CHAT_MODEL_SITE, onUnclassifiedModel, options));
  return entries
    .filter(({ id, entry }) => listedChatCapability(entry) ?? readAsChat.has(id))
    .map(({ id }) => id);
}

/**
 * Fetch a model id list from an OpenAI-style listing endpoint
 * (GET <url> returning `{ "data": [{ "id": ... }] }`). Shared by every
 * OpenAI-compatible gateway provider; the same response shape is used by
 * Anthropic-style listings, so the Anthropic-compat fetcher delegates here
 * without the chat-capability filter.
 */
export async function fetchModelIdsFromListing(
  providerName: string,
  url: string,
  headers: Record<string, string>,
  options: { readonly filterNonChat?: boolean | undefined; readonly onUnclassifiedModel?: (modelId: string) => void } = {},
): Promise<string[]> {
  const res = await fetchWithTimeout(url, { headers }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw listingHttpError(`${providerName} model listing (${url}) returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = await res.json() as
    | { data?: ListedModelEntry[] }
    | ListedModelEntry[];
  // Most backends use OpenAI's `{data:[{id}]}`; Together returns a bare array,
  // and a few aggregators (e.g. AiHubMix) use `model_id` instead of `id`.
  const entries = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(entries)) {
    throw new Error(`${providerName} model listing (${url}) returned no model array`);
  }
  const listed = entries.flatMap((entry) => {
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.model_id === 'string' ? entry.model_id : null;
    return id === null ? [] : [{ id, entry }];
  });
  return options.filterNonChat ? chatModelIds(providerName, listed, options.onUnclassifiedModel) : listed.map(({ id }) => id);
}

/**
 * Fetch Fireworks' live model list. Fireworks' OpenAI-compatible inference
 * surface has no /models listing; the documented listing lives on the
 * account-management API (GET /v1/accounts/fireworks/models, paginated).
 * Model resource names there ("accounts/fireworks/models/<id>") are exactly
 * the ids the chat surface accepts.
 */
/** Pagination stops here so a runaway listing cannot grow without bound; the cut is logged. */
const FIREWORKS_MODEL_LIMIT = 5000;

export async function fetchFireworksModelIds(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  let truncated = false;
  do {
    const url = `https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
    if (!res.ok) {
      throw listingHttpError(`Fireworks model listing (${url}) returned ${res.status} ${res.statusText}`, res.status);
    }
    const body = await res.json() as { models?: Array<{ name?: unknown }>; nextPageToken?: unknown };
    for (const model of body.models ?? []) {
      if (typeof model.name === 'string' && model.name.length > 0) ids.push(model.name);
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (pageToken && ids.length >= FIREWORKS_MODEL_LIMIT) {
      truncated = true;
      break;
    }
  } while (pageToken);
  if (truncated) {
    logger.warn('[provider-models] Fireworks model listing truncated', { limit: FIREWORKS_MODEL_LIMIT, listed: ids.length });
  }
  return ids;
}

/**
 * One model as Anthropic's GET /v1/models reports it.
 *
 * `/v1/models` carries the per-model token limits alongside the id, so the
 * authoritative output cap can be read from the provider rather than guessed
 * from a hand-maintained table that goes stale the day a model ships.
 */
export interface AnthropicLiveModel {
  readonly id: string;
  /** The model's max output tokens (`max_tokens`), when the API reported one. */
  readonly maxOutputTokens?: number | undefined;
  /** The model's context window (`max_input_tokens`), when the API reported one. */
  readonly maxInputTokens?: number | undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Fetch the live model list from Anthropic's GET /v1/models endpoint, with
 * each entry's reported token limits.
 *
 * A field the API omits comes back undefined rather than defaulted, so a
 * caller can tell "the provider did not say" from "the provider said zero"
 * and fall back to its offline table only in the first case.
 */
export async function fetchAnthropicModels(apiKey: string): Promise<AnthropicLiveModel[]> {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw listingHttpError(`Anthropic /v1/models returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = await res.json() as {
    data?: Array<{ id?: unknown; max_tokens?: unknown; max_input_tokens?: unknown }>;
  };
  const models: AnthropicLiveModel[] = [];
  for (const entry of body.data ?? []) {
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const maxOutputTokens = positiveInteger(entry.max_tokens);
    const maxInputTokens = positiveInteger(entry.max_input_tokens);
    models.push({
      id: entry.id,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    });
  }
  return models;
}

/** Fetch the live model list from Anthropic's GET /v1/models endpoint. */
export async function fetchAnthropicModelIds(apiKey: string): Promise<string[]> {
  return (await fetchAnthropicModels(apiKey)).map((model) => model.id);
}

/** Fetch the live model list from OpenAI's GET /v1/models endpoint, filtered to the ids that read as chat models. */
export async function fetchOpenAIModelIds(apiKey: string): Promise<{ models: string[]; unclassifiedModels: string[] }> {
  const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw listingHttpError(`OpenAI /v1/models returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = await res.json() as { data?: ListedModelEntry[] };
  // OpenAI's listing mixes speech, image and moderation models with no type field. The catalog
  // names the ones it knows; an id it does not know yet (a model released since the pin) is kept
  // and reported as unclassified, so it can be chosen the day it ships.
  const unclassifiedModels: string[] = [];
  const models = await chatModelIds('openai', (body.data ?? []).flatMap((entry) => (typeof entry.id === 'string' ? [{ id: entry.id, entry }] : [])),
    (modelId) => unclassifiedModels.push(modelId), { keepUnclassified: true });
  return { models, unclassifiedModels };
}

/** Fetch the live model list from Google's Gemini ListModels endpoint. */
export async function fetchGeminiModelIds(apiKey: string): Promise<string[]> {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
    {},
    LIVE_FETCH_TIMEOUT_MS,
    instrumentedFetch,
  );
  if (!res.ok) {
    throw listingHttpError(`Gemini ListModels returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = await res.json() as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> };
  const ids = (body.models ?? [])
    .filter((entry) => {
      const methods = entry.supportedGenerationMethods;
      return !Array.isArray(methods) || methods.length === 0 || methods.includes('generateContent');
    })
    .map((entry) => (typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : null))
    .filter((id): id is string => id !== null);
  return ids;
}

/**
 * Build a ModelDefinition for a live-discovered or declared model id that
 * isn't already represented in the shared model catalog (models.dev). Used
 * to fill the gap when the third-party catalog snapshot lags behind a
 * provider's own live listing (e.g. a model released today).
 */
export function buildProviderNativeModelDefinition(providerId: string, modelId: string): ModelDefinition {
  return {
    id: modelId,
    provider: providerId,
    registryKey: `${providerId}:${modelId}`,
    displayName: modelId,
    // Listed by the provider but not in the model catalog: its capabilities below are defaults, not facts.
    description: `${modelId}, listed by ${providerId}; not in the model catalog, so its capabilities are unclassified.`,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: true,
      // Image input is not published for a model the catalog does not list,
      // and a provider's name says nothing about one model's input.
      multimodal: false,
    },
    contextWindow: knownFallbackContextWindow(providerId, modelId),
    contextWindowProvenance: 'fallback',
    selectable: true,
    // Endpoint catalog facts take precedence over interpreted family fallbacks.
    reasoningEffort: resolveReasoningEffortSpec({ provider: providerId, modelId }),
  };
}
