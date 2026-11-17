/**
 * operator-endpoint.ts, the one place this product resolves "the daemon I talk
 * to", for every seam that talks to it.
 *
 * The terminal app is a pure client: it runs its own conversation loop and asks
 * a separately-running daemon for everything else. Every one of those asks is
 * an operator verb over HTTP, and every one of them needs the same three
 * things, is the daemon enabled, what base URL does it answer on, and what
 * bearer token proves this surface may call it. Resolving that in each seam is
 * how the old composition ended up with a DirectTransport in one place and a
 * real fetch in another.
 *
 * `resolveOperatorRpc` was previously the command layer's private helper
 * (input/commands/operator-rpc.ts). It moved here unchanged in behaviour so the
 * runtime seams, approvals, config, credentials, sessions, fleet, tasks,
 * devices, checkpoints, reach the daemon through the SAME resolution the
 * commands already used, and the command module now re-exports it.
 *
 * Refusals are values, never throws: a disabled daemon or an underivable base
 * URL comes back as `{ available: false, reason }` so a caller prints an honest
 * line instead of guessing. Once a call is made, a non-2xx (including the 404 a
 * daemon that has not wired a verb returns) throws `GoodVibesError` and
 * `describeOperatorRpcError` renders it.
 *
 * Auth for the daemon on this machine is the loopback file-token bootstrap: the
 * token is read (or minted) from the daemon's own state directory. A daemon this
 * terminal was pointed at (`daemon.connectedHost.url`) is dialled with the
 * bearer setup stored for that address in the terminal's own state
 * (connected-daemon-credentials.ts); the local daemon's record is left alone.
 * A session token from `/auth login daemon <baseUrl>` is held for that address
 * in the same record and is the bearer for it until `/auth logout` drops it.
 * `GOODVIBES_DAEMON_TOKEN`, when set, wins here, once, for every caller, as it
 * does for the daemon itself (`resolveDaemonEndpoint`).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createGoodVibesPlatform, isOperatorMethodId } from '@goodvibes-jev/engine/platform';
import type { GoodVibesPlatform } from '@goodvibes-jev/engine/platform';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { readConnectedDaemonOrigin, resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config/goodvibes-home';
import { getOrCreateCompanionToken } from '@goodvibes-jev/engine/platform/platform/pairing';
import { readConnectedDaemonToken, readDaemonSessionToken } from './connected-daemon-credentials.ts';
import { operatorTokenPath } from '@goodvibes-jev/engine/platform/platform/pairing/companion-token';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';

/** Re-exported so this repo's importers keep one import site for the shape
 * every client seam takes. See the doc comment further down for why
 * `OperatorRpc`/`OperatorRpcAvailable` (declared below, carrying `platform`)
 * structurally satisfy the platform's `DaemonReachability`, and so `DaemonVerbCaller`
 * built here still type-checks as the platform's own. */
export type { DaemonVerbCaller };

export interface OperatorRpcUnavailable {
  readonly available: false;
  readonly reason: string;
}

export interface OperatorRpcAvailable {
  readonly available: true;
  readonly platformClient: GoodVibesPlatform;
}

export type OperatorRpc = OperatorRpcUnavailable | OperatorRpcAvailable;

/**
 * Derive the dial address of the configured control-plane daemon.
 *
 * The daemon this terminal was pointed at (`daemon.connectedHost.url`) wins,
 * then an explicitly declared external address; otherwise the URL is DERIVED
 * from hostMode/host/port/tls.mode. This deliberately does not prefer a stored
 * `controlPlane.baseUrl`: that key had no writers and so drifted from the bind
 * on port, scheme, and host at once.
 */
export function resolveControlPlaneBaseUrl(configManager: Pick<ConfigManager, 'get'>): string | null {
  const connected = readConnectedDaemonOrigin((key) => configManager.get(key));
  if (connected) return connected.baseUrl;
  const explicit = String(configManager.get('controlPlane.publicBaseUrl' as never) ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = String(configManager.get('controlPlane.host') ?? '').trim();
  const port = configManager.get('controlPlane.port');
  if (host && typeof port === 'number' && port > 0) {
    const scheme = String(configManager.get('controlPlane.tls.mode') ?? 'off') !== 'off' ? 'https' : 'http';
    // A wildcard bind is not a dial target; loopback is the interface it answers on.
    const dialHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `${scheme}://${dialHost.includes(':') && !dialHost.startsWith('[') ? `[${dialHost}]` : dialHost}:${port}`;
  }
  return null;
}

/** Where an enabled daemon answers, or null when it is disabled or has no address. Reads settings only. */
export function resolveDaemonBaseUrl(configManager: Pick<ConfigManager, 'get'>): string | null {
  if (!resolveDaemonEnabled(configManager)) return null;
  return resolveControlPlaneBaseUrl(configManager);
}

/** The daemon's own state directory, where the shared bearer token lives. */
export function resolveDaemonStateDirectory(homeDirectory: string): string {
  return resolveGoodVibesDaemonHome(homeDirectory);
}

/** Where the daemon answers and the bearer this terminal presents to it, or why it cannot be reached. */
export type DaemonEndpoint =
  | { readonly available: true; readonly baseUrl: string; readonly token: string }
  | OperatorRpcUnavailable;

/**
 * How a caller obtains the bearer. `mint` creates the shared token file when it
 * is absent (a verb or a stream that is about to be used); `read-only` never
 * creates or rewrites anything (a status question must not change a credential).
 */
export type DaemonTokenMode = 'mint' | 'read-only';

/** The `GOODVIBES_DAEMON_TOKEN` override, applied in one place for every caller. */
function daemonTokenOverride(): string | null {
  return process.env.GOODVIBES_DAEMON_TOKEN?.trim() || null;
}

/**
 * The bearer this terminal presents to the daemon: the override when set,
 * otherwise the shared operator-tokens.json record (minted when absent in
 * `mint` mode). Read-only mode answers null for a missing or unreadable record.
 * Throws only in `mint` mode, when the record cannot be created.
 */
export function resolveDaemonBearer(homeDirectory: string, mode: DaemonTokenMode): string | null {
  const override = daemonTokenOverride();
  if (override) return override;
  const daemonHomeDir = resolveDaemonStateDirectory(homeDirectory);
  if (mode === 'mint') return getOrCreateCompanionToken('tui', { daemonHomeDir }).token;
  const path = operatorTokenPath(daemonHomeDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { token?: unknown } | null;
    return typeof parsed?.token === 'string' && parsed.token.trim() ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * The one resolver of "the daemon I talk to": enabled, base URL, bearer. Every
 * daemon call from this terminal (verbs, the approval stream, the Cloudflare
 * routes, the hosted-session stream) goes through it, so the override, the
 * mint rule and the refusals are the same everywhere. A refusal is a VALUE,
 * never a throw: callers print an honest line rather than crash a keystroke.
 */
export function resolveDaemonEndpoint(deps: {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly homeDirectory: string | (() => string);
  readonly mode?: DaemonTokenMode | undefined;
}): DaemonEndpoint {
  const { configManager } = deps;
  // A context whose config manager cannot answer (a narrow embed, a partially
  // wired test double) is one more case of "no daemon can be resolved".
  if (typeof (configManager as { get?: unknown } | null)?.get !== 'function') {
    return { available: false, reason: 'no config manager is wired here, so no control-plane daemon can be resolved.' };
  }
  if (!resolveDaemonEnabled(configManager)) {
    return { available: false, reason: 'the daemon is disabled (daemon.enabled=false): no operator surface to reach. Enable it in /settings, then retry.' };
  }
  const baseUrl = resolveControlPlaneBaseUrl(configManager);
  if (!baseUrl) {
    return { available: false, reason: 'no control-plane base URL is configured (daemon.connectedHost.url, controlPlane.publicBaseUrl or controlPlane.host+port): cannot reach the operator surface.' };
  }
  // Resolve the home directory only AFTER the static refusals, a caller whose
  // shell paths are not wired (a disabled-daemon path) must still get the honest
  // unavailable reason above, never a "shell paths not wired" throw.
  const homeDirectory = typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory;
  // A session the owner signed in to this daemon with (/auth login daemon) is the
  // bearer while it is held; /auth logout drops it and the address's own bearer applies.
  const session = daemonTokenOverride() ? null : readDaemonSessionToken(homeDirectory, baseUrl);
  if (session) return { available: true, baseUrl, token: session };
  // A daemon this terminal was pointed at is dialled with the bearer stored for that address; the
  // address and its token come from one record, so they cannot disagree.
  const connected = readConnectedDaemonOrigin((key) => configManager.get(key));
  if (connected) {
    const stored = daemonTokenOverride() ?? readConnectedDaemonToken(homeDirectory, connected.baseUrl);
    return stored
      ? { available: true, baseUrl, token: stored }
      : { available: false, reason: `no access token is stored for the daemon at ${connected.baseUrl}: connect to it again from setup (/setup, Network step) with its token.` };
  }
  let token: string | null;
  try {
    token = resolveDaemonBearer(homeDirectory, deps.mode ?? 'mint');
  } catch (error) {
    // An unwritable state directory or a token file that cannot be replaced is a
    // refusal like the others: the caller prints a line, nothing crashes.
    return {
      available: false,
      reason: `the daemon's access token could not be read or created (${error instanceof Error ? error.message : String(error)}): check that ${resolveDaemonStateDirectory(homeDirectory)} is writable, then retry.`,
    };
  }
  if (!token) {
    return { available: false, reason: `no daemon access token exists yet in ${resolveDaemonStateDirectory(homeDirectory)}: start the daemon or run any daemon command once, then retry.` };
  }
  return { available: true, baseUrl, token };
}

/**
 * Resolve (or honestly refuse to resolve) an operator platform client wired to this
 * workspace's control-plane daemon, from just the two things the resolution
 * actually needs, the config manager and the home directory.
 */
export function resolveOperatorRpc(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined;
}): OperatorRpc {
  const endpoint = resolveDaemonEndpoint(deps);
  if (!endpoint.available) return endpoint;
  return { available: true, platformClient: operatorClientFor(endpoint, deps.fetch) };
}

function operatorClientFor(endpoint: { readonly baseUrl: string; readonly token: string }, fetchImpl: typeof fetch | undefined): GoodVibesPlatform {
  const platformClient = createGoodVibesPlatform({ baseUrl: endpoint.baseUrl, authToken: endpoint.token, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return withGatewayRouteForWsOnlyVerbs(platformClient, endpoint.baseUrl, endpoint.token, fetchImpl ?? fetch);
}

/**
 * Render a thrown operator-rpc error honestly: a 404 means this daemon has not
 * wired a handler for the verb (a live daemon that simply doesn't implement it
 * yet), never "no result" or a fabricated empty state.
 */
export function describeOperatorRpcError(error: unknown): string {
  if (error instanceof GoodVibesError) {
    if (error.status === 404) {
      return 'the connected daemon returned 404; this operator verb is not wired up on that daemon yet.';
    }
    if (error.status === 401 || error.status === 403) {
      return `the connected daemon rejected the request (${error.status}): ${error.message}`;
    }
    if (error.code === 'CONTRACT_MISMATCH') {
      return `this terminal and the connected daemon disagree about an operator verb (${error.message}). Update whichever is older, then retry.`;
    }
    return `operator request failed${error.status ? ` (${error.status})` : ''}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The generic gateway-method route, for a verb the contract carries with a
 * WEBSOCKET binding only.
 *
 * This matters more than it looks. `platform.operator.invoke` resolves a method's
 * declared `http` route and refuses, with a contract error, before any request
 * is made, when the method has none. A large part of what this client needs is
 * exactly that class: `approvals.raise`, `credentials.set`/`delete`,
 * `checkpoints.*`, `rewind.*` and the `fleet.*` reads are all `transport: ws`
 * in the operator contract, with no REST path of their own.
 *
 * The daemon serves every catalogued verb over one generic route regardless of
 * its declared transport, which is what a client that is not holding a
 * websocket uses. Calling that route directly is not a workaround for a missing
 * binding: it IS the binding for a ws-declared verb reached over HTTP.
 */
async function invokeGatewayMethodOverHttp<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  authToken: string,
  methodId: string,
  input: unknown,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    // The envelope the route requires: `body` must be PRESENT even when empty,
    // or the route refuses with a 400 naming the shape it wanted.
    body: JSON.stringify({ body: input ?? {} }),
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const described = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new GoodVibesError(`'${methodId}' failed: ${described}`, {
      // Mapped from the status rather than fixed, so `describeOperatorRpcError`
      // and every caller that branches on category sees the same classification
      // it would have seen through the typed client path.
      category: response.status === 401 || response.status === 403
        ? 'authorization'
        : response.status === 404 ? 'not_found' : response.status >= 500 ? 'service' : 'bad_request',
      source: 'runtime',
      recoverable: response.status >= 500,
      status: response.status,
    });
  }
  return payload as T;
}

/**
 * True when the contract gives this verb a REST binding. An id the contract does
 * not know reads as bound, so the typed client reports it as the unknown method
 * it is instead of this layer sending it to the daemon.
 */
function hasHttpBinding(client: GoodVibesPlatform, methodId: string): boolean {
  if (!isOperatorMethodId(methodId)) return true;
  try {
    return client.operator.getOperation(methodId).http !== undefined;
  } catch {
    return true;
  }
}

/**
 * Every consumer of `platformClient.operator.invoke` reaches ws-only verbs
 * (`cost.attribution.get`, `acp.*`, `fleet.*`, `worktrees.*`, `tailscale.*`...)
 * through this wrapper. The decision is made from the descriptor, never from a
 * failed call, so an HTTP-bound verb that fails for a real reason is never
 * repeated and a mutation is never sent twice.
 */
function withGatewayRouteForWsOnlyVerbs(
  client: GoodVibesPlatform,
  baseUrl: string,
  authToken: string,
  fetchImpl: typeof fetch,
): GoodVibesPlatform {
  const typedInvoke = client.operator.invoke;
  const invoke = ((methodId: string, ...rest: unknown[]) => {
    if (hasHttpBinding(client, methodId)) return (typedInvoke as (id: string, ...args: unknown[]) => Promise<unknown>)(methodId, ...rest);
    return invokeGatewayMethodOverHttp<unknown>(fetchImpl, baseUrl, authToken, methodId, rest[0]);
  }) as typeof typedInvoke;
  return { ...client, operator: { ...client.operator, invoke } };
}

/**
 * The verb caller every client seam shares. The endpoint and its client are
 * resolved on first use and kept while nothing they depend on moved: the
 * settings revision, the token override and the token file (one `stat` per
 * verb). Before this, every verb re-read the token file and built a new client.
 */
export function createDaemonVerbCaller(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}): DaemonVerbCaller {
  let held: { readonly key: string; readonly rpc: OperatorRpc } | null = null;
  const currentKey = (): string | null => {
    const configManager = deps.configManager as Partial<Pick<ConfigManager, 'getConfigurationIncarnation'>>;
    if (typeof configManager.getConfigurationIncarnation !== 'function') return null;
    let tokenFile = 'none';
    try {
      const homeDirectory = typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory;
      const stat = statSync(operatorTokenPath(resolveDaemonStateDirectory(homeDirectory)), { throwIfNoEntry: false });
      if (stat) tokenFile = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      return null; // shell paths not wired yet: resolve fresh and let the resolver say why
    }
    return `${configManager.getConfigurationIncarnation()}|${daemonTokenOverride() ?? ''}|${tokenFile}`;
  };
  const resolve = (): OperatorRpc => {
    const key = currentKey();
    if (key !== null && held?.key === key) return held.rpc;
    const rpc = resolveOperatorRpc(deps);
    // Only an available client is kept: a refusal is re-asked, so fixing the cause takes effect at once.
    held = key !== null && rpc.available ? { key, rpc } : null;
    return rpc;
  };
  return {
    probe: () => resolve(),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      const rpc = resolve();
      if (!rpc.available) throw new Error(`cannot invoke '${methodId}': ${rpc.reason}`);
      return await rpc.platformClient.operator.invoke(methodId as never, (input ?? {}) as never) as T;
    },
  };
}
