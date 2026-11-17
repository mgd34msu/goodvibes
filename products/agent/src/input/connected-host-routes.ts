/**
 * Read-only connected-host reads for commands and workspace views, as result
 * values. The host, the credential, the deadline and what a failure means all
 * come from the Agent's one connected-host client (`agent/connected-host-client.ts`),
 * so `/channels accounts` and `/payments status` talk to the host as the same
 * principal and a failure names which credential source was used.
 */
import { homedir } from 'node:os';
import { createConnectedHost, isHostFailure, resolveConnectedHost, type ConnectedHostInvokeOptions, type ConnectedHostSelection, type ConnectedHostSource, type ConnectedHostUnavailable, type HostFailureKind } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-client';
import type { CommandContext } from './command-registry.ts';

export interface ConnectedHostConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the credential was looked for: a file path, the pairing store or an environment variable. */
  readonly tokenPath: string;
  readonly source?: ConnectedHostSource;
  /** Why there is no usable credential, with the next step; present when `token` is null. */
  readonly unavailable?: ConnectedHostUnavailable;
}

export interface ConnectedHostRouteSuccess {
  readonly ok: true;
  readonly route: string;
  readonly body: unknown;
}

export interface ConnectedHostRouteFailure {
  readonly ok: false;
  readonly route: string;
  readonly kind: HostFailureKind;
  readonly baseUrl: string;
  /** The cause, then the next step. */
  readonly message: string;
  readonly source?: ConnectedHostSource;
}

export type ConnectedHostRouteResult = ConnectedHostRouteSuccess | ConnectedHostRouteFailure;

export const CONNECTED_HOST_FAILURE_LABELS: Record<HostFailureKind, string> = {
  auth_required: 'auth required',
  connected_host_unavailable: 'connected host unavailable',
  connected_host_incompatible: 'connected host is a different version',
  connected_host_route_unavailable: 'connected host route unavailable',
  connected_host_error: 'connected host error',
  cancelled: 'cancelled',
};

function selectionFor(context: CommandContext): ConnectedHostSelection {
  return {
    configManager: context.platform.configManager,
    homeDirectory: () => context.workspace?.shellPaths?.homeDirectory ?? homedir(),
  };
}

/** The host and credential every connected-host feature uses, resolved by the one precedence. */
export function resolveConnectedHostConnection(context: CommandContext): ConnectedHostConnection {
  const resolved = resolveConnectedHost(selectionFor(context));
  return {
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    tokenPath: resolved.credential,
    ...(resolved.source === undefined ? {} : { source: resolved.source }),
    ...(resolved.unavailable === undefined ? {} : { unavailable: resolved.unavailable }),
  };
}

/**
 * Call one read-only operator method on the connected host. Never throws:
 * every failure comes back with its kind, its cause and the next step.
 */
export async function readConnectedHostMethod(
  context: CommandContext,
  methodId: string,
  input: Record<string, unknown> = {},
  options: { readonly timeoutMs?: number } = {},
): Promise<ConnectedHostRouteResult> {
  // Display readers take each field defensively, so the answer is not walked against the schema.
  const host = createConnectedHost(selectionFor(context), { validateResponses: false });
  // Method ids here come from callers as strings; the client checks the id against the contract.
  const invoke = host.invoke as unknown as (methodId: string, input: unknown, options?: ConnectedHostInvokeOptions) => Promise<unknown>;
  try {
    const body = await invoke(methodId, input, options.timeoutMs === undefined ? {} : { deadlineMs: options.timeoutMs });
    return { ok: true, route: methodId, body };
  } catch (error) {
    if (!isHostFailure(error)) throw error;
    const next = error.refusal.next[0];
    return {
      ok: false,
      route: error.route,
      kind: error.kind,
      baseUrl: error.baseUrl,
      message: `${error.refusal.reason}${next ? `; next: ${next}` : ''}`,
      ...(error.source === undefined ? {} : { source: error.source }),
    };
  }
}

export function formatConnectedHostRouteFailure(
  title: string,
  failure: ConnectedHostRouteFailure,
  policy = 'read-only; no mutation route was called',
): string {
  return [
    `${title}: unavailable`,
    `  status: ${CONNECTED_HOST_FAILURE_LABELS[failure.kind]}`,
    `  kind: ${failure.kind}`,
    `  connected host: ${failure.baseUrl}${failure.source ? ` (credential from ${failure.source})` : ''}`,
    `  route: ${failure.route}`,
    `  error: ${failure.message}`,
    `  policy: ${policy}`,
  ].join('\n');
}
