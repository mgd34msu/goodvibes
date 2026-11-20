import { networkInterfaces } from 'node:os';
import { readLocalServerIdentity } from '../routing/provider-readings.js';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { discoverContextWindows } from '../providers/context-discovery.js';
import { WELL_KNOWN_LOCAL_PORTS } from '../providers/well-known-endpoints.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { summarizeError } from '../utils/error-display.js';
import { capturePersistedServer } from './persisted-cache.js';
import { getPersistedProvidersPath, loadPersistedProviders, type DiscoveryRoots } from './persisted-providers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerType = 'ollama' | 'lm-studio' | 'vllm' | 'llamacpp' | 'localai' | 'tgi' | 'jan' | 'gpt4all' | 'koboldcpp' | 'aphrodite' | 'unknown';

export interface DiscoveredServer {
  name: string;       // 'Ollama', 'LM Studio', 'local-192.168.1.50:8080'
  host: string;       // '127.0.0.1' or '192.168.1.50'
  port: number;
  baseURL: string;    // 'http://192.168.1.50:11434/v1'
  models: string[];   // ['llama3:latest', 'codellama:7b']
  serverType: ServerType;
  modelContextWindows?: Record<string, number>; // modelId -> context window tokens
  modelOutputLimits?: Record<string, number>;   // modelId -> max output tokens
  /** modelId -> the model's size as the server reports it in the listing the scan already reads ("3.2B"). */
  modelSizes?: Record<string, string>;
}

/** A server that answered but was left out of a scan, and why. */
export interface SkippedServer {
  host: string;
  port: number;
  /** One line: what could not be read from it. */
  reason: string;
}

export interface ScanResult {
  servers: DiscoveredServer[];
  /** Servers that answered and could not be identified or read; each was left out alone. */
  skipped: SkippedServer[];
  scannedHosts: number;
  scannedPorts: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// The saved-scan reader lives in persisted-providers.ts, light enough for a
// command that only names the saved servers.
export { loadPersistedProviders };

interface PersistedServer extends DiscoveredServer {
  lastSeen: number; // Unix ms timestamp
}

/**
 * How long a provider stays in the cache without being seen again. The network
 * sweep probes the private networks the machine is on, so without an age limit every address ever
 * answered on every network the machine has visited would be kept forever.
 */
const PERSISTED_PROVIDER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Replace the cache file whole, so a crash mid-write cannot leave a torn file. */
function writeCacheAtomically(persistedPath: string, entries: readonly PersistedServer[]): void {
  writeFileAtomic(persistedPath, JSON.stringify(entries, null, 2) + '\n', { durable: false });
}

/**
 * The entries already on disk that the loader would accept and that have been
 * seen recently enough to keep. An entry without a timestamp is stamped now so
 * it ages out like any other.
 */
function readLiveEntries(persistedPath: string, now: number): PersistedServer[] | null {
  const parsed = JSON.parse(readFileSync(persistedPath, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) return null;
  const live: PersistedServer[] = [];
  for (const item of parsed as unknown[]) {
    const server = capturePersistedServer(item);
    if (!server) continue;
    const seen = (item as Record<string, unknown>).lastSeen;
    const lastSeen = typeof seen === 'number' && Number.isFinite(seen) ? seen : now;
    if (now - lastSeen > PERSISTED_PROVIDER_MAX_AGE_MS) continue;
    live.push({ ...server, lastSeen });
  }
  return live;
}

/** Save discovered providers to disk. Merges with existing entries keyed by host:port. */
export function persistProviders(roots: DiscoveryRoots, servers: DiscoveredServer[]): void {
  const persistedPath = getPersistedProvidersPath(roots);
  try {
    const now = Date.now();
    let existing: PersistedServer[] = [];
    if (existsSync(persistedPath)) {
      try {
        const live = readLiveEntries(persistedPath, now);
        if (live === null) logger.warn('[Scanner] persistProviders ignored invalid existing discovery cache; overwriting with current scan results');
        else existing = live;
      } catch {
        logger.warn('[Scanner] persistProviders could not read existing discovery cache; overwriting with current scan results');
      }
    }
    const byKey = new Map(existing.map(s => [`${s.host}:${s.port}`, s]));
    for (const server of servers) {
      byKey.set(`${server.host}:${server.port}`, { ...server, lastSeen: now });
    }
    writeCacheAtomically(persistedPath, [...byKey.values()]);
  } catch {
    // Discovery still returns live results, but the cache was not updated.
    logger.warn('[Scanner] persistProviders failed; discovery cache was not updated');
  }
}

/** Remove specific servers from the persisted file (by host:port). */
export function removePersistedProviders(roots: DiscoveryRoots, toRemove: Array<{ host: string; port: number }>): void {
  if (toRemove.length === 0) return;
  const persistedPath = getPersistedProvidersPath(roots);
  try {
    if (!existsSync(persistedPath)) return;
    const removeKeys = new Set(toRemove.map(s => `${s.host}:${s.port}`));
    const live = readLiveEntries(persistedPath, Date.now());
    if (live === null) {
      logger.warn('[Scanner] removePersistedProviders skipped invalid discovery cache');
      return;
    }
    writeCacheAtomically(persistedPath, live.filter(s => !removeKeys.has(`${s.host}:${s.port}`)));
  } catch {
    // Discovery cleanup should not block the caller, but stale cache entries remain.
    logger.warn('[Scanner] removePersistedProviders failed; discovery cache was not cleaned up');
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_PORTS = [
  WELL_KNOWN_LOCAL_PORTS.lmStudio,
  WELL_KNOWN_LOCAL_PORTS.jan,
  WELL_KNOWN_LOCAL_PORTS.aphrodite,
  WELL_KNOWN_LOCAL_PORTS.gpt4all,
  5000,
  WELL_KNOWN_LOCAL_PORTS.koboldCpp,
  7860,
  8000,
  8001,
  WELL_KNOWN_LOCAL_PORTS.llamaCpp,
  WELL_KNOWN_LOCAL_PORTS.ollama,
];
const PROBE_TIMEOUT_MS = 200;
const MAX_CONCURRENT_PROBES = 50;
const METADATA_TIMEOUT_MS = 2000;
function requestSignal(timeoutMs: number, owner?: AbortSignal): AbortSignal {
  owner?.throwIfAborted();
  return owner ? AbortSignal.any([owner, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

interface ProbeResult {
  host: string;
  port: number;
  models: string[];
  headers: Record<string, string>;
  responseBody: unknown;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

async function asyncPool<T>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  let failure: { readonly error: unknown } | undefined;
  try {
    for (const item of items) {
      signal?.throwIfAborted();
      if (failure) throw failure.error;
      const p = fn(item).catch((error: unknown) => { failure ??= { error }; }).finally(() => { executing.delete(p); });
      executing.add(p);
      if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    if (failure) throw failure.error;
    signal?.throwIfAborted();
  } finally {
    await Promise.allSettled(executing);
  }
}

// ---------------------------------------------------------------------------
// Subnet Detection
// ---------------------------------------------------------------------------

/**
 * The widest network a sweep covers. A /16 docker bridge or a /8 corporate
 * network is swept only in the /24 around this computer's own address.
 */
const WIDEST_SWEEP_PREFIX = 24;

function parseIPv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function formatIPv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** RFC 1918 ranges: 10/8, 172.16/12, 192.168/16. */
function isPrivateIPv4(value: number): boolean {
  return (value >>> 24) === 10
    || (value >>> 20) === ((172 << 4) | 1)
    || (value >>> 16) === ((192 << 8) | 168);
}

/** Prefix length of a contiguous dotted netmask; null when it is not one. */
function netmaskPrefix(netmask: string): number | null {
  const mask = parseIPv4(netmask);
  if (mask === null) return null;
  const prefix = 32 - Math.log2(2 ** 32 - mask);
  return Number.isInteger(prefix) ? prefix : null;
}

/**
 * The other hosts of the private networks this computer is attached to, for
 * the network sweep. Only RFC 1918 addresses count (a public, link-local,
 * carrier-grade or VPN-point address yields nothing), the interface's netmask
 * bounds the range, and no network is swept wider than a /24.
 */
export function networkSweepHosts(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const hosts = new Set<string>();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const address = parseIPv4(addr.address);
      if (address === null || !isPrivateIPv4(address)) continue;
      const prefix = Math.max(netmaskPrefix(addr.netmask) ?? WIDEST_SWEEP_PREFIX, WIDEST_SWEEP_PREFIX);
      // A /31 or /32 has no other host to find.
      if (prefix > 30) continue;
      const size = 2 ** (32 - prefix);
      const network = address - (address % size);
      for (let offset = 1; offset < size - 1; offset++) {
        hosts.add(formatIPv4(network + offset));
      }
    }
  }
  return [...hosts];
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probes a single host:port. Returns probe result or null on any failure.
 * Never throws.
 */
async function probeHost(
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<ProbeResult | null> {
  // Attempt 1: /v1/models (OpenAI-compatible)
  const v1Result = await tryFetch(`http://${host}:${port}/v1/models`, signal);
  if (v1Result !== null) {
    const models = extractV1Models(v1Result.body);
    if (models !== null) {
      return { host, port, models, headers: v1Result.headers, responseBody: v1Result.body };
    }
  }

  // Port 11434 with only /api/tags (no /v1/models) cannot be used as an OpenAI-compatible provider.
  return null;
}

interface FetchResult {
  body: unknown;
  headers: Record<string, string>;
}

async function tryFetch(url: string, signal?: AbortSignal): Promise<FetchResult | null> {
  signal?.throwIfAborted();
  try {
    const res = await instrumentedFetch(url, {
      signal: requestSignal(PROBE_TIMEOUT_MS, signal),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    signal?.throwIfAborted();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value.toLowerCase(); });
    return { body, headers };
  } catch (err) {
    logger.debug('discovery probe failed', { url, error: summarizeError(err) });
    return null;
  }
}

function extractV1Models(body: unknown): string[] | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    'data' in body &&
    Array.isArray((body as Record<string, unknown>).data)
  ) {
    const data = (body as Record<string, unknown>).data as unknown[];
    const ids = data
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && 'id' in item && typeof (item as Record<string, unknown>).id === 'string',
      )
      .map((item) => item.id as string);
    return ids;
  }
  return null;
}


// ---------------------------------------------------------------------------
// Server Identification
// ---------------------------------------------------------------------------

/**
 * Which server software answered: the well-known default ports decide on
 * their own (a fixed table); any other port is read from the probe's headers
 * and model ids by routing.local-server-identity. 'unknown' must be a settled
 * choice; an unsettled identity leaves that one server out of the scan.
 */
async function identifyServer(
  port: number,
  headers: Record<string, string>,
  responseBody: unknown,
  signal?: AbortSignal,
): Promise<ServerType> {
  signal?.throwIfAborted();
  if (port === WELL_KNOWN_LOCAL_PORTS.ollama) return 'ollama';
  if (port === WELL_KNOWN_LOCAL_PORTS.jan) return 'jan';
  if (port === WELL_KNOWN_LOCAL_PORTS.gpt4all) return 'gpt4all';
  if (port === WELL_KNOWN_LOCAL_PORTS.koboldCpp) return 'koboldcpp';
  if (port === WELL_KNOWN_LOCAL_PORTS.aphrodite) return 'aphrodite';
  if (port === WELL_KNOWN_LOCAL_PORTS.lmStudio) return 'lm-studio';
  const modelIds = extractV1Models(responseBody) ?? [];
  return readLocalServerIdentity({ port, headers, modelIds }, 'discovery.scanner.server-identity', { signal });
}

// ---------------------------------------------------------------------------
// Model Limits
// ---------------------------------------------------------------------------

export interface ModelLimits {
  /** modelId -> context window tokens. A missing entry means the server did not report one. */
  readonly contextWindows: Record<string, number>;
  /** modelId -> max output tokens. A missing entry means the server did not report one. */
  readonly outputLimits: Record<string, number>;
  /** modelId -> size as the server reports it (Ollama's details.parameter_size, LM Studio's params_string). A missing entry: not reported. */
  readonly sizes: Record<string, string>;
}

/**
 * Per-model metadata requests in flight against one server. Unbounded, a server
 * holding dozens of models answered the late ones after the timeout and their
 * limits were silently missing.
 */
const METADATA_CONCURRENCY = 4;

type JsonObject = Record<string, unknown>;

/** Which response fields carry each limit, most specific first. */
interface LimitFields {
  readonly context: readonly string[];
  readonly output: readonly string[];
}

const VLLM_FIELDS: LimitFields = { context: ['max_model_len'], output: ['max_completion_tokens'] };
const GENERIC_FIELDS: LimitFields = {
  context: ['max_model_len', 'context_length', 'context_window', 'max_context_length'],
  output: ['max_completion_tokens', 'max_output_tokens'],
};

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function firstPositive(data: JsonObject, fields: readonly string[]): number | null {
  for (const field of fields) {
    const value = positiveNumber(data[field]);
    if (value !== null) return value;
  }
  return null;
}

/** Ollama reports a limit in `model_info` ("<arch>.<field>") on newer builds, or in the Modelfile parameters. */
function ollamaLimit(data: JsonObject, infoSuffix: string, parameter: string): number | null {
  const modelInfo = data.model_info;
  if (typeof modelInfo === 'object' && modelInfo !== null) {
    for (const [key, value] of Object.entries(modelInfo)) {
      if (!key.endsWith(infoSuffix)) continue;
      const found = positiveNumber(value);
      if (found !== null) return found;
    }
  }
  if (typeof data.parameters === 'string') {
    const match = new RegExp(`${parameter}\\s+(\\d+)`).exec(data.parameters);
    if (match) return positiveNumber(Number.parseInt(match[1]!, 10));
  }
  return null;
}

/** One metadata request. A refusal, a timeout or a body that is not a JSON object reads as "not reported". */
async function fetchJsonObject(url: string, signal: AbortSignal | undefined, init: RequestInit = {}): Promise<JsonObject | null> {
  try {
    const res = await instrumentedFetch(url, { ...init, signal: requestSignal(METADATA_TIMEOUT_MS, signal) });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as JsonObject : null;
  } catch (err) {
    logger.debug('[Scan] metadata request failed', { url, error: summarizeError(err) });
    return null;
  }
}

/** llama.cpp-style server-wide settings: `default_generation_settings.n_ctx` and `n_predict`. */
async function fetchServerProps(origin: string, signal: AbortSignal | undefined): Promise<{ context: number | null; output: number | null }> {
  const data = await fetchJsonObject(`${origin}/props`, signal);
  const settings = data?.default_generation_settings;
  if (typeof settings !== 'object' || settings === null) return { context: null, output: null };
  const values = settings as JsonObject;
  return { context: positiveNumber(values.n_ctx), output: positiveNumber(values.n_predict) };
}

/**
 * Reads the context window and output limit of each model with each metadata
 * request made once; `wantOutput: false` skips requests that could only supply
 * output limits.
 */
async function readModelLimits(
  host: string,
  port: number,
  serverType: ServerType,
  models: string[],
  wantOutput: boolean,
  signal?: AbortSignal,
): Promise<ModelLimits> {
  signal?.throwIfAborted();
  const origin = `http://${host}:${port}`;
  const contextWindows: Record<string, number> = {};
  const outputLimits: Record<string, number> = {};
  const sizes: Record<string, string> = {};
  const record = (model: string, context: number | null, output: number | null, via = ''): void => {
    if (context !== null) contextWindows[model] = context;
    if (output !== null && wantOutput) outputLimits[model] = output;
    const parts: string[] = [];
    if (context !== null) parts.push(`context ${context} tokens`);
    if (output !== null && wantOutput) parts.push(`output limit ${output} tokens`);
    if (parts.length > 0) logger.info(`[Scan] ${model}: ${parts.join(', ')}${via}`);
  };
  const eachModel = (read: (model: string) => Promise<void>): Promise<void> =>
    asyncPool(METADATA_CONCURRENCY, models, read, signal);

  switch (serverType) {
    case 'ollama': {
      await eachModel(async (model) => {
        const data = await fetchJsonObject(`${origin}/api/show`, signal, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
        });
        if (data) record(model, ollamaLimit(data, 'context_length', 'num_ctx'), ollamaLimit(data, 'num_predict', 'num_predict'));
        // The same answer carries the model's size in its details.
        const details = data?.details;
        const size = typeof details === 'object' && details !== null ? (details as JsonObject).parameter_size : undefined;
        if (typeof size === 'string' && size.trim() !== '') sizes[model] = size.trim();
      });
      break;
    }

    case 'llamacpp': {
      // llama.cpp typically serves one model; its server-wide settings apply to all.
      const props = await fetchServerProps(origin, signal);
      for (const model of models) record(model, props.context, props.output);
      break;
    }

    default: {
      let haveContext = false;
      if (serverType === 'lm-studio') {
        // LM Studio's rich endpoint (/api/v1/models) carries max_context_length per model;
        // the generic per-model reading below is the fallback for context and the source of output limits.
        const listedSizes = new Map<string, string>();
        const discovered = await discoverContextWindows(`${origin}/v1`, undefined, signal, listedSizes);
        for (const [modelId, size] of listedSizes) if (models.includes(modelId) || models.length === 0) sizes[modelId] = size;
        for (const [modelId, ctx] of discovered) {
          if (models.includes(modelId) || models.length === 0) record(modelId, ctx, null, ' (via discoverContextWindows)');
        }
        haveContext = Object.keys(contextWindows).length > 0;
        if (haveContext && !wantOutput) break;
        signal?.throwIfAborted();
      }

      const fields = serverType === 'vllm' ? VLLM_FIELDS : GENERIC_FIELDS;
      await eachModel(async (model) => {
        const data = await fetchJsonObject(`${origin}/v1/models/${encodeURIComponent(model)}`, signal);
        if (data) record(model, haveContext ? null : firstPositive(data, fields.context), firstPositive(data, fields.output));
      });
      if (serverType === 'vllm') break;

      // A llama.cpp-style server behind another port answers /props for whatever the per-model reading missed.
      const needContext = Object.keys(contextWindows).length === 0;
      const needOutput = wantOutput && Object.keys(outputLimits).length === 0;
      if (models.length > 0 && (needContext || needOutput)) {
        signal?.throwIfAborted();
        const props = await fetchServerProps(origin, signal);
        for (const model of models) {
          record(model, needContext ? props.context : null, needOutput ? props.output : null, ' (via /props fallback)');
        }
      }
      break;
    }
  }

  signal?.throwIfAborted();
  return { contextWindows, outputLimits, sizes };
}

/**
 * Queries a discovered server for the context window and output limit of each
 * of its models, making each metadata request once.
 */
export function fetchModelLimits(
  host: string,
  port: number,
  serverType: ServerType,
  models: string[],
  signal?: AbortSignal,
): Promise<ModelLimits> {
  return readModelLimits(host, port, serverType, models, true, signal);
}

/**
 * Queries a discovered server for actual context window sizes of its models.
 * Returns a map of modelId -> contextWindow. Missing entries mean the server
 * didn't report a context length for that model.
 */
export async function fetchModelContextWindows(
  host: string,
  port: number,
  serverType: ServerType,
  models: string[],
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  return (await readModelLimits(host, port, serverType, models, false, signal)).contextWindows;
}

// ---------------------------------------------------------------------------
// Server Name
// ---------------------------------------------------------------------------

const SERVER_DISPLAY_NAMES: Record<string, string> = {
  'ollama': 'Ollama',
  'lm-studio': 'LM Studio',
  'vllm': 'vLLM',
  'llamacpp': 'llama.cpp',
  'localai': 'LocalAI',
  'tgi': 'TGI',
  'jan': 'Jan',
  'gpt4all': 'GPT4All',
  'koboldcpp': 'KoboldCPP',
  'aphrodite': 'Aphrodite',
};

/**
 * Builds a human-friendly provider name.
 */
function buildServerName(serverType: ServerType, host: string, port: number): string {
  const isLocal = host === '127.0.0.1' || host === 'localhost';

  if (serverType === 'unknown') {
    return `local-${host}:${port}`;
  }

  const display = SERVER_DISPLAY_NAMES[serverType]! ?? serverType;
  return isLocal ? display : `${display} (${host})`;
}

// ---------------------------------------------------------------------------
// Scan Hosts
// ---------------------------------------------------------------------------

/**
 * Scans a list of hosts across all known ports.
 */
export async function scanHosts(
  hosts: string[],
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ servers: DiscoveredServer[]; skipped: SkippedServer[] }> {
  signal?.throwIfAborted();
  type Probe = { host: string; port: number };
  const probes: Probe[] = [];
  for (const host of hosts) {
    for (const port of KNOWN_PORTS) {
      probes.push({ host, port });
    }
  }

  const total = probes.length;
  let completed = 0;
  const servers: DiscoveredServer[] = [];
  const skipped: SkippedServer[] = [];

  await asyncPool(MAX_CONCURRENT_PROBES, probes, async ({ host, port }) => {
    const result = await probeHost(host, port, signal);
    signal?.throwIfAborted();
    completed++;
    onProgress?.(completed, total);

    if (result === null) return;

    // One server that cannot be identified or read drops out alone; the others
    // (above all the ones on this computer) are still found. Only cancellation ends the scan.
    try {
      const serverType = await identifyServer(port, result.headers, result.responseBody, signal);
      const name = buildServerName(serverType, host, port);
      const baseURL = `http://${host}:${port}/v1`;
      const limits = await fetchModelLimits(host, port, serverType, result.models, signal);
      signal?.throwIfAborted();
      servers.push({
        name, host, port, baseURL, models: result.models, serverType,
        modelContextWindows: limits.contextWindows, modelOutputLimits: limits.outputLimits,
        ...(Object.keys(limits.sizes).length > 0 ? { modelSizes: limits.sizes } : {}),
      });
      logger.info(`[Scan] Found ${name} at ${host}:${port} (${result.models.length} models)`);
    } catch (error) {
      signal?.throwIfAborted();
      const reason = summarizeError(error);
      skipped.push({ host, port, reason });
      logger.info(`[Scan] ${host}:${port} answered but was left out of this scan`, { error: reason });
    }
  }, signal);

  return { servers, skipped };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Whether this process has looked for model servers on this computer:
 * 'off' before any scan started, 'running' while one runs, 'done' once one
 * finished (first run's "looking for models on this computer…" / "none
 * found"). A scan that was cancelled or failed leaves it as it was before.
 */
export type LocalScanState = 'off' | 'running' | 'done';
let localScan: LocalScanState = 'off';
let localScansRunning = 0;

export function localScanState(): LocalScanState {
  return localScan;
}

async function trackLocalScan<T>(run: () => Promise<T>): Promise<T> {
  const before = localScan;
  localScansRunning += 1;
  if (localScan !== 'done') localScan = 'running';
  try {
    const result = await run();
    localScan = 'done';
    return result;
  } catch (error) {
    if (localScan !== 'done' && localScansRunning === 1) localScan = before;
    throw error;
  } finally {
    localScansRunning -= 1;
  }
}

/**
 * Scans only localhost (fast, ~100ms).
 */
export async function scanLocalhost(signal?: AbortSignal): Promise<ScanResult> {
  return trackLocalScan(() => scanLocalhostOnce(signal));
}

async function scanLocalhostOnce(signal?: AbortSignal): Promise<ScanResult> {
  const start = Date.now();
  const { servers, skipped } = await scanHosts(['127.0.0.1'], undefined, signal);
  return {
    servers,
    skipped,
    scannedHosts: 1,
    scannedPorts: KNOWN_PORTS.length,
    durationMs: Date.now() - start,
  };
}

/**
 * Network sweep: localhost first, then the other hosts of the private networks
 * this computer is attached to (see `networkSweepHosts`). Run it only when the
 * person asked for the network; `scanLocalhost` covers this computer alone.
 * Returns merged, deduplicated results.
 */
export async function scan(
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ScanResult> {
  return trackLocalScan(() => scanNetwork(onProgress, signal));
}

async function scanNetwork(
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const start = Date.now();
  const local = await scanHosts(['127.0.0.1'], undefined, signal);

  const networkHosts = networkSweepHosts();
  const network = networkHosts.length > 0
    ? await scanHosts(networkHosts, onProgress, signal)
    : { servers: [], skipped: [] };
  const localhostServers = local.servers;
  const networkServers = network.servers;

  // Merge and deduplicate by host:port
  const seen = new Set<string>();
  const allServers: DiscoveredServer[] = [];
  for (const server of [...localhostServers, ...networkServers]) {
    const key = `${server.host}:${server.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      allServers.push(server);
    }
  }

  return {
    servers: allServers,
    skipped: [...local.skipped, ...network.skipped],
    scannedHosts: 1 + networkHosts.length,
    scannedPorts: KNOWN_PORTS.length,
    durationMs: Date.now() - start,
  };
}
