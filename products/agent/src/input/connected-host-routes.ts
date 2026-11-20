/**
 * Read-only connected-host reads for commands and workspace views, as result
 * values. The host, the credential, the deadline and what a failure means all
 * come from the Agent's one connected-host client (`agent/connected-host-client.ts`),
 * so `/channels accounts` and `/payments cards` talk to the host as the same
 * principal and a failure names which credential source was used.
 */
import { homedir } from 'node:os';
import { createConnectedHost, formatHostFailure, isHostFailure, resolveConnectedHost, type ConnectedHostInvokeOptions, type ConnectedHostSelection, type ConnectedHostSource, type ConnectedHostUnavailable, type HostFailureKind } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
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
  try {
    // Display readers take each field defensively, so the answer is not walked against the schema.
    const host = createConnectedHost(selectionFor(context), { validateResponses: false });
    // Method ids here come from callers as strings; the client checks the id against the contract.
    const invoke = host.invoke as unknown as (methodId: string, input: unknown, options?: ConnectedHostInvokeOptions) => Promise<unknown>;
    const body = await invoke(methodId, input, options.timeoutMs === undefined ? {} : { deadlineMs: options.timeoutMs });
    return { ok: true, route: methodId, body };
  } catch (error) {
    // Not a failure the host reported (resolving the host from settings threw,
    // or the method id is not in the contract): still a reading that says why.
    if (!isHostFailure(error)) return localFailure(context, methodId, error);
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

function localFailure(context: CommandContext, methodId: string, error: unknown): ConnectedHostRouteFailure {
  let baseUrl = '(not resolved)';
  try {
    baseUrl = resolveConnectedHostConnection(context).baseUrl;
  } catch {
    // The same settings read that failed; the message below names the cause.
  }
  return {
    ok: false,
    route: methodId,
    kind: 'connected_host_error',
    baseUrl,
    message: `the call was not sent: ${error instanceof Error ? error.message : String(error)}; next: check the connected-host settings with /settings, then try again`,
  };
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

/**
 * Call one operator method on the connected host for a described command:
 * its typed output, or a refusal saying what failed, why and what to do next.
 * A line the owner typed carries the explicit-request mark; one a model ran
 * does not.
 */
export function invokeConnectedHostMethod<M extends OperatorMethodId>(context: CommandContext, method: M, input: OperatorMethodInput<M>): Promise<OperatorMethodOutput<M>> {
  const refusalOf = (error: unknown): Error => isHostFailure(error)
    ? commandRefusal(formatHostFailure(error))
    : commandRefusal(`The call to the connected host was not sent: ${error instanceof Error ? error.message : String(error)}`, 'Check the connected-host settings with /settings, then try again');
  // Not awaited here: awaiting the output of a generic method id makes the
  // compiler expand every method's output at once.
  try {
    return createConnectedHost(selectionFor(context)).invoke(method, input, { explicitUserRequest: context.invokedByModel !== true }).catch((error: unknown) => { throw refusalOf(error); });
  } catch (error) {
    return Promise.reject(refusalOf(error));
  }
}
