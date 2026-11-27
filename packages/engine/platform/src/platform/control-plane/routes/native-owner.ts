/**
 * Who may use native work (intake, submission, execution, hosted turns and the
 * legacy import). One rule, one refusal, for every route that needs it.
 */
import type { NativeExecutionAuthority } from '../../security/http-auth.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';
import { ownersOwnSession } from '../../daemon/method-owner-decision.js';
import type { Actor } from '../../daemon/http-policy.js';

/** The one refusal code for a caller that is not a current paired owner. */
export const PAIRED_OWNER_REQUIRED = 'PAIRED_OWNER_REQUIRED';

const PAIR_STEP = 'On the daemon\'s own machine the apps use the operator token they already hold over a direct loopback connection (not through a proxy or tunnel, and not while a public address such as controlPlane.publicBaseUrl is configured); in the web UI sign in as the owner; otherwise pair this device as yours from your own screen (in your signed-in web UI: Devices and network, Pair something, "Show the sign-in code once"; the Agent takes it with goodvibes-agent setup pair --with-code), then retry. A pairing someone else asked for and you approved is not your device and does no native work.';

function holds(scopes: readonly string[] | undefined, needed: readonly string[]): boolean {
  return scopes !== undefined && missingScopes(scopes, needed).length === 0;
}

/**
 * The caller's native authority, or a refusal. The caller must be an admin
 * with `scopes` on the request, and the transport's authority must be the
 * same owner, still current, still holding `scopes`: a paired device, or an
 * app on the daemon's own machine presenting the operator token it already
 * holds (`local`), or the owner in person signed in (their sign-in holds their own
 * machine's authority). The operator token from another machine, a sign-in
 * that is not the owner's or a revoked device gets `PAIRED_OWNER_REQUIRED`
 * with the step that makes it eligible.
 *
 * `projectAct`: work in a project (a submission, a run started, read or stopped: effect-authority.ts `work.read`,
 * `work.write`) is open below an admin too, to a paired device holding `scopes` (the outside agent among them): the
 * dispatch's project check held the call to a project given to it, and its native identity is its own pairing, so a run
 * it starts is bound to it and it reaches no other credential's run.
 */
export function requireNativeOwner(invocation: GatewayMethodInvocation, scopes: readonly string[], feature: string,
  options: { readonly projectAct?: boolean } = {}): NativeExecutionAuthority {
  const context = invocation.context;
  if ((!context.admin && options.projectAct !== true) || !context.principalId || !holds(context.scopes, scopes) || invocation.isAuthorized?.(scopes) !== true) {
    throw new GatewayVerbError(`${feature} needs owner access with ${scopes.join(', ')}; this caller does not hold it. Sign in as the owner or use a credential with those scopes.`, 'FORBIDDEN', 403);
  }
  const authority = invocation.nativeExecutionAuthority;
  const current = authority?.current();
  if (!authority || !current || !nativeIdentityIsCaller(context, current, { anyPrincipalKind: true })
    || current.authorityId !== current.principalId || current.authorityRevision !== current.tokenId || !holds(current.scopes, scopes)) {
    throw new GatewayVerbError(`${feature} runs only for the owner's own machine or a paired device that is still current; this caller is neither. ${PAIR_STEP}`, PAIRED_OWNER_REQUIRED, 403);
  }
  return authority;
}

/**
 * Whether the native identity the transport built for a call (`current`, of a paired device or the owner's own machine)
 * is the caller's own: the same token principal, or the owner in person on their sign-in, who holds their own machine's
 * identity (daemon/control-plane.ts `createNativeExecutionAuthority`; its principal is the machine's, not their sign-in's
 * name). The one test every owner-only native act reads (native work, purchase windows, checkout, reconciliation).
 * `anyPrincipalKind`: the caller's principal kind is not held to `token` (native work's own rule).
 */
export function nativeIdentityIsCaller(
  context: { readonly principalKind?: string | undefined; readonly principalId?: string | undefined; readonly actor?: Actor | undefined; readonly credentialKind?: string | undefined },
  current: { readonly kind: string; readonly principalId: string },
  options: { readonly anyPrincipalKind?: boolean } = {},
): boolean {
  if (current.kind !== 'pairing-token' && current.kind !== 'local') return false;
  if (current.kind === 'local' && ownersOwnSession({ actor: context.actor, credentialKind: context.credentialKind })) return true;
  return (options.anyPrincipalKind === true || context.principalKind === 'token') && context.principalId === current.principalId;
}

/** True while the invocation's caller still passes `requireNativeOwner` (with the same `projectAct`). */
export function isNativeOwner(invocation: GatewayMethodInvocation, scopes: readonly string[], options: { readonly projectAct?: boolean } = {}): boolean {
  try { requireNativeOwner(invocation, scopes, 'Native work', options); return true; } catch { return false; }
}
