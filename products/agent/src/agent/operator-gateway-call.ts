/**
 * Typed connected-host operator gateway calls for CLI and Agent features: a
 * result-value face over the one connected-host client
 * (connected-host-client.ts), which owns resolution, deadlines and failure
 * classification. Never retries an operator mutation.
 */
import type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform/contracts';
import type { GatewayMethodCatalog, GatewayMethodInvocation } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { assertCurrentProfileDelegation, bindProfileMutationOptionsToInvocation, type ProfileMutationOptions } from '@goodvibes-jev/engine/platform/platform/owner-profile';
import { assertProjectionCurrent } from '@goodvibes-jev/engine/platform/platform/tools';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { delegatedOperatorConnection, forgetDelegatedCredential } from './agent-delegation-credential.ts';
import { createConnectedHost, isHostFailure, type HostCallApplied, type HostRefusal } from './connected-host-client.ts';
import { captureOperatorConnection } from './operator-connection-owner.ts';
import { findOperatorHttpBinding } from './operator-contract-routes.ts';
import type { AgentConnectedHostConfigReader, AgentConnectedHostConnection } from './routine-schedule-promotion.ts';

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
  const host = createConnectedHost(() => ({ baseUrl: connection.baseUrl, token: connection.token, credential: connection.tokenPath }));
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

// ── Method families served in-process or by the connected host ────────────

/** A family gateway's wiring: this process's own catalog when it carries the handlers, and the connected host otherwise. */
export interface FamilyGatewayOptions {
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly configManager: AgentConnectedHostConfigReader;
  readonly homeDirectory: string;
}

export interface FamilyGatewayResult {
  readonly ok: boolean;
  /** Raw payload; the caller narrows it. */
  readonly data: unknown;
  /** Present only when `ok` is false. */
  readonly error?: string;
  /** Which route the call actually took. */
  readonly route: 'in-process' | 'connected-host' | 'unavailable';
}

/** The contract's route for a method, `GET /api/...`, for messages and help. */
export function operatorRouteLabel(methodId: OperatorMethodId): string {
  const binding = findOperatorHttpBinding(methodId);
  return binding ? `${binding.httpMethod} ${binding.pathTemplate}` : methodId;
}

/**
 * Call one method of a family the daemon owns (the owner profile, occasions):
 * in-process when this process's catalog has the handler, otherwise on the
 * connected host. The caller's check runs at the start and once more,
 * immediately before a remote request leaves; the credential is resolved once
 * per call into a value and verified there with one `lstat`. Nothing is
 * re-checked after the answer: it cannot be un-sent, and the host authenticates
 * every request with the token it is sent. A call made on the owner's behalf
 * (`lifetime.delegation`) is sent with this Agent's delegated credential, so
 * the host judges it as the Agent's (agent-delegation-credential.ts).
 */
export async function invokeFamilyGatewayMethod<TMethodId extends OperatorMethodId>(
  options: FamilyGatewayOptions,
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
  lifetime: ProfileMutationOptions,
  principalKind: 'user' | 'service',
): Promise<FamilyGatewayResult> {
  const assertCurrent = () => {
    lifetime.signal?.throwIfAborted();
    assertProjectionCurrent(lifetime.assertCurrent);
    if (lifetime.delegation) assertCurrentProfileDelegation(lifetime.delegation);
  };
  assertCurrent();
  const catalog = options.gatewayMethods;
  if (catalog?.hasHandler(methodId)) {
    try {
      const invocation: GatewayMethodInvocation = {
        body,
        signal: lifetime.signal,
        isAuthorized: () => { assertCurrent(); return true; },
        context: { clientKind: 'goodvibes-agent', principalKind },
      };
      bindProfileMutationOptionsToInvocation(lifetime, invocation);
      const data = await catalog.invoke(methodId, invocation);
      return { ok: true, data, route: 'in-process' };
    } catch (error) {
      // A cancellation or a withdrawn admission is not a handler failure: it propagates.
      assertCurrent();
      return { ok: false, data: null, error: summarizeError(error), route: 'in-process' };
    }
  }

  const ordinary = captureOperatorConnection(options, options.configManager, assertCurrent);
  let delegated: Awaited<ReturnType<typeof delegatedOperatorConnection>> | undefined;
  if (lifetime.delegation) {
    try { delegated = await delegatedOperatorConnection(ordinary, options.homeDirectory, lifetime.signal); }
    catch (error) {
      lifetime.signal?.throwIfAborted();
      return { ok: false, data: null, error: summarizeError(error), route: 'connected-host' };
    }
  }
  const connection = delegated ?? ordinary;
  const result = await invokeOperatorGatewayMethod(connection, methodId, operatorRouteLabel(methodId), body,
    { signal: lifetime.signal, assertCurrent: connection.assertCurrent });
  // A delegated credential the host no longer accepts is forgotten; the next call makes a new one.
  if (!result.ok && result.refusal?.code === 'auth_rejected' && delegated) await forgetDelegatedCredential(delegated);
  return result.ok
    ? { ok: true, data: result.data, route: 'connected-host' }
    : { ok: false, data: null, error: formatOperatorGatewayFailure(result), route: 'connected-host' };
}

/**
 * A check a tool runs while preparing a family call: that the route it will
 * take (in-process or connected host) is still the one it was prepared for.
 * Two identity compares; the credential is checked by the call itself.
 */
export function captureFamilyGatewayRoute(options: FamilyGatewayOptions | undefined, methodId: OperatorMethodId | undefined, family: string): () => void {
  if (!options) return () => {};
  const catalog = options.gatewayMethods;
  const inProcess = methodId !== undefined && catalog?.hasHandler(methodId) === true;
  return () => {
    if (options.gatewayMethods !== catalog || (methodId !== undefined && (catalog?.hasHandler(methodId) === true) !== inProcess)) {
      throw new Error(`The ${family} gateway's route changed while this call was prepared (the in-process handlers were added or removed); nothing was sent. Retry the call.`);
    }
  };
}
