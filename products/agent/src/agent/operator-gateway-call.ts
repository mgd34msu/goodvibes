/**
 * Typed connected-host operator gateway calls for CLI and Agent features: a
 * result-value face over the one connected-host client
 * (connected-host-client.ts), which owns resolution, deadlines and failure
 * classification. Never retries an operator mutation.
 */
import type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { createConnectedHost, isHostFailure, type HostCallApplied, type HostRefusal } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { connectedHostOf, type AgentConnectedHostConnection } from '@goodvibes/engine/terminal-shell/agent-turn/routine-schedules';

export type OperatorGatewayCallFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_incompatible'
  | 'connected_host_route_unavailable'
  | 'connected_host_error'
  | 'cancelled';

export interface OperatorGatewayCallSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly methodId: OperatorMethodId;
  readonly route: string;
}

export interface OperatorGatewayCallFailure {
  readonly ok: false;
  readonly kind: OperatorGatewayCallFailureKind;
  /** `<what failed>: <cause>; <next step>`. */
  readonly error: string;
  readonly methodId: OperatorMethodId;
  readonly route: string;
  readonly baseUrl?: string;
  /** State, reason and next steps, for a caller that renders them itself. */
  readonly refusal?: HostRefusal;
  /** Whether the host may have acted: `unknown` for a write that was sent and not answered. */
  readonly applied?: HostCallApplied;
}

export type OperatorGatewayCallResult<T> = OperatorGatewayCallSuccess<T> | OperatorGatewayCallFailure;

export interface OperatorGatewayCallOptions {
  readonly signal?: AbortSignal | undefined;
  /** The caller's currency check, run once before the request leaves. */
  readonly assertCurrent?: (() => void) | undefined;
}

/**
 * Invoke one operator gateway method against the connected host, returning a
 * discriminated result instead of throwing. `route` is the caller's label; the
 * route reported back is the one the operator contract binds the method to.
 *
 * The payload is bound to `OperatorMethodInput<TMethodId>`, so a body that
 * does not match the method's declared input is a compile error at the call
 * site rather than a runtime 400.
 */
export async function invokeOperatorGatewayMethod<TMethodId extends OperatorMethodId>(
  connection: AgentConnectedHostConnection,
  methodId: TMethodId,
  route: string,
  payload: OperatorMethodInput<TMethodId>,
  options: OperatorGatewayCallOptions = {},
): Promise<OperatorGatewayCallResult<OperatorMethodOutput<TMethodId>>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const host = createConnectedHost(() => connectedHostOf(connection));
  // Wrap the typed result before it is awaited: awaiting a still-generic
  // operator output makes TypeScript expand every method's output.
  return host.invoke(methodId, payload, { signal: options.signal }).then(
    (data): OperatorGatewayCallSuccess<OperatorMethodOutput<TMethodId>> => ({ ok: true, data, methodId, route }),
    (error: unknown): OperatorGatewayCallFailure => isHostFailure(error)
      ? { ok: false, kind: error.kind, error: error.message, methodId, route: error.route, baseUrl: error.baseUrl,
        refusal: error.refusal, applied: error.applied }
      : { ok: false, kind: 'connected_host_error', error: error instanceof Error ? error.message : String(error),
        methodId, route, baseUrl: connection.baseUrl },
  );
}

export function formatOperatorGatewayFailure(failure: OperatorGatewayCallFailure): string {
  const lines = [
    `Connected-host call failed: ${failure.methodId} (${failure.kind})`,
    `  route ${failure.route}`,
    failure.baseUrl ? `  connected host ${failure.baseUrl}` : '',
    `  ${failure.error}`,
  ];
  return lines.filter(Boolean).join('\n');
}
