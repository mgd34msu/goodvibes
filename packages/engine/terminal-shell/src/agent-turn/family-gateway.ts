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
import { pairingTokenCaller, refuseGatewayInvocation, type GatewayMethodCatalog, type GatewayMethodInvocation } from '@goodvibes-jev/engine/platform/platform/control-plane';
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
  /**
   * The credential an in-process call is made under. `agent` in a turn the
   * daemon hosts for the Agent: the call is admitted and judged as the paired
   * Agent's call over the wire is (`agentInProcessAdmission`). Omitted ⇒ none,
   * the in-process call an Agent process carrying the handlers makes.
   */
  readonly credentialKind?: 'agent' | undefined;
}

/** How an in-process call made as the Agent is admitted, before the handler runs and on each scope it asks for. */
export interface AgentInProcessAdmission {
  /** Why the call is refused before it runs; null when it is admitted. */
  readonly refused: string | null;
  /** The caller the handler sees: the Agent's pairing grant, judged as the Agent's call. */
  readonly context: {
    readonly principalKind: 'token';
    readonly admin: boolean;
    readonly scopes: readonly string[];
    readonly credentialKind: 'agent';
  };
  /** The live check a handler makes for the scopes it needs while it runs. */
  readonly isAuthorized: (requiredScopes?: readonly string[]) => boolean;
}

/**
 * The admission of a call the daemon makes in-process as the Agent. Over the
 * wire the paired Agent's token carries `pairingTokenCaller`'s grant (its
 * pairing is minted with no narrower scope list) and dispatch holds the call
 * to `refuseGatewayInvocation`, at the start and on every
 * `isAuthorized(scopes)` the handler asks. This applies the same caller and
 * the same function, so a hosted Agent call can do neither more nor less than
 * the same call from the paired Agent. The catalog keeps its grant cached:
 * each check is a set lookup per scope.
 */
export function agentInProcessAdmission(catalog: GatewayMethodCatalog, methodId: string): AgentInProcessAdmission {
  const descriptor = catalog.get(methodId);
  const caller = pairingTokenCaller(catalog);
  const refusal = descriptor ? refuseGatewayInvocation(descriptor, caller) : null;
  const reason = refusal?.body['error'];
  return {
    refused: descriptor === null ? `${methodId} is not in this daemon's catalog; nothing was sent.`
      : refusal ? (typeof reason === 'string' ? reason : `${methodId} is refused for the Agent's credential.`) : null,
    context: { principalKind: caller.principalKind, admin: caller.admin, scopes: caller.scopes, credentialKind: 'agent' },
    // As over the wire: the method is still the one admitted, and both the
    // grant captured at the start and the current one hold every scope asked.
    isAuthorized: (requiredScopes = []) => descriptor !== null && catalog.get(methodId) === descriptor
      && refuseGatewayInvocation(descriptor, caller, requiredScopes) === null
      && refuseGatewayInvocation(descriptor, pairingTokenCaller(catalog), requiredScopes) === null,
  };
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
    const admission = options.credentialKind === 'agent' ? agentInProcessAdmission(catalog, methodId) : undefined;
    if (admission?.refused) return { ok: false, data: null, error: admission.refused, route: 'in-process' };
    try {
      const invocation: GatewayMethodInvocation = {
        body,
        signal: lifetime.signal,
        isAuthorized: (requiredScopes) => { assertCurrent(); return admission ? admission.isAuthorized(requiredScopes) : true; },
        context: { clientKind: 'goodvibes-agent', ...(admission ? admission.context : { principalKind }) },
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
