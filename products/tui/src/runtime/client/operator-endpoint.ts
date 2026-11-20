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
 * Which daemon and which credential is the engine's one resolver
 * (platform/runtime/client/daemon-target-resolver.ts): the daemon this terminal
 * was pointed at (`daemon.connectedHost.url`) with the bearer stored for that
 * address, or an `/accounts sign-in daemon` session held for it; otherwise the daemon
 * on this machine with `GOODVIBES_DAEMON_TOKEN` or the token read (or minted)
 * from its own state directory. This machine's token is never sent to another
 * daemon's address.
 */
import { statSync } from 'node:fs';
import { createGoodVibesPlatform, getOperatorMethod, isOperatorMethodId } from '@goodvibes/engine/platform';
import type { GoodVibesPlatform } from '@goodvibes/engine/platform';
import { GoodVibesError } from '@goodvibes/engine/errors';
import { validateOperatorResponse } from '@goodvibes/engine/operator-client/client-core';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { formatRefusal } from '@goodvibes/engine/errors';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { getOrCreateCompanionToken } from '@goodvibes/engine/platform/platform/pairing';
import { connectedDaemonCredentialsPath, connectedDaemonCredentialsRevision } from '@goodvibes/engine/platform/platform/runtime/client/daemon-credentials';
import { bearerFor, type DaemonTarget } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target';
import { configuredDaemonOrigin, resolveDaemonTarget, resolveDaemonTargetProven, type DaemonTargetResolution } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import { operatorTokenPath } from '@goodvibes/engine/platform/platform/pairing/companion-token';
import { readDaemonOperatorBearer } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';

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
  /** The daemon this client calls (`DaemonTarget.origin.baseUrl`): what an attachment, a queued item or a draft records as its daemon. */
  readonly origin: string;
}

export type OperatorRpc = OperatorRpcUnavailable | OperatorRpcAvailable;

/**
 * The dial address of the configured daemon: the engine resolver's choice
 * (the connected host, a declared public address, else the address derived
 * from the bind), never a stored `controlPlane.baseUrl`.
 */
export function resolveControlPlaneBaseUrl(configManager: Pick<ConfigManager, 'get'>): string | null {
  return configuredDaemonOrigin(configManager)?.baseUrl ?? null;
}

/** Where an enabled daemon answers, or null when it is disabled or has no address. Reads settings only. */
export function resolveDaemonBaseUrl(configManager: Pick<ConfigManager, 'get'>): string | null {
  if (configManager.get('daemon.enabled') === false) return null;
  return resolveControlPlaneBaseUrl(configManager);
}

/** The daemon's own state directory, where the shared bearer token lives. */
export function resolveDaemonStateDirectory(homeDirectory: string): string {
  return resolveGoodVibesDaemonHome(homeDirectory);
}

/** Where the daemon answers and the bearer this terminal presents to it, or why it cannot be reached. */
export type DaemonEndpoint =
  | { readonly available: true; readonly baseUrl: string; readonly token: string; readonly target: DaemonTarget }
  | OperatorRpcUnavailable;

/**
 * How a caller obtains the bearer. `mint` creates the shared token file when it
 * is absent (a verb or a stream that is about to be used); `read-only` never
 * creates or rewrites anything (a status question must not change a credential).
 */
export type DaemonTokenMode = 'mint' | 'read-only';

/** GOODVIBES_DAEMON_TOKEN: when set it is the bearer for the daemon on this machine, ahead of a session or its token file; never sent to another daemon. */
export function daemonTokenOverride(): string | null {
  return process.env.GOODVIBES_DAEMON_TOKEN?.trim() || null;
}

/**
 * The bearer this terminal presents to the daemon: the override when set,
 * otherwise the shared operator-tokens.json record (minted when absent in
 * `mint` mode). Read-only mode answers null for a missing or unreadable record.
 * Throws only in `mint` mode, when the record cannot be created.
 */
export function resolveDaemonBearer(homeDirectory: string, mode: DaemonTokenMode): string | null {
  // Read-only is the engine's one reader, shared with the Agent.
  if (mode !== 'mint') return readDaemonOperatorBearer(homeDirectory);
  const override = daemonTokenOverride();
  if (override) return override;
  return getOrCreateCompanionToken('tui', { daemonHomeDir: resolveDaemonStateDirectory(homeDirectory) }).token;
}

type EndpointDeps = {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly homeDirectory: string | (() => string);
  readonly mode?: DaemonTokenMode | undefined;
};

function targetInput(deps: EndpointDeps) {
  return { configManager: deps.configManager, homeDirectory: deps.homeDirectory, mode: deps.mode ?? 'mint', client: 'tui' } as const;
}

function endpointOf(resolution: DaemonTargetResolution): DaemonEndpoint {
  if (!resolution.ok) return { available: false, reason: formatRefusal(resolution.refusal) };
  const { target } = resolution;
  if (target.credential === null) return { available: false, reason: `no credential was resolved for ${target.origin.baseUrl}.` };
  return { available: true, baseUrl: target.origin.baseUrl, token: bearerFor(target.credential, target.origin.baseUrl), target };
}

/**
 * The one resolver of "the daemon I talk to": enabled, base URL, bearer, as
 * the engine's daemon target resolver decides them, so the override, the mint
 * rule, the per-origin credentials and the refusals are the same for every
 * daemon call from this terminal. A refusal is a VALUE, never a throw: callers
 * print an honest line rather than crash a keystroke. A declared public
 * address of this machine's daemon is resolved after its one identity check
 * (bounded by the check's timeout), so the first call after start succeeds or
 * fails for a real reason.
 */
export async function resolveDaemonEndpoint(deps: EndpointDeps): Promise<DaemonEndpoint> {
  try {
    return endpointOf(await resolveDaemonTargetProven(targetInput(deps)));
  } catch (error) {
    // Shell paths not wired, an unreadable home: one more case of "cannot be resolved".
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve (or honestly refuse to resolve) an operator platform client wired to this
 * workspace's control-plane daemon, from just the two things the resolution
 * actually needs, the config manager and the home directory. Synchronous for
 * its many callers: while this machine's declared public address still has to
 * prove itself, the client is returned at once and its first request waits for
 * that check (the bearer is read per request), so nothing is refused for it
 * and the token is sent only once the address proved it is this daemon.
 */
export function resolveOperatorRpc(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined;
}): OperatorRpc {
  const input = targetInput(deps);
  let resolution: DaemonTargetResolution;
  try {
    resolution = resolveDaemonTarget(input);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!resolution.ok && resolution.pendingProof) {
    const proven = async (): Promise<string> => {
      const endpoint = endpointOf(await resolveDaemonTargetProven(input));
      if (!endpoint.available) throw new GoodVibesError(endpoint.reason, { category: 'authorization', source: 'transport', code: 'CREDENTIAL_NOT_FOR_TARGET', recoverable: false });
      return endpoint.token;
    };
    return { available: true, origin: resolution.pendingProof.baseUrl, platformClient: operatorClientFor(resolution.pendingProof.baseUrl, proven, deps.fetch) };
  }
  const endpoint = endpointOf(resolution);
  if (!endpoint.available) return endpoint;
  const token = endpoint.token;
  return { available: true, origin: endpoint.baseUrl, platformClient: operatorClientFor(endpoint.baseUrl, async () => token, deps.fetch) };
}

function operatorClientFor(baseUrl: string, bearer: () => Promise<string>, fetchImpl: typeof fetch | undefined): GoodVibesPlatform {
  // Every call names this app, so what the owner does here is attributed to the terminal (an inbox answer says tui).
  const base = fetchImpl ?? fetch;
  const named = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-goodvibes-client', 'tui');
    return base(input, { ...init, headers });
  }) as typeof fetch;
  const platformClient = createGoodVibesPlatform({ baseUrl, getAuthToken: bearer, fetch: named });
  return withGatewayRouteForWsOnlyVerbs(platformClient, baseUrl, bearer, named);
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
  bearer: () => Promise<string>,
  methodId: string,
  input: unknown,
): Promise<T> {
  const authToken = await bearer();
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
  // The same check the typed client applies to an HTTP-bound verb, so a daemon
  // of another version is reported as a contract mismatch naming the field,
  // not as a TypeError inside the command that read the answer.
  const method = getOperatorMethod(methodId);
  if (method) await validateOperatorResponse(method, payload);
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
  bearer: () => Promise<string>,
  fetchImpl: typeof fetch,
): GoodVibesPlatform {
  const typedInvoke = client.operator.invoke;
  const invoke = ((methodId: string, ...rest: unknown[]) => {
    if (hasHttpBinding(client, methodId)) return (typedInvoke as (id: string, ...args: unknown[]) => Promise<unknown>)(methodId, ...rest);
    return invokeGatewayMethodOverHttp<unknown>(fetchImpl, baseUrl, bearer, methodId, rest[0]);
  }) as typeof typedInvoke;
  return { ...client, operator: { ...client.operator, invoke } };
}

/**
 * The verb caller every client seam shares. The endpoint and its client are
 * resolved on first use and kept while nothing they depend on moved: the
 * settings revision, the token override, the token file and this terminal's
 * own credential record (`/accounts sign-in daemon`, `/accounts sign-out`, a connect with a
 * new token: a revision for its writes here, a `stat` for one from another
 * process). Two `stat` calls per verb; before this, every verb re-read the
 * token file and built a new client.
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
    let credentialRecord = 'none';
    try {
      const homeDirectory = typeof deps.homeDirectory === 'function' ? deps.homeDirectory() : deps.homeDirectory;
      const stat = statSync(operatorTokenPath(resolveDaemonStateDirectory(homeDirectory)), { throwIfNoEntry: false });
      if (stat) tokenFile = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
      const record = statSync(connectedDaemonCredentialsPath(homeDirectory), { throwIfNoEntry: false });
      if (record) credentialRecord = `${record.mtimeMs}:${record.size}:${record.ino}`;
    } catch {
      return null; // shell paths not wired yet: resolve fresh and let the resolver say why
    }
    return `${configManager.getConfigurationIncarnation()}|${daemonTokenOverride() ?? ''}|${tokenFile}|${connectedDaemonCredentialsRevision()}:${credentialRecord}`;
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

/** A verb caller that stays on the daemon it was first resolved to. */
export interface PinnedDaemonVerbCaller {
  readonly caller: DaemonVerbCaller;
  /** The daemon every call goes to (`DaemonTarget.origin.baseUrl`). */
  readonly origin: string;
  /** Whether this terminal still talks to that daemon (the selection has not moved to another). */
  readonly isCurrent: () => boolean;
}

/**
 * A verb caller for state that belongs to one daemon (a hosted attachment):
 * it follows a new credential for the same daemon, and when the selected
 * daemon changes it keeps calling the daemon it was made for with the client
 * it last held, so releasing the attachment reaches the daemon that holds it
 * instead of sending its session id to the newly selected one.
 */
export function pinDaemonVerbCaller(deps: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}): PinnedDaemonVerbCaller | OperatorRpcUnavailable {
  const live = createDaemonVerbCaller(deps);
  const first = live.probe() as unknown as OperatorRpc;
  if (!first.available) return first;
  const origin = first.origin;
  let held: OperatorRpcAvailable = first;
  const current = (): OperatorRpcAvailable => {
    const rpc = live.probe() as unknown as OperatorRpc;
    if (rpc.available && rpc.origin === origin) held = rpc;
    return held;
  };
  return {
    origin,
    isCurrent: () => { const rpc = live.probe() as unknown as OperatorRpc; return rpc.available && rpc.origin === origin; },
    caller: {
      probe: () => current(),
      invoke: async <T,>(methodId: string, input?: unknown): Promise<T> =>
        await current().platformClient.operator.invoke(methodId as never, (input ?? {}) as never) as T,
    },
  };
}
