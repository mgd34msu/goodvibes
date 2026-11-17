/**
 * family-gateway.ts, how the Agent's profile and occasions tools reach the
 * daemon's `profile.*` and `occasions.*` verbs.
 *
 * In the daemon, and in an Agent process that carries the handlers itself, the
 * call runs in-process on the gateway catalog. An Agent process without them
 * hands in `remote`, its connected-host route; the daemon hands in none, since
 * it is the owner of these verbs. With neither, the call is refused with that
 * said, and nothing is sent.
 */
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import type { GatewayMethodCatalog, GatewayMethodInvocation } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { assertCurrentProfileDelegation, bindProfileMutationOptionsToInvocation, type ProfileMutationOptions } from '@goodvibes-jev/engine/platform/platform/owner-profile';
import { assertProjectionCurrent } from '@goodvibes-jev/engine/platform/platform/tools';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { findOperatorHttpBinding } from './operator-contract-routes.js';

export interface FamilyGatewayResult {
  readonly ok: boolean;
  /** Raw payload; the caller narrows it. */
  readonly data: unknown;
  /** Present only when `ok` is false. */
  readonly error?: string | undefined;
  /** Which route the call actually took. */
  readonly route: 'in-process' | 'connected-host' | 'unavailable';
}

/**
 * The route a call takes when this process's catalog has no handler for it:
 * the Agent process's connected host. `assertCurrent` is the caller's check,
 * run once more immediately before the request leaves.
 */
export type FamilyGatewayRemote = <TMethodId extends OperatorMethodId>(
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
  lifetime: ProfileMutationOptions,
  assertCurrent: () => void,
) => Promise<FamilyGatewayResult>;

/** A family gateway's wiring: this process's own catalog when it carries the handlers, and the remote route otherwise. */
export interface FamilyGatewayOptions {
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly remote?: FamilyGatewayRemote | undefined;
}

/** The contract's route for a method, `GET /api/...`, for messages and help. */
export function operatorRouteLabel(methodId: OperatorMethodId): string {
  const binding = findOperatorHttpBinding(methodId);
  return binding ? `${binding.httpMethod} ${binding.pathTemplate}` : methodId;
}

/**
 * Call one method of a family the daemon owns (the owner profile, occasions):
 * in-process when this process's catalog has the handler, otherwise on the
 * remote route. The caller's check runs at the start and, for a remote call,
 * once more immediately before the request leaves. Nothing is re-checked after
 * the answer: it cannot be un-sent.
 */
export async function invokeFamilyGatewayMethod<TMethodId extends OperatorMethodId>(
  options: FamilyGatewayOptions,
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
  lifetime: ProfileMutationOptions,
  principalKind: 'user' | 'service',
): Promise<FamilyGatewayResult> {
  const assertCurrent = (): void => {
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
  if (options.remote) return options.remote(methodId, body, lifetime, assertCurrent);
  return {
    ok: false,
    data: null,
    error: `${methodId} is not served in this process and no connected host is configured here, so nothing was sent; run it where the daemon is reachable.`,
    route: 'unavailable',
  };
}

/**
 * A check a tool runs while preparing a family call: that the route it will
 * take (in-process or remote) is still the one it was prepared for. Two
 * identity compares; the credential is checked by the call itself.
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
