/**
 * The Agent Knowledge client. Every knowledge call goes to the Agent's own
 * routes (`/api/goodvibes-agent/knowledge/*`), which the host serves from the
 * Agent's own knowledge service: the route prefix is the scope, so nothing in a
 * returned title, snippet or answer is read as evidence of the wrong space.
 *
 * One transport: the engine's agent-scoped browser platform, which knows every
 * Agent Knowledge route from the operator contract with the knowledge prefix
 * moved. The host and credential come from the Agent's one resolution
 * (`resolveConnectedHost`): the configured host over the network in the
 * Agent's own process, and in a turn the daemon hosts for the Agent the daemon
 * itself, through its own request path with the Agent's own credential for it
 * (in-process-host.ts), so the call is authenticated, gated and handled exactly
 * as the paired Agent's call over the wire. Every request has a deadline joined to the caller's
 * signal, follows no redirect, and is never retried. A refusal carries the
 * host's own words and the status, `<host message> (HTTP <status>)`, plus the
 * next step.
 */
import { classifyFailure, httpStatusOf } from '@goodvibes-jev/engine/errors';
import { createBrowserAgentPlatform, type BrowserAgentPlatform } from '@goodvibes-jev/engine/platform/browser/agent';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { normalizeAgentKnowledgeScopeAliases } from './knowledge-scope-alias.js';
import { resolveConnectedHost } from './connected-host-client.js';
import type { AgentInProcessHost } from './in-process-host.js';
import { AGENT_KNOWLEDGE_METHODS, type ConnectedHostCallMethod } from './knowledge-methods.js';
import { isRecord } from './knowledge-format.js';

export type JsonRecord = Record<string, unknown>;

export interface AgentKnowledgeConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the credential was looked for, safe to show. */
  readonly tokenPath: string;
  /** Why there is no usable credential, when `token` is null. */
  readonly unavailable?: { readonly reason: string; readonly next: readonly string[] } | undefined;
  /** How a request reaches the host: absent, the network; in a daemon-hosted turn, the daemon's own request path. */
  readonly fetch?: typeof fetch | undefined;
}

export interface AgentKnowledgeConnectionRuntime {
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly homeDirectory: string;
  /** The daemon hosting this Agent turn: the connected host, reached in process. Absent in the Agent's own process. */
  readonly inProcess?: AgentInProcessHost | undefined;
}

export interface AgentKnowledgeFailure {
  readonly ok: false;
  readonly kind:
    | 'connected_host_unavailable'
    | 'auth_required'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error'
    | 'not_found';
  readonly error: string;
  readonly baseUrl: string;
  readonly route: string;
  /** HTTP status of the host's answer, when it answered. */
  readonly status?: number | undefined;
  /** What to do next, most useful first. */
  readonly next?: readonly string[] | undefined;
}

export interface AgentKnowledgeSuccess<TData> {
  readonly ok: true;
  readonly kind: string;
  readonly route: string;
  readonly data: TData;
}

export type AgentKnowledgeResult<TData> = AgentKnowledgeSuccess<TData> | AgentKnowledgeFailure;

export function resolveConnectedHostConnection(runtime: AgentKnowledgeConnectionRuntime): AgentKnowledgeConnection {
  const resolved = resolveConnectedHost({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory,
    ...(runtime.inProcess ? { inProcess: runtime.inProcess } : {}) });
  return {
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    tokenPath: resolved.credential,
    ...(resolved.unavailable ? { unavailable: { reason: resolved.unavailable.reason, next: resolved.unavailable.next } } : {}),
    ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
  };
}

/** Additive request restrictions; these callbacks never grant tool admission. */
export interface AgentKnowledgeRequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** Run once, before the request leaves. */
  readonly assertCurrent?: (() => void) | undefined;
}

/** A read that waits longer than this ends as "the host did not answer". */
export const AGENT_KNOWLEDGE_READ_DEADLINE_MS = 15_000;
/** Ask, search and single-source ingest: the host may call a model or fetch a page. */
export const AGENT_KNOWLEDGE_WRITE_DEADLINE_MS = 60_000;
/** Batch imports and reindex walk many sources on the host. */
export const AGENT_KNOWLEDGE_BATCH_DEADLINE_MS = 600_000;
const STATUS_PROBE_DEADLINE_MS = 3_000;

const BATCH_METHOD_IDS: ReadonlySet<string> = new Set([
  AGENT_KNOWLEDGE_METHODS.ingestUrls.kind,
  AGENT_KNOWLEDGE_METHODS.ingestBookmarks.kind,
  AGENT_KNOWLEDGE_METHODS.ingestBrowserHistory.kind,
  AGENT_KNOWLEDGE_METHODS.ingestConnector.kind,
  AGENT_KNOWLEDGE_METHODS.reindex.kind,
].map(kind => platformMethodId(kind)));

function deadlineFor(httpMethod: string, url: string): number {
  if (httpMethod === 'GET' || httpMethod === 'HEAD') return AGENT_KNOWLEDGE_READ_DEADLINE_MS;
  const path = new URL(url).pathname;
  for (const method of Object.values(AGENT_KNOWLEDGE_METHODS)) {
    if (method.route === path && BATCH_METHOD_IDS.has(platformMethodId(method.kind))) return AGENT_KNOWLEDGE_BATCH_DEADLINE_MS;
  }
  return AGENT_KNOWLEDGE_WRITE_DEADLINE_MS;
}

/** Marks a request the deadline ended, so the failure says so instead of "network error". */
class KnowledgeDeadlineError extends Error {
  override readonly name = 'KnowledgeDeadlineError';
  constructor(readonly deadlineMs: number, readonly write: boolean, cause: unknown) {
    super(`the connected host did not answer within ${Math.round(deadlineMs / 1000)} s`, { cause });
  }
}

export function normalizeAgentKnowledgeData<TData>(data: TData): TData {
  return normalizeAgentKnowledgeScopeAliases(data);
}

/**
 * The agent-scoped platform client for one connection. `knowledge.*` answers are
 * normalized to the Agent's space id; `operator.invoke` reaches the shared
 * session routes too (delegation).
 */
export function createAgentPlatform(connection: AgentKnowledgeConnection,
  options: AgentKnowledgeRequestOptions = {}): BrowserAgentPlatform {
  const platformClient = createBrowserAgentPlatform({
    baseUrl: connection.baseUrl,
    authToken: connection.token,
    // A knowledge write is never sent twice: an ingest repeated after a lost
    // answer would store the source again.
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async (input, init) => {
      const send = connection.fetch ?? fetch;
      options.assertCurrent?.();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const httpMethod = (init?.method ?? 'GET').toUpperCase();
      const deadlineMs = deadlineFor(httpMethod, url);
      const deadline = AbortSignal.timeout(deadlineMs);
      const signals = [deadline, ...(options.signal ? [options.signal] : []), ...(init?.signal ? [init.signal] : [])];
      try {
        return await send(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
      } catch (error) {
        if (deadline.aborted && !options.signal?.aborted) throw new KnowledgeDeadlineError(deadlineMs, httpMethod !== 'GET', error);
        throw error;
      }
    },
  });
  const normalized = <T>(pending: Promise<T>): Promise<T> => pending.then(data => normalizeAgentKnowledgeData(data));
  return {
    ...platformClient,
    knowledge: {
      ask: async (input) => normalized(platformClient.knowledge.ask(input)),
      search: async (input) => normalized(platformClient.knowledge.search(input)),
      status: async (input) => normalized(platformClient.knowledge.status(input)),
      map: async (input) => normalized(platformClient.knowledge.map(input)),
    },
  };
}

/** `agentKnowledge.sources.list` is the platform's `knowledge.sources.list` on the Agent's prefix. */
function platformMethodId(kind: string): string {
  return kind.replace(/^agentKnowledge\./, 'knowledge.');
}

interface ResolvedKnowledgeRoute {
  readonly methodId: string;
  readonly pathInput: JsonRecord;
}

const ROUTE_MATCHERS: readonly { readonly methodId: string; readonly pattern: RegExp; readonly names: readonly string[] }[] =
  Object.values(AGENT_KNOWLEDGE_METHODS).map((method) => {
    const names: string[] = [];
    const source = method.route.split(/(\{[^}]+\})/).map((part) => {
      const name = /^\{([^}]+)\}$/.exec(part)?.[1];
      if (name) { names.push(name); return '([^/?#]+)'; }
      return part.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
    }).join('');
    return { methodId: platformMethodId(method.kind), pattern: new RegExp(`^${source}$`), names };
  });

/** Which platform method serves a concrete Agent Knowledge route, with its path values. */
function resolveKnowledgeRoute(route: string): ResolvedKnowledgeRoute {
  for (const matcher of ROUTE_MATCHERS) {
    const match = matcher.pattern.exec(route);
    if (!match) continue;
    const pathInput: JsonRecord = {};
    matcher.names.forEach((name, index) => { pathInput[name] = decodeURIComponent(match[index + 1]!); });
    return { methodId: matcher.methodId, pathInput };
  }
  throw new Error(`${route} is not an Agent Knowledge route.`);
}

/** Drops empty values a query string cannot carry meaningfully. */
function compactInput(input: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

async function invokeKnowledgeRoute<TData>(
  connection: AgentKnowledgeConnection,
  route: string,
  input: JsonRecord,
  options: AgentKnowledgeRequestOptions,
): Promise<TData> {
  const { methodId, pathInput } = resolveKnowledgeRoute(route);
  const platformClient = createAgentPlatform(connection, options);
  // The scoped client types `invoke` per method id; the id here is chosen at run
  // time from the Agent route table, so the call is made through its untyped form.
  const invoke = platformClient.operator.invoke as unknown as (
    methodId: string, input: JsonRecord, invokeOptions: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
  const data = await invoke(methodId, { ...compactInput(input), ...pathInput }, options.signal ? { signal: options.signal } : {});
  return normalizeAgentKnowledgeData(data as TData);
}

export async function postAgentKnowledgeJson<TData>(
  connection: AgentKnowledgeConnection,
  route: string,
  body: JsonRecord,
  options: AgentKnowledgeRequestOptions = {},
): Promise<TData> {
  return invokeKnowledgeRoute<TData>(connection, route, body, options);
}

/** A local file sent as bytes: the host stores exactly what was read here. */
export interface AgentKnowledgeUploadFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

/**
 * Post a file to an upload route as multipart form data, with the same
 * deadline, no redirect and no retry as every other knowledge call. The host
 * never opens a path of its own, so the ingest is the same on a host on
 * another machine.
 */
export async function postAgentKnowledgeUpload<TData>(
  connection: AgentKnowledgeConnection,
  route: string,
  file: AgentKnowledgeUploadFile,
  fields: JsonRecord,
  options: AgentKnowledgeRequestOptions = {},
): Promise<TData> {
  options.assertCurrent?.();
  const form = new FormData();
  for (const [key, value] of Object.entries(compactInput(fields))) {
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  form.append('file', new Blob([new Uint8Array(file.bytes)]), file.filename);
  const deadline = AbortSignal.timeout(AGENT_KNOWLEDGE_WRITE_DEADLINE_MS);
  let response: Response;
  try {
    response = await (connection.fetch ?? fetch)(new URL(route, connection.baseUrl), {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]),
      headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
    });
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted) throw new KnowledgeDeadlineError(AGENT_KNOWLEDGE_WRITE_DEADLINE_MS, true, error);
    throw error;
  }
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { /* the host answered with text; keep it as the body */ }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : text.trim() || `HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, body });
  }
  return normalizeAgentKnowledgeData(body as TData);
}

export async function getAgentKnowledgeJson<TData>(
  connection: AgentKnowledgeConnection,
  route: string,
  query: JsonRecord = {},
  options: AgentKnowledgeRequestOptions = {},
): Promise<TData> {
  return invokeKnowledgeRoute<TData>(connection, route, query, options);
}

/** One bounded `GET /status`: does a GoodVibes host answer at this address at all. */
export async function fetchConnectedHostStatus(connection: AgentKnowledgeConnection,
  options: AgentKnowledgeRequestOptions = {}): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
  options.assertCurrent?.();
  const deadline = AbortSignal.timeout(STATUS_PROBE_DEADLINE_MS);
  try {
    const response = await (connection.fetch ?? fetch)(`${connection.baseUrl}/status`, {
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      headers: connection.token ? { authorization: `Bearer ${connection.token}` } : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: summarizeError(error) };
  }
}

/** The host's own words for a refusal, on one line and bounded. */
function hostMessage(error: unknown): string {
  const text = summarizeError(error).replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 400)}...` : text || 'no message';
}

/**
 * What a failed knowledge call means, from the status, the errno code and the
 * error's own fields. A cancelled call is rethrown: the caller stopped waiting.
 */
export async function classifyKnowledgeError(error: unknown, connection: AgentKnowledgeConnection, route: string,
  options: AgentKnowledgeRequestOptions = {}): Promise<AgentKnowledgeFailure> {
  if (options.signal?.aborted) throw error;
  const base = { baseUrl: connection.baseUrl, route };
  if (error instanceof KnowledgeDeadlineError) {
    return { ok: false, kind: 'connected_host_unavailable', ...base, error: error.message,
      next: [error.write
        ? 'The host may still be working on it: list the Agent Knowledge sources before repeating, so nothing is stored twice.'
        : 'Check the daemon with goodvibes-agent status, then retry.'] };
  }
  const status = httpStatusOf(error);
  if (status !== undefined) {
    const message = `${hostMessage(error)} (HTTP ${status})`;
    if (status === 401 || status === 403) {
      return { ok: false, kind: 'auth_required', ...base, status, error: message,
        next: ['Pair this Agent with the host again (goodvibes-agent setup pair --apply), then retry.'] };
    }
    if (status === 404) {
      // The host answers 404 `Unknown knowledge item|connector` for an id it does
      // not hold; a missing route has no such body.
      const body = (error as { body?: unknown }).body;
      const bodyError = isRecord(body) && typeof body.error === 'string' ? body.error : typeof body === 'string' ? body : '';
      if (/unknown knowledge (item|connector)/i.test(bodyError)) {
        return { ok: false, kind: 'not_found', ...base, status, error: message,
          next: ['List the Agent Knowledge sources, nodes or connectors to find the id.'] };
      }
      const host = await fetchConnectedHostStatus(connection, options.signal ? { signal: options.signal } : {});
      return host.ok
        ? { ok: false, kind: 'connected_host_incompatible', ...base, status, error: message,
          next: ['Update GoodVibes on the connected host to the version this Agent was built with.'] }
        : { ok: false, kind: 'connected_host_route_unavailable', ...base, status, error: message,
          next: ['Check that controlPlane.host and controlPlane.port point at the GoodVibes daemon, then retry.'] };
    }
    return { ok: false, kind: 'connected_host_error', ...base, status, error: message,
      next: [status >= 500 ? 'Retry; if it keeps failing, read the daemon log on the host.' : 'Correct the request as the host says, then retry.'] };
  }
  const classified = classifyFailure(error);
  if (classified?.category === 'network' || classified?.category === 'timeout') {
    return { ok: false, kind: 'connected_host_unavailable', ...base, error: hostMessage(error),
      next: ['Start the GoodVibes daemon (goodvibes-daemon) or check controlPlane.host and controlPlane.port, then retry.'] };
  }
  return { ok: false, kind: 'connected_host_error', ...base, error: hostMessage(error) };
}

const AGENT_KNOWLEDGE_SCOPE_KEYS = new Set(['spaceid', 'knowledgespaceid', 'namespace']);

/**
 * Diagnostic for the live verifier: a field that names the scope (`spaceId`,
 * `knowledgeSpaceId`, `namespace`) and holds the default space. It reads keys
 * only, never content, and is not applied to answers on the request path.
 */
export function findAgentKnowledgeScopeContamination(value: unknown): string | null {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const nested = visit(item);
        if (nested) return nested;
      }
      return null;
    }
    for (const [key, nestedValue] of Object.entries(node as JsonRecord)) {
      if (AGENT_KNOWLEDGE_SCOPE_KEYS.has(key.replace(/[-_\s]/g, '').toLowerCase())
        && typeof nestedValue === 'string' && nestedValue.trim().toLowerCase() === 'default') {
        return `${key}=default`;
      }
      const nested = visit(nestedValue);
      if (nested) return nested;
    }
    return null;
  };
  return visit(value);
}

export function findDisallowedKnowledgeScopeFlag(args: readonly string[]): string | null {
  const disallowed = [
    '--space',
    '--knowledge-space',
    '--knowledge-space-id',
    ['--knowledge', 'SpaceId'].join(''),
    '--include-all-spaces',
    ['--include', 'AllSpaces'].join(''),
    ['--home', 'graph'].join(''),
    ['--home', '-graph'].join(''),
  ];
  for (const token of args) {
    for (const flag of disallowed) {
      if (token === flag || token.startsWith(`${flag}=`)) return flag;
    }
  }
  return null;
}

export function formatScopeFlagRejection(flag: string): string {
  return [
    `Agent Knowledge is isolated; ${flag} is not accepted.`,
    'GoodVibes Agent must not use default knowledge or non-Agent product spaces.',
    'Use only /api/goodvibes-agent/knowledge/* Agent-owned routes.',
  ].join('\n');
}

export async function runKnowledgeCall<TData>(
  runtime: AgentKnowledgeConnectionRuntime,
  method: ConnectedHostCallMethod,
  call: (connection: AgentKnowledgeConnection) => Promise<TData>,
): Promise<AgentKnowledgeResult<TData>> {
  const connection = resolveConnectedHostConnection(runtime);
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: connection.unavailable?.reason ?? `No connected-host operator token found at ${connection.tokenPath}`,
      baseUrl: connection.baseUrl,
      route: method.route,
      ...(connection.unavailable ? { next: connection.unavailable.next } : {}),
    };
  }
  try {
    return { ok: true, kind: method.kind, route: method.route, data: await call(connection) };
  } catch (error) {
    return classifyKnowledgeError(error, connection, method.route);
  }
}
