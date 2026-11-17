import type { ServiceRegistry } from '../../config/service-registry.js';
import { executeFetchInput, type FetchOutput, type FetchUrlResult } from '../../tools/fetch/index.js';
import type { FetchAuthInput, FetchInput, FetchUrlInput } from '../../tools/fetch/schema.js';
import type { WebSearchEvidence, WebSearchProviderDescriptor, WebSearchRequest, WebSearchResult } from '../types.js';
import { summarizeError } from '../../utils/error-display.js';

type EnvMap = Record<string, string | undefined>;
type FetchExecutor = (input: FetchInput) => Promise<FetchOutput>;

export interface SearchProviderContext {
  readonly fetcher?: FetchExecutor | undefined;
  readonly env: EnvMap;
  readonly serviceRegistry: Pick<ServiceRegistry, 'get'>;
}

export interface SearchProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly envKeyCandidates?: readonly string[] | undefined;
  readonly serviceName?: string | undefined;
  readonly baseUrlEnvCandidates?: readonly string[] | undefined;
  readonly defaultBaseUrl?: string | undefined;
  readonly requiresAuth?: boolean | undefined;
}

export interface JsonRequestConfig {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | undefined;
  readonly params?: Record<string, string> | undefined;
  readonly body?: Record<string, unknown> | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly service?: string | undefined;
  readonly auth?: FetchAuthInput | undefined;
  readonly fetcher?: FetchExecutor | undefined;
  readonly maxContentLength?: number | undefined;
}

export interface JsonRequestResult<T = unknown> {
  readonly payload: T;
  readonly response: FetchUrlResult;
}

/** A request filter a provider may or may not be able to apply. */
export type WebSearchFilter = 'region' | 'safeSearch' | 'timeRange';

/** The filters this request actually sets (`timeRange: 'any'` and a blank region set nothing). */
export function requestedFilters(request: WebSearchRequest): WebSearchFilter[] {
  const filters: WebSearchFilter[] = [];
  if (request.region?.trim()) filters.push('region');
  if (request.safeSearch) filters.push('safeSearch');
  if (request.timeRange && request.timeRange !== 'any') filters.push('timeRange');
  return filters;
}

/**
 * `metadata.ignoredFilters` for a provider response: the filters the request
 * set that this provider did not send, so the caller can tell a filtered result
 * set from an unfiltered one. Empty when every requested filter was applied.
 */
export function ignoredFilterMetadata(request: WebSearchRequest, applied: readonly WebSearchFilter[]): { ignoredFilters?: WebSearchFilter[] } {
  const ignored = requestedFilters(request).filter((filter) => !applied.includes(filter));
  return ignored.length > 0 ? { ignoredFilters: ignored } : {};
}

/**
 * The two-letter country of a region: `us`, `US` or DuckDuckGo's
 * country-language form `us-en` all give `US`; DuckDuckGo's no-region `wt-wt`
 * and anything else give undefined (the region is then reported ignored).
 */
export function regionCountry(region: string | undefined): string | undefined {
  const match = /^([a-z]{2})(?:-[a-z]{2})?$/i.exec(region?.trim() ?? '');
  if (!match || match[1]!.toLowerCase() === 'wt') return undefined;
  return match[1]!.toUpperCase();
}

/** Response bytes a JSON search answer may take: room for page text when the provider sends it. */
export function jsonAnswerBytes(maxResults: number, pageTextRequested: boolean): number | undefined {
  return pageTextRequested ? Math.max(512_000, maxResults * 200_000) : undefined;
}

export function resolveDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function trimSnippet(value: unknown, limit = 320): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function makeEvidence(
  url: string,
  content: unknown,
  metadata: Record<string, unknown> = {},
  extract: 'raw' | 'text' | 'json' | 'markdown' | 'readable' | 'code_blocks' | 'links' | 'metadata' | 'structured' | 'tables' | 'pdf' | 'summary' = 'summary',
): WebSearchEvidence[] | undefined {
  if (typeof content !== 'string') return undefined;
  const normalized = content.trim();
  if (!normalized) return undefined;
  return [{
    url,
    extract,
    content: normalized,
    tokensUsed: Math.ceil(normalized.length / 4),
    metadata,
  }];
}

export function withInlineApiKey(
  env: EnvMap,
  envKeys: readonly string[] | undefined,
  headerName: string,
): FetchAuthInput | undefined {
  if (!envKeys || envKeys.length === 0) return undefined;
  for (const key of envKeys) {
    const value = env[key]!;
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        type: 'api-key',
        header: headerName,
        key: value.trim(),
      };
    }
  }
  return undefined;
}

export function withInlineBearer(
  env: EnvMap,
  envKeys: readonly string[] | undefined,
): FetchAuthInput | undefined {
  if (!envKeys || envKeys.length === 0) return undefined;
  for (const key of envKeys) {
    const value = env[key]!;
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        type: 'bearer',
        token: value.trim(),
      };
    }
  }
  return undefined;
}

export function hasConfiguredCredential(
  serviceRegistry: Pick<ServiceRegistry, 'get'>,
  env: EnvMap,
  envKeys: readonly string[] | undefined,
  serviceName?: string,
): boolean {
  const envConfigured = (envKeys ?? []).some((key) => typeof env[key] === 'string' && (env[key] as string).trim().length > 0);
  if (envConfigured) return true;
  return Boolean(serviceName && serviceRegistry.get(serviceName));
}

export function resolveBaseUrl(
  serviceRegistry: Pick<ServiceRegistry, 'get'>,
  env: EnvMap,
  envKeys: readonly string[] | undefined,
  serviceName: string | undefined,
  defaultBaseUrl?: string,
): string | null {
  for (const key of envKeys ?? []) {
    const value = env[key]!;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().replace(/\/+$/, '');
    }
  }
  const configuredService = serviceName ? serviceRegistry.get(serviceName) : null;
  const serviceUrl = configuredService?.baseUrl?.trim();
  if (serviceUrl) return serviceUrl.replace(/\/+$/, '');
  return defaultBaseUrl ? defaultBaseUrl.replace(/\/+$/, '') : null;
}

export function buildDescriptor(
  config: SearchProviderConfig,
  context: SearchProviderContext,
): WebSearchProviderDescriptor {
  const configured = config.requiresAuth === false
    ? resolveBaseUrl(context.serviceRegistry, context.env, config.baseUrlEnvCandidates, config.serviceName, config.defaultBaseUrl) != null
    : hasConfiguredCredential(context.serviceRegistry, context.env, config.envKeyCandidates, config.serviceName);
  return {
    id: config.id,
    label: config.label,
    capabilities: ['search', 'evidence'],
    requiresAuth: config.requiresAuth ?? true,
    configured,
    note: config.note,
  };
}

export async function executeJsonRequest<T = unknown>(config: JsonRequestConfig): Promise<JsonRequestResult<T>> {
  const fetcher = config.fetcher ?? executeFetchInput;
  const urlInput: FetchUrlInput = {
    url: config.url,
    method: config.method ?? 'GET',
    extract: 'json',
    ...(config.params ? { params: config.params } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.body ? { body_type: 'json', body: JSON.stringify(config.body) } : {}),
    ...(config.service ? { service: config.service } : {}),
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.maxContentLength ? { max_content_length: config.maxContentLength } : {}),
  };
  const output = await fetcher({
    urls: [urlInput],
    parallel: false,
    verbosity: 'standard',
    sanitize_mode: 'safe-text',
    max_content_length: config.maxContentLength ?? 512_000,
  });
  const response = output.results?.[0];
  if (!response || response.error || typeof response.content !== 'string') {
    throw new Error(response?.error ?? `Search provider request failed for ${config.url}`);
  }
  if (response.truncated) {
    const limit = config.maxContentLength ?? 512_000;
    throw new Error(`Search provider answer from ${config.url} was larger than ${limit} bytes and was cut, so it could not be read. Ask for fewer results, or leave out evidence.`);
  }
  let payload: T;
  try {
    payload = JSON.parse(response.content) as T;
  } catch (error) {
    throw new Error(`Search provider returned invalid JSON for ${config.url}: ${summarizeError(error)}`);
  }
  return { payload, response };
}

export function resultFromRecord(
  providerId: string,
  rank: number,
  record: Record<string, unknown>,
  options: {
    readonly urlKeys?: readonly string[] | undefined;
    readonly titleKeys?: readonly string[] | undefined;
    readonly snippetKeys?: readonly string[] | undefined;
    readonly displayUrlKeys?: readonly string[] | undefined;
    readonly evidenceKeys?: readonly string[] | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  } = {},
): WebSearchResult | null {
  const url = firstString(record, options.urlKeys ?? ['url', 'link', 'id']);
  if (!url) return null;
  return {
    rank,
    url,
    ...(firstString(record, options.titleKeys ?? ['title', 'name', 'heading']) ? { title: firstString(record, options.titleKeys ?? ['title', 'name', 'heading']) } : {}),
    ...(trimSnippet(firstString(record, options.snippetKeys ?? ['snippet', 'description', 'content', 'text'])) ? { snippet: trimSnippet(firstString(record, options.snippetKeys ?? ['snippet', 'description', 'content', 'text'])) } : {}),
    ...(firstString(record, options.displayUrlKeys ?? ['displayUrl', 'display_url']) ? { displayUrl: firstString(record, options.displayUrlKeys ?? ['displayUrl', 'display_url']) } : {}),
    ...(resolveDomain(url) ? { domain: resolveDomain(url) } : {}),
    type: 'organic',
    providerId,
    metadata: {
      ...(options.metadata ?? {}),
      ...(options.evidenceKeys
        ? {
            hasProviderEvidence: options.evidenceKeys.some((key) => typeof record[key] === 'string' && String(record[key]).trim().length > 0),
          }
        : {}),
    },
    ...(providerEvidence(url, record, options.evidenceKeys) ? { evidence: providerEvidence(url, record, options.evidenceKeys) } : {}),
  };
}

export function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]!;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function providerEvidence(
  url: string,
  record: Record<string, unknown>,
  keys: readonly string[] | undefined,
): WebSearchEvidence[] | undefined {
  for (const key of keys ?? []) {
    const value = record[key]!;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    return makeEvidence(url, value, { providerField: key });
  }
  return undefined;
}
