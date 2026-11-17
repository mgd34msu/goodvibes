/**
 * owner-profile-gateway.ts, how this surface reaches the nine `profile.*`
 * control-plane verbs.
 *
 * The owner profile is one Markdown file at daemon scope and the daemon is its
 * single writer (docs/owner-profile.md §3). A surface never opens the file; it
 * calls the verbs. This module is the one place that decides which way the call
 * travels, so no tool or CLI command has to know:
 *
 * - When this process carries the handlers itself, the Agent composes a real
 *   gateway method catalog (runtime/services.ts), the call runs in-process.
 * - Otherwise the call goes to the connected host over the operator gateway,
 *   the same path `ci`, `principals` and `channel-profiles` already use.
 *
 * The catalog is asked with `hasHandler`, not `get`: a descriptor with no
 * handler answers "not invokable", and silently degrading to that would look
 * like a profile with nothing in it. When neither route is available the caller
 * gets an honest unavailable result naming which route was missing.
 */

import { captureOccasionsGatewayTarget } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { ProfileMutationOptions } from '@goodvibes-jev/engine/platform/platform/owner-profile';
import { dirname } from 'node:path';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { PROFILE_METHOD_IDS, type ProfileMethodId } from './profile-types.js';
import {
  captureFamilyGatewayRoute,
  invokeFamilyGatewayMethod,
  operatorRouteLabel,
  type FamilyGatewayOptions,
} from './family-gateway.js';

export interface ProfileGatewayResult {
  readonly ok: boolean;
  /** Raw daemon payload; the caller narrows it (tools/agent-profile-types.ts). */
  readonly data: unknown;
  /** Present only when `ok` is false. Safe to show him, it never carries a profile value. */
  readonly error?: string | undefined;
  /** Which route the call actually took, for honest "where did this answer come from". */
  readonly route: 'in-process' | 'connected-host' | 'unavailable';
}

/**
 * Generic over the verb, so each call's body is checked against THAT verb's
 * declared input rather than against `Record<string, unknown>`.
 *
 * This is the guard that was missing when `profile.forget` dropped `lineIndex`:
 * the old signature accepted any record, so a body built for the previous
 * contract compiled clean and failed only against a live daemon. Now a stale
 * field or a missing required one is a compile error at the call site.
 */
export type ProfileGatewayInvoke = <TMethodId extends ProfileMethodId>(
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
  options?: ProfileMutationOptions,
) => Promise<ProfileGatewayResult>;

export type ProfileGatewayOptions = FamilyGatewayOptions;

/**
 * The nine ids are in the generated operator contract, so `ProfileMethodId`
 * satisfies `OperatorMethodId` by assignment and the call below needs no widening
 * at all, if a verb is ever renamed or dropped, that call stops compiling.
 * `invokeOperatorGatewayMethod` resolves the real HTTP binding from the contract
 * the CONNECTED HOST serves, so an older host that does not know the verb answers
 * 404 and is classified as a route-unavailable failure rather than crashing.
 */
const _profileIdsAreOperatorIds: readonly OperatorMethodId[] = Object.values(PROFILE_METHOD_IDS);
void _profileIdsAreOperatorIds;

/** The contract's route for a profile verb, for messages and help. */
export function profileRouteLabel(methodId: ProfileMethodId): string {
  return operatorRouteLabel(methodId);
}

export function createProfileGatewayInvoke(options: ProfileGatewayOptions): ProfileGatewayInvoke {
  const invoke: ProfileGatewayInvoke = (methodId, body, lifetime = {}) =>
    invokeFamilyGatewayMethod(options, methodId, body, lifetime, lifetime.delegation ? 'service' : 'user');
  gatewayOwners.set(invoke, options);
  return invoke;
}

const gatewayOwners = new WeakMap<ProfileGatewayInvoke, ProfileGatewayOptions>();

/** That a prepared profile call will still take the route (in-process or connected host) it was prepared for. */
export function captureProfileGatewayCurrent(invoke: ProfileGatewayInvoke, methodId?: ProfileMethodId): () => void {
  return captureFamilyGatewayRoute(gatewayOwners.get(invoke), methodId, 'owner profile');
}

export function captureProfileGatewayLocalState(invoke: ProfileGatewayInvoke, method: ProfileMethodId, writing: boolean) {
  const catalog = gatewayOwners.get(invoke)?.gatewayMethods;
  // The native registrar publishes mutation targets; reads retain the same profile owner.
  const target = catalog && (captureOccasionsGatewayTarget(catalog, method)
    ?? captureOccasionsGatewayTarget(catalog, PROFILE_METHOD_IDS.set));
  if (!target) return undefined;
  const path = target.profilePath, read = target.captureProfileRead();
  let publishing = false;
  return {
    targets: [{ root: dirname(path), path, access: writing ? 'write' as const : 'read' as const }],
    assertCurrent() { target.assertOwnerCurrent(); if (!publishing) read.assertCurrent(); },
    mutationPath() { return path; },
    onWriteIntent() { publishing = true; },
  };
}
