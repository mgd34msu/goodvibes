/**
 * occasions-gateway.ts, how this surface reaches the sixteen `occasions.*`
 * control-plane verbs.
 *
 * Occasions are lines in the owner's profile and the acknowledgement state is a
 * separate machine-owned store; the daemon owns both (docs/occasions.md §3). A
 * surface never opens either one, it calls the verbs. This module is the one
 * place that decides which way the call travels, so no tool, nudge surface or
 * CLI command has to know:
 *
 * - When this process carries the handlers itself, the Agent composes a real
 *   gateway method catalog (runtime/services.ts, which threads configManager and
 *   shellPaths into the platform's registrar), the call runs in-process.
 * - Otherwise the call goes to the connected host over the operator gateway,
 *   the same path `profile`, `ci`, `principals` and `channel-profiles` use.
 *
 * The route decision, the checks and the connected-host call are shared with
 * owner-profile-gateway.ts (`invokeFamilyGatewayMethod` in
 * operator-gateway-call.ts); this module names the verbs.
 *
 * The catalog is asked with `hasHandler`, not `get`: a descriptor with no
 * handler answers "not invokable", and silently degrading to that would look
 * like an owner with no dates recorded. When neither route is available the
 * caller gets an honest unavailable result naming which route was missing.
 *
 * ## Nothing here decides anything
 *
 * No lead window is computed here, no proximity word is chosen here, no kind is
 * defaulted here, and no date is formatted here. docs/occasions.md §7 is
 * explicit that a consumer computing anything beyond calling these verbs and
 * rendering the answers is a second implementation of a rule that lives in the
 * daemon, most dangerously the rule that a nudge never carries the date.
 */

import { captureOccasionsGatewayTarget } from '@goodvibes/engine/platform/platform/control-plane';
import { dirname } from 'node:path';
import type { OccasionMutationOptions } from '@goodvibes/engine/platform/platform/occasions';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes/engine/platform/contracts';
import { OCCASIONS_METHOD_IDS, type OccasionsMethodId } from './occasions-types.js';
import {
  captureFamilyGatewayRoute,
  invokeFamilyGatewayMethod,
  operatorRouteLabel,
  type FamilyGatewayOptions,
} from './family-gateway.js';

export interface OccasionsGatewayResult {
  readonly ok: boolean;
  /** Raw daemon payload; the caller narrows it (the engine's terminal-shell agent-turn/occasions-types.ts). */
  readonly data: unknown;
  /** Present only when `ok` is false. Safe to show the owner, it never carries a date. */
  readonly error?: string | undefined;
  /** Which route the call actually took, for honest "where did this answer come from". */
  readonly route: 'in-process' | 'connected-host' | 'unavailable';
}

/**
 * Generic over the verb, so each call's body is checked against THAT verb's
 * declared input rather than against `Record<string, unknown>`.
 *
 * Same guard `ProfileGatewayInvoke` carries, and for the same reason: the
 * profile write verbs here (`occasions.confirm`, `occasions.plans.confirm`,
 * `occasions.remove`, and `occasions.conflict.resolve` with `keep`) take an `authority`, and an operator client with a
 * loose overload beneath its typed one would accept a body that omitted it. See
 * src/test/agent/operator-payload-conformance.test.ts for the measured table.
 */
export type OccasionsGatewayInvoke = <TMethodId extends OccasionsMethodId>(
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
  options?: OccasionMutationOptions,
) => Promise<OccasionsGatewayResult>;

export type OccasionsGatewayOptions = FamilyGatewayOptions;

/**
 * The sixteen ids are in the generated operator contract, so `OccasionsMethodId`
 * satisfies `OperatorMethodId` by assignment and the call below needs no widening
 * at all, if a verb is ever renamed or dropped, that call stops compiling.
 */
const _occasionsIdsAreOperatorIds: readonly OperatorMethodId[] = Object.values(OCCASIONS_METHOD_IDS);
void _occasionsIdsAreOperatorIds;

/** The contract's route for an occasions verb, for messages and help. */
export function occasionsRouteLabel(methodId: OccasionsMethodId): string {
  return operatorRouteLabel(methodId);
}

export function createOccasionsGatewayInvoke(
  options: OccasionsGatewayOptions,
): OccasionsGatewayInvoke {
  const invoke: OccasionsGatewayInvoke = (methodId, body, lifetime = {}) =>
    invokeFamilyGatewayMethod(options, methodId, body, lifetime, 'service');
  gatewayOwners.set(invoke, options);
  return invoke;
}

const gatewayOwners = new WeakMap<OccasionsGatewayInvoke, OccasionsGatewayOptions>();

/** That a prepared occasions call will still take the route (in-process or connected host) it was prepared for. */
export function captureOccasionsGatewayCurrent(invoke: OccasionsGatewayInvoke, methodId?: OccasionsMethodId): () => void {
  return captureFamilyGatewayRoute(gatewayOwners.get(invoke), methodId, 'occasions');
}

/**
 * The registrar owns native file selection; caller arguments never supply these paths.
 * `profileWrite` says the call writes the owner's profile file; by default the
 * verbs that always do, and the caller passes it for one that does only with
 * some arguments (`occasions.conflict.resolve` with a date to keep).
 */
export function captureOccasionsGatewayLocalState(invoke: OccasionsGatewayInvoke, method: OccasionsMethodId, writing: boolean,
  profileWrite = [OCCASIONS_METHOD_IDS.confirm, OCCASIONS_METHOD_IDS.plansConfirm, OCCASIONS_METHOD_IDS.remove].some(id => id === method)) {
  const owner = gatewayOwners.get(invoke), catalog = owner?.gatewayMethods;
  const target = catalog && captureOccasionsGatewayTarget(catalog, method);
  if (!target) return undefined;
  const profileRead = target.captureProfileRead(), stateRead = target.captureStateRead?.();
  let profileWriting = false, stateWriting = false;
  return {
    targets: [{ root: dirname(target.profilePath), path: target.profilePath, access: profileWrite ? 'write' as const : 'read' as const },
      ...(target.statePath ? [{ root: dirname(target.statePath), path: target.statePath, access: writing ? 'write' as const : 'read' as const }] : [])],
    assertCurrent() { target.assertOwnerCurrent(); if (!profileWriting) profileRead.assertCurrent(); if (!stateWriting) stateRead?.assertCurrent(); },
    mutationPath(stage: 'profile' | 'state') { return stage === 'profile' ? target.profilePath : target.statePath; },
    onWriteIntent(stage: 'profile' | 'state') { if (stage === 'profile') profileWriting = true; else stateWriting = true; },
  };
}
