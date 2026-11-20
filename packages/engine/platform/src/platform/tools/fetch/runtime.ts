import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import type { LocalhostFetchApproval, LocalhostFetchPermit } from '../../runtime/permissions/localhost-fetch-approval.js';
import { logger } from '../../utils/logger.js';
import { currentExecutionMode, isInvocationAdmitted, isYoloExecution } from '../../gate/execution-context.js';
import { captureProjectionStructure, describeUnexpectedToolError } from '../input-projection.js';
import { hasDifferentFetchInvocation, isAdmittedFetchRequest, runFetchInvocation, runFetchRequest, withoutFetchInvocation } from './invocation.js';
import type { Tool, ToolDefinition } from '../../types/tools.js';
import { FETCH_TOOL_SCHEMA } from './schema.js';
import type { FetchInput, FetchUrlInput, FetchAuthInput, FetchExtractMode, FetchVerbosity, FetchSanitizeMode } from './schema.js';
import type { FetchOutput, FetchUrlResult } from './types.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { applySanitizer, resolveSanitizeMode } from './sanitizer.js';
import {
  ALLOWED_PRIVATE_HOSTS_SETTING,
  classifyHostTrustTier,
  emitSsrfDeny,
  emitHostTrustTier,
  extractHostname,
  writtenPrivateHostAllowed,
  type TrustTierConfig,
} from './trust-tiers.js';
import { applyExtractDetailed, sniffContentType } from './extract.js';
import { headersForOtherOrigin } from './redirect-headers.js';
import { assertHttpScheme, resolveCheckedAddresses } from './pinned-request.js';
import { isCallerReachablePrivateAddress, pinnedFetch, type HostResolver } from '../../runtime/network/destination.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { createTimeoutController, sanitizeUrlForLog } from '../../utils/fetch-with-timeout.js';
import { recordFetchedPagesAsUntrusted } from './untrusted-ingest.js';
import { toRecord } from '../../utils/record-coerce.js';
import { mapWithConcurrency, sleep } from '../../utils/concurrency.js';

export interface FetchRuntimeDeps {
  readonly serviceRegistry?: Pick<ServiceRegistry, 'resolveAuthFor'> | null | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  /**
   * Default sanitize mode applied when a fetch call omits sanitize_mode.
   * Sourced from config (fetch.sanitizeMode) by platform runtime services; a per-call
   * sanitize_mode still overrides. Absent → the built-in 'safe-text' default.
   * A function is read on every call, so a changed setting applies to the next fetch.
   */
  readonly defaultSanitizeMode?: FetchSanitizeMode | (() => FetchSanitizeMode | undefined) | undefined;
  /**
   * Trusted hosts (from config fetch.trustedHosts), the only source: a call
   * cannot name trusted hosts, since trust that lifts sanitization comes from
   * configuration, not from the model asking for it. A function is read on
   * every call.
   */
  readonly defaultTrustedHosts?: readonly string[] | (() => readonly string[] | undefined) | undefined;
  /**
   * Default blocked hosts (from config fetch.blockedHosts). Merged with per-call
   * blocked_hosts. A function is read on every call.
   */
  readonly defaultBlockedHosts?: readonly string[] | (() => readonly string[] | undefined) | undefined;
  /**
   * Cooperative cancellation: an externally-supplied signal,
   * combined with each request's own per-URL timeout signal via
   * `AbortSignal.any`. Optional and additive, omitted, behavior is
   * unchanged from before this field existed.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Resolves a host to every A and AAAA answer before each request hop; each
   * answer is checked against the refused address ranges and the request is
   * pinned to the checked address (pinned-request.ts). Absent: the system
   * resolver.
   */
  readonly resolveHost?: HostResolver | undefined;
  /**
   * Interactive-only read of the saved localhost approval (fetch.allowLocalhost).
   * Autonomous operations always require fresh exact-hop admission.
   */
  readonly isLocalhostAllowed?: (() => boolean) | undefined;
  /**
   * Private-network hosts the owner lets the fetch tool reach when a call
   * writes them (fetch.allowedPrivateHosts, the owner's own settings). Read on
   * every call. Never applies to a redirect target.
   */
  readonly allowedPrivateHosts?: (() => readonly string[]) | undefined;
  /**
   * The runtime composition returns a live exact-hop permit for autonomous
   * operations, or a legacy interactive boolean grant. A boolean can never
   * authorize an autonomous socket. Missing admission fails closed.
   */
  readonly approveLocalhostFetch?: LocalhostFetchApproval | undefined;
}

interface CacheEntry {
  data: FetchUrlResult;
  timestamp: number;
  ttl: number;
}

const MAX_CACHE_SIZE = 500;
const MAX_PARALLEL_FETCHES = 5;
const MAX_REDIRECTS = 10;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Response bytes read when a call sets no max_content_length; 0 opts out of the cap. */
const DEFAULT_MAX_CONTENT_BYTES = 5_000_000;
const CANCELLED_MESSAGE = 'Cancelled: the call was cancelled before this request finished. Not a timeout; do not retry with a larger timeout_ms.';
const CANCELLED_NOT_SENT = 'Cancelled: the call was cancelled before this request was sent. Nothing was sent for this entry.';

export class FetchRuntimeService {
  private readonly responseCache = new Map<string, CacheEntry>();
  private cacheWriteCount = 0;

  getCached(key: string, cacheTtlSeconds: number): FetchUrlResult | null {
    const entry = this.responseCache.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.timestamp) / 1000 >= cacheTtlSeconds) return null;
    return { ...entry.data, from_cache: true };
  }

  cacheSet(key: string, entry: CacheEntry): void {
    this.cacheWriteCount++;
    if (this.cacheWriteCount % 50 === 0) {
      const now = Date.now();
      for (const [cachedKey, cachedValue] of this.responseCache) {
        if (now - cachedValue.timestamp > cachedValue.ttl * 1000) {
          this.responseCache.delete(cachedKey);
        }
      }
    }
    if (this.responseCache.size >= MAX_CACHE_SIZE) {
      const oldest = this.responseCache.keys().next().value;
      if (oldest !== undefined) this.responseCache.delete(oldest);
    }
    this.responseCache.set(key, entry);
  }

  async execute(input: FetchInput, deps: FetchRuntimeDeps = {}): Promise<FetchOutput> {
    currentExecutionMode();
    if (hasDifferentFetchInvocation(input)) return withoutFetchInvocation(() => this.execute(input, deps));
    const globalExtract: FetchExtractMode = input.extract ?? 'raw';
    const parallel: boolean = input.parallel !== false;
    const verbosity: FetchVerbosity = input.verbosity ?? 'standard';
    const cacheTtlSeconds = input.cache_ttl_seconds ?? 0;
    const rateLimitMs = input.rate_limit_ms ?? 0;
    const maxContentLength = input.max_content_length;



    const defaultSanitizeMode = typeof deps.defaultSanitizeMode === 'function' ? deps.defaultSanitizeMode() : deps.defaultSanitizeMode;
    const defaultTrustedHosts = typeof deps.defaultTrustedHosts === 'function' ? deps.defaultTrustedHosts() : deps.defaultTrustedHosts;
    const defaultBlockedHosts = typeof deps.defaultBlockedHosts === 'function' ? deps.defaultBlockedHosts() : deps.defaultBlockedHosts;
    const sanitizeMode = resolveSanitizeMode(input.sanitize_mode ?? defaultSanitizeMode);
    const trustTierConfig: TrustTierConfig = {
      trustedHosts: mergeHostLists(defaultTrustedHosts, undefined),
      blockedHosts: mergeHostLists(defaultBlockedHosts, input.blocked_hosts),
    };

    const fetchOpts: FetchOneOptions = {
      globalExtract,
      verbosity,
      cacheTtlSeconds,
      maxContentLength,
      sanitizeMode,
      trustTierConfig,
      deps,
    };

    const wallStart = performance.now();
    let results: FetchUrlResult[];

    // A malformed URL is that entry's error; it must not discard the results
    // of requests already sent in the same batch.
    const runOne = async (urlInput: FetchUrlInput): Promise<FetchUrlResult> => {
      let url: string;
      try {
        url = buildUrl(urlInput.url, urlInput.params);
        new URL(url);
      } catch {
        return { url: urlInput.url, error: `Invalid URL: ${urlInput.url}. Nothing was sent for this entry; pass an absolute http(s) URL.` };
      }
      try {
        assertHttpScheme(url);
      } catch (error) {
        return { url: urlInput.url, error: error instanceof Error ? error.message : String(error) };
      }
      return runFetchRequest(input, urlInput, url, () => fetchOne(urlInput, fetchOpts, this));
    };

    // A rate limit is a request for pacing, so it runs the URLs one after another.
    if (parallel && rateLimitMs === 0) {
      results = await mapWithConcurrency(input.urls, MAX_PARALLEL_FETCHES, runOne);
    } else {
      results = [];
      for (let i = 0; i < input.urls.length; i++) {
        const urlInput = input.urls[i]!;
        if (i > 0 && rateLimitMs > 0) {
          await sleep(rateLimitMs, deps.signal ? { signal: deps.signal } : {});
        }
        if (deps.signal?.aborted) {
          results.push({ url: urlInput.url, error: CANCELLED_NOT_SENT, cancelled: true });
          continue;
        }
        results.push(await runOne(urlInput));
      }
    }

    // Page text entered the conversation here, so the ledger is told, with the
    // text, not merely the fact. This tool recorded nothing at all before; see
    // ./untrusted-ingest.ts for the gap that left and why the text is the part
    // that keeps this from refusing everything.
    recordFetchedPagesAsUntrusted(results);

    const totalMs = Math.round(performance.now() - wallStart);
    const succeeded = results.filter((result) => result.error === undefined).length;
    const failed = results.filter((result) => result.error !== undefined).length;
    const httpErrors = results.filter((result) => result.error === undefined && (result.status ?? 0) >= 400).length;

    // A call where nothing came back usable (every URL failed, or every response was an HTTP error) failed.
    const usable = succeeded - httpErrors;
    const output: FetchOutput = {
      success: results.length === 0 || usable > 0,
      summary: {
        total: results.length,
        succeeded,
        failed,
        ...(httpErrors > 0 ? { http_errors: httpErrors } : {}),
        total_ms: totalMs,
      },
    };

    if (verbosity !== 'count_only') {
      output.results = results;
    }

    return output;
  }
}

export async function executeFetchInput(input: FetchInput, deps: FetchRuntimeDeps = {}): Promise<FetchOutput> {
  return new FetchRuntimeService().execute(input, deps);
}

function buildUrl(base: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return base;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`Invalid URL: ${base}`);
  }
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}


interface FetchOneOptions {
  globalExtract: FetchExtractMode;
  verbosity: FetchVerbosity;
  cacheTtlSeconds: number;
  maxContentLength?: number | undefined;
  sanitizeMode: FetchSanitizeMode;
  trustTierConfig: TrustTierConfig;
  deps: FetchRuntimeDeps;
}

interface PreparedFetchRequest {
  headers: Record<string, string>;
  /** Lower-cased names of the headers the tool set from `auth` or `service`. */
  credentialHeaders: Set<string>;
  body?: string | Uint8Array | FormData | undefined;
}

function applyAuthHeaders(headers: Record<string, string>, auth: FetchAuthInput): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
    case 'basic': {
      const user = auth.username ?? '';
      const pass = auth.password ?? '';
      if (user === '' && pass === '') break;
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'api-key': {
      const headerName = auth.header ?? 'X-API-Key';
      if (auth.key) {
        headers[headerName] = auth.key;
      }
      break;
    }
  }
}

class CredentialMissingError extends Error {}

function missingAuthField(auth: FetchAuthInput): string {
  switch (auth.type) {
    case 'bearer': return 'token';
    case 'api-key': return 'key';
    default: return 'username or password';
  }
}

function encodeFormBodyData(bodyData: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(bodyData)) {
    params.append(key, value);
  }
  return params.toString();
}

async function fetchOneRaw(
  urlInput: FetchUrlInput,
  headers: Record<string, string>,
  method: string,
  body: string | Uint8Array | FormData | undefined,
  effectiveUrl: string,
  trustTierConfig: TrustTierConfig,
  localhostApproved: boolean,
  credentialHeaders: ReadonlySet<string>,
  externalSignal: AbortSignal | undefined,
  resolveHost: HostResolver | undefined,
  deps: FetchRuntimeDeps,
  permits: LocalhostFetchPermit[],
): Promise<FetchedResponse> {
  const { signal: timeoutSignal, dispose } = createTimeoutController(urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  try {
    // Redirect chains are ALWAYS validated hop-by-hop, host blocking is
    // absolute and does not depend on the sanitization mode or kill switch.
    return await fetchWithValidatedRedirects({
      url: effectiveUrl,
      method,
      headers,
      body,
      signal,
      trustTierConfig,
      localhostApproved,
      credentialHeaders,
      resolveHost,
      deps,
      permits,
      originalRequest: urlInput,
    });
  } finally {
    dispose();
  }
}

/**
 * A response with where it came from. The final hop is fetched at its checked
 * address, so `response.url` names an IP; the hop URL as written is tracked
 * here instead.
 */
interface FetchedResponse {
  readonly response: Response;
  readonly finalUrl: string;
  readonly redirects: number;
  /** Request headers not sent on after a redirect to another origin. */
  readonly droppedHeaders: readonly string[];
}

async function fetchWithValidatedRedirects(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | FormData | undefined;
  signal: AbortSignal;
  trustTierConfig: TrustTierConfig;
  localhostApproved: boolean;
  deps: FetchRuntimeDeps;
  permits: LocalhostFetchPermit[];
  originalRequest: FetchUrlInput;
  credentialHeaders: ReadonlySet<string>;
  resolveHost?: HostResolver | undefined;
}): Promise<FetchedResponse> {
  let currentUrl = input.url;
  let currentMethod = input.method;
  let currentBody = input.body;
  let currentHeaders = { ...input.headers };
  const droppedHeaders: string[] = [];
  const autonomousLocalhostStart = currentExternalOperationSource() !== undefined
    && classifyHostTrustTier(extractHostname(input.url) ?? '', input.trustTierConfig).tier === 'localhost';

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const operation = currentExternalOperationSource();
    const priorPermits = [...input.permits];
    const assertCurrent = () => {
      currentExecutionMode();
      input.signal.throwIfAborted(); operation?.signal?.throwIfAborted(); operation?.assertCurrent();
      for (const prior of priorPermits) prior.assertCurrent();
    };
    assertCurrent();
    const host = extractHostname(currentUrl);
    const local = host !== null && classifyHostTrustTier(host, input.trustTierConfig).tier === 'localhost';
    let permit: LocalhostFetchPermit | undefined;
    const admittedInitialRequest = redirectCount === 0 && isAdmittedFetchRequest(currentUrl);
    // YOLO and an admitted call skip only the localhost prompt, and only for the
    // host the caller wrote; a redirect target is the server's choice.
    // The owner's fetch.allowLocalhost covers every localhost hop, in a model's run too, with no admission request.
    let localhostApproved = input.localhostApproved || (local && (input.deps.isLocalhostAllowed?.() ?? false))
      || (local && redirectCount === 0 && (isYoloExecution() || admittedInitialRequest));
    if (local && operation && !localhostApproved) {
      const request: FetchUrlInput = {
        url: currentUrl, method: currentMethod as FetchUrlInput['method'], headers: { ...currentHeaders },
        ...(typeof currentBody === 'string' ? { body: currentBody } : {}),
        ...(currentBody instanceof Uint8Array ? { body_base64: Buffer.from(currentBody).toString('base64') } : {}),
        ...(currentBody instanceof FormData ? { body_type: 'multipart' as const,
          body_data: Object.fromEntries([...currentBody.entries()].map(([key, value]) => [key, String(value)])) } : {}),
      };
      const approved = await input.deps.approveLocalhostFetch?.({ url: currentUrl, host: host!, request,
        originalRequest: input.originalRequest, credentialHeaders: [...input.credentialHeaders] }, { signal: input.signal, assertCurrent });
      if (!approved) {
        throw new Error(`Request blocked: the fetch to the localhost host "${host}" was not admitted for this run, and localhost fetches are not allowed (fetch.allowLocalhost is off). `
          + 'Ask the owner to set fetch.allowLocalhost to true, or fetch a URL that is not on this machine.');
      }
      // `true` is the person's own answer to the one-tap ask (saved as fetch.allowLocalhost); a permit is one admitted hop.
      if (approved !== true) {
        permit = approved;
        input.permits.push(permit);
        assertCurrent();
        permit.assertCurrent();
      }
      localhostApproved = true;
    }
    // Only the host the caller wrote may be a private-network address; a redirect target never.
    const privateAllowed = redirectCount === 0 && host !== null && writtenPrivateHostAllowed(host, {
      callerAdmitted: isYoloExecution() || admittedInitialRequest,
      allowedPrivateHosts: input.deps.allowedPrivateHosts?.() ?? [],
    });
    // Final claim follows checked DNS. The live guard also protects every address retry.
    const addresses = await resolveCheckedAddresses(currentUrl, {
      trustTierConfig: input.trustTierConfig, localhostApproved, resolveHost: input.resolveHost,
      callerWroteHost: redirectCount === 0, privateAllowed,
    });
    assertCurrent();
    permit?.assertCurrent();
    permit?.claim();
    const guard = () => { assertCurrent(); permit?.assertCurrent(); if (admittedInitialRequest) isAdmittedFetchRequest(currentUrl); };
    const response = await pinnedFetch(currentUrl, {
      method: currentMethod,
      ...(Object.keys(currentHeaders).length > 0 ? { headers: currentHeaders as HeadersInit } : {}),
      ...(currentBody !== undefined ? { body: currentBody } : {}),
      signal: AbortSignal.any([input.signal, ...input.permits.map(owned => owned.signal)]),
      redirect: 'manual',
    } as RequestInit, addresses, 'default', guard);
    guard();

    const settled = { response, finalUrl: currentUrl, redirects: redirectCount, droppedHeaders };
    if (!isRedirectStatus(response.status)) return settled;

    const location = response.headers.get('location');
    if (!location) return settled;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`Too many redirects after ${MAX_REDIRECTS} hops`);
    }

    const nextUrl = new URL(location, currentUrl).toString();
    if (!/^https?:$/.test(new URL(nextUrl).protocol)) {
      throw new Error(`Redirect blocked: the server redirected to a ${new URL(nextUrl).protocol} URL; only http(s) targets are followed`);
    }
    const nextHost = extractHostname(nextUrl);
    if (nextHost !== null) {
      const trustResult = classifyHostTrustTier(nextHost, input.trustTierConfig);
      emitHostTrustTier(nextHost, nextUrl, trustResult);
      // A server may not choose an internal destination in any mode.
      if (trustResult.tier === 'blocked') {
        if (trustResult.isSsrf) emitSsrfDeny(nextHost, nextUrl, trustResult.reason);
        throw new Error(`Redirect blocked: ${trustResult.reason}`);
      }
      if (trustResult.tier === 'localhost' && !input.localhostApproved && !autonomousLocalhostStart) {
        // A public origin redirecting into loopback is an SSRF vector; only an
        // approved-for-this-project localhost target may be followed.
        emitSsrfDeny(nextHost, nextUrl, trustResult.reason);
        throw new Error(`Redirect blocked: ${trustResult.reason}`);
      }
    }

    if (shouldRewriteRedirectToGet(response.status, currentMethod)) {
      currentMethod = 'GET';
      currentBody = undefined;
      currentHeaders = removeContentHeaders(currentHeaders);
    }
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      const followed = await headersForOtherOrigin(currentHeaders, input.credentialHeaders, input.signal);
      currentHeaders = followed.headers;
      droppedHeaders.push(...followed.dropped);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects after ${MAX_REDIRECTS} hops`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function shouldRewriteRedirectToGet(status: number, method: string): boolean {
  const upper = method.toUpperCase();
  return status === 303 || ((status === 301 || status === 302) && upper === 'POST');
}

function removeContentHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      const normalized = key.toLowerCase();
      return normalized !== 'content-type' && normalized !== 'content-length';
    }),
  );
}

async function prepareFetchRequest(
  urlInput: FetchUrlInput,
  extractMode: FetchExtractMode,
  deps: FetchRuntimeDeps,
): Promise<PreparedFetchRequest> {
  // The credentials the tool adds itself, kept apart so a cross-origin
  // redirect drops them by where they came from (redirect-headers.ts).
  const toolHeaders: Record<string, string> = {};
  if (urlInput.auth) {
    applyAuthHeaders(toolHeaders, urlInput.auth);
    if (Object.keys(toolHeaders).length === 0) {
      throw new CredentialMissingError(`auth type "${urlInput.auth.type}" has no ${missingAuthField(urlInput.auth)}, so no credential would be sent. Nothing was sent for this entry.`);
    }
  } else if (urlInput.service) {
    // A named service's credential goes only to that service's own origin.
    const answer = await deps.serviceRegistry?.resolveAuthFor(urlInput.service, urlInput.url);
    if (answer && 'refused' in answer) throw new CredentialMissingError(answer.refused);
    const resolved = answer?.headers;
    if (!resolved || Object.keys(resolved).length === 0) {
      throw new CredentialMissingError(`service "${urlInput.service}" has no credential (unknown service, no stored secret, or no service registry). Nothing was sent for this entry; register the service or store its secret.`);
    }
    Object.assign(toolHeaders, resolved);
  }
  const headers: Record<string, string> = { ...(urlInput.headers ?? {}), ...toolHeaders };
  const credentialHeaders = new Set(Object.keys(toolHeaders).map((name) => name.toLowerCase()));

  // The caller's `extract: 'json'` states it wants JSON; Accept is how HTTP
  // asks the server for it (RFC 9110 §12.5.1). A caller's own Accept wins.
  if (extractMode === 'json' && !Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
    headers['Accept'] = 'application/json';
  }

  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  let body: string | Uint8Array | FormData | undefined;

  if (urlInput.body_type === 'multipart' && urlInput.body_data) {
    const form = new FormData();
    for (const [k, v] of Object.entries(urlInput.body_data)) {
      form.append(k, v);
    }
    body = form;
  } else if (urlInput.body_type === 'form' && urlInput.body_data) {
    body = encodeFormBodyData(urlInput.body_data);
    if (!hasContentType) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else if (urlInput.body_base64 !== undefined) {
    // The decoded bytes go out as bytes; decoding them as text would replace
    // any binary payload with U+FFFD.
    body = new Uint8Array(Buffer.from(urlInput.body_base64, 'base64'));
    if (!hasContentType) {
      headers['Content-Type'] = urlInput.body_type === 'form'
        ? 'application/x-www-form-urlencoded'
        : urlInput.body_type === 'json' ? 'application/json' : 'application/octet-stream';
    }
  } else if (urlInput.body !== undefined) {
    body = urlInput.body;
    // A raw body is sent as written, with no Content-Type of the tool's choosing.
    if (!hasContentType && urlInput.body_type !== 'raw') {
      headers['Content-Type'] = urlInput.body_type === 'form'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }
  }

  return { headers, credentialHeaders, body };
}

function buildFetchResultBase(
  urlInput: FetchUrlInput,
  response: Response,
  durationMs: number,
): FetchUrlResult {
  return {
    url: urlInput.url,
    status: response.status,
    statusText: response.statusText,
    duration_ms: durationMs,
  };
}

async function fetchOne(
  urlInput: FetchUrlInput,
  opts: FetchOneOptions,
  runtime: FetchRuntimeService,
): Promise<FetchUrlResult> {
  const { globalExtract, verbosity, maxContentLength, sanitizeMode, trustTierConfig, deps } = opts;
  // Credential-bearing calls never share processed responses, including rotated service credentials.
  let urlHasCredentials = true;
  try { const parsed = new URL(urlInput.url); urlHasCredentials = !!(parsed.username || parsed.password); } catch { /* Invalid URLs bypass caching and report their fetch error below. */ }
  const credentialed = !!(urlInput.auth || urlInput.service || Object.keys(urlInput.headers ?? {}).length || urlHasCredentials);
  const cacheTtlSeconds = credentialed || currentExternalOperationSource() ? 0 : opts.cacheTtlSeconds;
  const extractMode: FetchExtractMode = urlInput.extract ?? globalExtract;
  const method = urlInput.method ?? 'GET';
  const effectiveMaxContent = urlInput.max_content_length ?? maxContentLength ?? DEFAULT_MAX_CONTENT_BYTES;

  const effectiveUrl = buildUrl(urlInput.url, urlInput.params);
  // Content sanitization respects the kill switch; host blocking does not.
  const sanitizationEnabled = deps.featureFlags?.isEnabled('fetch-sanitization') ?? true;
  const effectiveSanitizeModeForBlocked = sanitizationEnabled ? sanitizeMode : 'none';

  const hostname = extractHostname(urlInput.url);
  let initialTrustResult: ReturnType<typeof classifyHostTrustTier> | null = null;
  let localhostApproved = false;
  if (hostname !== null) {
    initialTrustResult = classifyHostTrustTier(hostname, trustTierConfig);
    emitHostTrustTier(hostname, urlInput.url, initialTrustResult);

    // Metadata, link-local and other internal addresses are refused in every
    // mode. A private-network address the caller wrote (a LAN device, a
    // container, a VPN peer) is reachable when the owner lists it in
    // fetch.allowedPrivateHosts or, written as an IP address, when the call
    // runs in YOLO or was admitted; the refusal names the setting.
    const writtenAddress = hostname.replace(/^\[|\]$/g, '');
    const privateReachable = initialTrustResult.tier === 'blocked' && initialTrustResult.isSsrf
      && isCallerReachablePrivateAddress(writtenAddress);
    if (privateReachable && writtenPrivateHostAllowed(hostname, {
      callerAdmitted: isYoloExecution() || isAdmittedFetchRequest(effectiveUrl),
      allowedPrivateHosts: deps.allowedPrivateHosts?.() ?? [],
    })) {
      initialTrustResult = { tier: 'unknown', reason: `host "${hostname}" is a private-network address the caller wrote, allowed for this call`, isSsrf: false };
    } else if (initialTrustResult.tier === 'blocked') {
      if (initialTrustResult.isSsrf) {
        emitSsrfDeny(hostname, urlInput.url, initialTrustResult.reason);
      }
      const next = privateReachable
        ? `. To reach it, the owner can add "${writtenAddress}" to ${ALLOWED_PRIVATE_HOSTS_SETTING} in their own settings (a project file cannot set it).`
        : '';
      return {
        url: urlInput.url,
        error: `Request blocked: ${initialTrustResult.reason}${next}`,
        host_trust_tier: 'blocked',
        sanitization_tier: effectiveSanitizeModeForBlocked,
      };
    }

    // Loopback dev servers: allowed for this project, or a one-tap ask that
    // persists the approval; otherwise refused with the setting named. In a
    // model's run the owner's setting allows it the same way; without it each
    // hop is admitted on its own.
    if (initialTrustResult.tier === 'localhost' && currentExternalOperationSource() && (deps.isLocalhostAllowed?.() ?? false)) {
      localhostApproved = true;
    }
    if (initialTrustResult.tier === 'localhost' && !currentExternalOperationSource()) {
      localhostApproved = isYoloExecution() || isAdmittedFetchRequest(effectiveUrl) || (deps.isLocalhostAllowed?.() ?? false);
      if (!localhostApproved && deps.approveLocalhostFetch) {
        try {
          localhostApproved = await raceSignal(
            deps.approveLocalhostFetch({ url: effectiveUrl, host: hostname, originalRequest: urlInput }),
            deps.signal,
          ) === true;
        } catch {
          localhostApproved = false;
        }
        if (deps.signal?.aborted) {
          return { url: urlInput.url, error: CANCELLED_NOT_SENT, cancelled: true, host_trust_tier: 'localhost' };
        }
      }
      if (!localhostApproved) {
        return {
          url: urlInput.url,
          error: `Request blocked: localhost fetch to "${hostname}" is not approved. `
            + 'Approve the localhost fetch ask, or set fetch.allowLocalhost to true in your own settings (a project settings file cannot turn it on).',
          host_trust_tier: 'localhost',
          sanitization_tier: effectiveSanitizeModeForBlocked,
        };
      }
    }
  }

  const key = JSON.stringify([effectiveUrl, extractMode, verbosity, effectiveMaxContent ?? null,
    sanitizeMode, sanitizationEnabled, trustTierConfig, urlInput.selectors ?? null]);
  if (cacheTtlSeconds > 0 && method === 'GET') {
    const cached = runtime.getCached(key, cacheTtlSeconds);
    if (cached) {
      return cached;
    }
  }

  let prepared: PreparedFetchRequest;
  try {
    prepared = await prepareFetchRequest(urlInput, extractMode, deps);
  } catch (error) {
    if (!(error instanceof CredentialMissingError)) throw error;
    return { url: urlInput.url, error: `Credential missing: ${error.message}`,
      ...(initialTrustResult?.tier === 'localhost' ? { host_trust_tier: 'localhost' as const } : {}) };
  }
  const { headers, credentialHeaders, body: requestBody } = prepared;
  const startTime = performance.now();
  const permits: LocalhostFetchPermit[] = [];

  try {
    let fetched = await fetchOneRaw(
      urlInput,
      headers,
      method,
      requestBody,
      effectiveUrl,
      trustTierConfig,
      localhostApproved,
      credentialHeaders,
      deps.signal,
      deps.resolveHost,
      deps,
      permits,
    );

    for (const permit of permits) permit.assertCurrent();
    let response = fetched.response;
    const retryOnAuth = urlInput.retry_on_auth ?? (urlInput.service !== undefined);
    if (response.status === 401 && retryOnAuth && urlInput.service && !(requestBody instanceof FormData)) {
      const refreshed = await deps.serviceRegistry?.resolveAuthFor(urlInput.service, urlInput.url);
      const refreshedHeaders = refreshed && 'headers' in refreshed ? refreshed.headers : null;
      if (refreshedHeaders) {
        // The refused response is superseded; release its body before retrying.
        await response.body?.cancel().catch(() => undefined);
        const retryHeaders = { ...headers };
        Object.assign(retryHeaders, refreshedHeaders);
        const retryCredentialHeaders = new Set([...credentialHeaders, ...Object.keys(refreshedHeaders).map((name) => name.toLowerCase())]);
        fetched = await fetchOneRaw(
          urlInput,
          retryHeaders,
          method,
          requestBody,
          effectiveUrl,
          trustTierConfig,
          localhostApproved,
          retryCredentialHeaders,
          deps.signal,
          deps.resolveHost,
          deps,
          permits,
        );
        response = fetched.response;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    let contentType = response.headers.get('content-type') ?? '';
    const bodyResult = await readResponseBody(response, effectiveMaxContent, extractMode === 'pdf');
    for (const permit of permits) permit.assertCurrent();
    let rawBody = bodyResult.text;
    contentType = sniffContentType(contentType, rawBody);

    const truncated = bodyResult.truncated;

    const byteSize = bodyResult.byteSize;
    const result: FetchUrlResult = buildFetchResultBase(urlInput, response, durationMs);

    if (verbosity === 'count_only') {
      cacheSuccessfulGet(runtime, response.headers.has('set-cookie') ? 0 : cacheTtlSeconds, method, key, result);
      return result;
    }

    result.contentType = contentType;
    result.byteSize = byteSize;
    if (truncated) result.truncated = true;
    result.redirected = fetched.redirects > 0;
    result.final_url = fetched.finalUrl !== effectiveUrl ? fetched.finalUrl : undefined;
    if (fetched.droppedHeaders.length > 0) result.redirect_dropped_headers = [...fetched.droppedHeaders];

    let effectiveSanitizeMode = sanitizationEnabled ? sanitizeMode : 'none' as const;
    if (sanitizationEnabled && hostname !== null) {
      const hostTrustResult = initialTrustResult ?? classifyHostTrustTier(hostname, trustTierConfig);
      result.host_trust_tier = hostTrustResult.tier;
      if (hostTrustResult.tier === 'unknown' && effectiveSanitizeMode === 'none') {
        effectiveSanitizeMode = 'safe-text';
      }
    } else if (hostname !== null && initialTrustResult !== null) {
      result.host_trust_tier = initialTrustResult.tier;
    }

    if (verbosity === 'minimal') {
      result.sanitization_tier = 'skipped';
    } else {
      result.sanitization_tier = effectiveSanitizeMode;
    }

    if (verbosity !== 'minimal') {
      const extracted = await applyExtractDetailed(rawBody, contentType, extractMode, {
        selectors: urlInput.selectors, bytes: bodyResult.bytes, truncated, signal: deps.signal,
      });
      if (extracted.jsonParseError !== undefined) result.json_parse_error = extracted.jsonParseError;
      if (extracted.pdfError !== undefined) result.pdf_error = extracted.pdfError;
      // Tags are handled only while the content is still markup (extract raw, or an
      // HTML/XML body returned as written); extracted text is never tag-scanned.
      const markup = extracted.content === rawBody && /html|xml/i.test(contentType);
      const sanitized = applySanitizer(extracted.content, effectiveSanitizeMode, { markup });
      logger.debug('SANITIZE_MODE_APPLIED', {
        event: 'SANITIZE_MODE_APPLIED',
        url: sanitizeUrlForLog(urlInput.url),
        mode: effectiveSanitizeMode,
        modified: sanitized.modified,
      });
      result.content = sanitized.content;
      if (sanitized.modified) {
        result.sanitized = true;
        result.sanitized_removed = { ...sanitized.removed };
      }
      if (sanitized.note !== undefined) result.sanitize_note = sanitized.note;
      result.tokens_used = Math.ceil(sanitized.content.length / 4);
    }

    if (verbosity === 'verbose') {
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      result.metadata = {
        headers: respHeaders,
        redirected: fetched.redirects > 0,
        finalUrl: fetched.finalUrl,
      };
    }

    cacheSuccessfulGet(runtime, response.headers.has('set-cookie') ? 0 : cacheTtlSeconds, method, key, result);
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    // The caller's cancel and the per-URL timeout both surface as abort
    // rejections; which one fired is read from the caller's signal first.
    const cancelled = deps.signal?.aborted === true;
    const isTimeout = !cancelled && isTimeoutError(err);
    const timeoutMs = urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const message = cancelled
      ? CANCELLED_MESSAGE
      : isTimeout
        ? `Timeout after ${timeoutMs}ms: no complete response within timeout_ms. Retry with a larger timeout_ms if the server is known to be slow.`
        : err instanceof Error
          ? err.message
          : summarizeError(err);
    logger.warn('fetch tool: request failed', { url: sanitizeUrlForLog(urlInput.url),
      error: message.replaceAll(urlInput.url, sanitizeUrlForLog(urlInput.url)).replaceAll(effectiveUrl, sanitizeUrlForLog(effectiveUrl)) });
    return { url: urlInput.url, error: message, duration_ms: durationMs,
      ...(cancelled ? { cancelled: true } : {}),
      ...(isTimeout ? { timed_out: true } : {}),
      ...(initialTrustResult?.tier === 'localhost' ? { host_trust_tier: 'localhost' as const } : {}) };
  } finally {
    for (const permit of permits) permit.close();
  }
}

function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError';
}

/** Settles with `promise`, or with undefined as soon as `signal` aborts. */
async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The response body as text, read up to `maxBytes`, with its byte count. With
 * `keepBytes` the bytes are kept too: a PDF is binary, and a text decode
 * replaces the bytes it cannot represent.
 */
async function readResponseBody(
  response: Response,
  maxBytes: number | undefined,
  keepBytes: boolean,
): Promise<{ text: string; truncated: boolean; byteSize: number; bytes?: Uint8Array | undefined }> {
  if (maxBytes === undefined || maxBytes <= 0 || !response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    return { text: new TextDecoder().decode(all), truncated: false, byteSize: all.byteLength, ...(keepBytes ? { bytes: all } : {}) };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let text = '';
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await cancelResponseReader(reader, 'Response body limit reached');
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      if (keepBytes) chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) {
        truncated = true;
        await cancelResponseReader(reader, 'Response body limit reached');
        break;
      }
    }
    text += decoder.decode();
    return { text, truncated, byteSize: total, ...(keepBytes ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch (error) {
    logger.warn('Fetch response reader cancel failed', {
      reason,
      error: summarizeError(error),
    });
  }
}

function cacheSuccessfulGet(
  runtime: FetchRuntimeService,
  cacheTtlSeconds: number,
  method: string,
  key: string,
  result: FetchUrlResult,
): void {
  // An error status describes a moment, not the page: replaying it would make a retry a no-op.
  if (cacheTtlSeconds > 0 && method === 'GET' && (result.status ?? 0) < 400) {
    runtime.cacheSet(key, { data: result, timestamp: Date.now(), ttl: cacheTtlSeconds });
  }
}

/**
 * Union of a config-supplied default host list with the per-call host list.
 * Per-call hosts are ADDED to (never replace) the config defaults; duplicates are
 * removed. Returns undefined when the union is empty so TrustTierConfig keeps its
 * "no list supplied" semantics unchanged.
 */
function mergeHostLists(
  defaults: readonly string[] | undefined,
  perCall: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...(defaults ?? []), ...(perCall ?? [])]
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (merged.length === 0) return undefined;
  return [...new Set(merged)];
}

export function createFetchTool(
  deps: FetchRuntimeDeps = {},
  runtime = new FetchRuntimeService(),
): Tool {
  return {
    definition: {
      name: 'fetch',
      activity: { doing: 'Fetching', did: 'fetched', object: 'a web page', objects: 'web pages' },
      // Sent in full on every model request (see ToolDefinition.core).
      core: true,
      description:
        'Fetch one or more URLs via HTTP. Supports batch parallel/sequential requests,'
        + ' per-URL method/headers/body/params, extraction modes (raw, text, json, markdown,'
        + ' readable, code_blocks, links, metadata, structured, tables, pdf, summary),'
        + ' per-URL timeouts, caching, rate limiting, auth refresh, content-length limits,'
        + ' redirect tracking, timing metrics, token estimation, and verbosity control.',
      parameters: toRecord(FETCH_TOOL_SCHEMA),
      sideEffects: ['network'],
      // Where a call's hosts sit: the gate and network-scope policy rules read them from here.
      subjects: { hosts: ['urls[].url'] },
      // Only a call whose every request is a safe method reads: it runs beside other reads.
      // A POST, PUT, PATCH or DELETE changes something, so the call is decided and run as a change.
      readModes: { field: 'urls[].method', values: ['GET', 'HEAD', 'OPTIONS'], defaultValue: 'GET' },
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(
      args: Record<string, unknown>,
      opts?: { readonly signal?: AbortSignal | undefined },
    ): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        currentExecutionMode();
        if (!isInvocationAdmitted('fetch', args)) args = captureProjectionStructure(args);
        if (!Array.isArray(args.urls) || args.urls.length === 0) {
          return { success: false, error: 'Missing or empty "urls" array' };
        }
        const input = { ...args, urls: args.urls } as unknown as FetchInput;
        const effectiveDeps = opts?.signal ? { ...deps, signal: opts.signal } : deps;
        const output = await runFetchInvocation(args, opts, input, () => runtime.execute(input, effectiveDeps));
        if (!output.success) {
          const reasons = [...new Set((output.results ?? []).map(result => result.error ?? (result.status !== undefined ? `HTTP ${result.status}` : undefined))
            .filter((reason): reason is string => reason !== undefined))];
          return { success: false, output: JSON.stringify(output),
            error: `All ${output.summary.total} fetch${output.summary.total === 1 ? '' : 'es'} failed${reasons.length ? `: ${reasons.slice(0, 3).join('; ')}${reasons.length > 3 ? '; ...' : ''}` : ''}. Details are in the per-URL results.` };
        }
        return { success: true, output: JSON.stringify(output) };
      } catch (err) {
        const message = summarizeError(err);
        logger.error('fetch tool: unexpected error', { error: message });
        return { success: false, error: describeUnexpectedToolError(err, summarizeError) };
      }
    },
  };
}
