/**
 * Who may use native work (intake, submission, execution, hosted turns and the
 * legacy import). One rule, one refusal, for every route that needs it.
 */
import type { NativeExecutionAuthority } from '../../security/http-auth.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';

/** The one refusal code for a caller that is not a current paired owner. */
export const PAIRED_OWNER_REQUIRED = 'PAIRED_OWNER_REQUIRED';

const PAIR_STEP = 'Pair this device with the daemon (web app: Settings, Devices and pairing; terminal: /devices migrate-shared), then retry.';

function holds(scopes: readonly string[] | undefined, needed: readonly string[]): boolean {
  return scopes !== undefined && (scopes.includes('*') || needed.every(scope => scopes.includes(scope)));
}

/**
 * The caller's native authority, or a refusal. The caller must be an admin
 * with `scopes` on the request, and the transport's authority must be the
 * same paired device, still current, still holding `scopes`. A shared token,
 * a login session or a revoked device gets `PAIRED_OWNER_REQUIRED` with the
 * step that makes it eligible.
 */
export function requireNativeOwner(invocation: GatewayMethodInvocation, scopes: readonly string[], feature: string): NativeExecutionAuthority {
  const context = invocation.context;
  if (!context.admin || !context.principalId || !holds(context.scopes, scopes) || invocation.isAuthorized?.(scopes) !== true) {
    throw new GatewayVerbError(`${feature} needs owner access with ${scopes.join(', ')}; this caller does not hold it. Sign in as the owner or use a credential with those scopes.`, 'FORBIDDEN', 403);
  }
  const authority = invocation.nativeExecutionAuthority;
  const current = authority?.current();
  if (!authority || !current || current.kind !== 'pairing-token' || current.principalId !== context.principalId
    || current.authorityId !== current.principalId || current.authorityRevision !== current.tokenId || !holds(current.scopes, scopes)) {
    throw new GatewayVerbError(`${feature} runs only for a paired device that is still current; this caller is not one. ${PAIR_STEP}`, PAIRED_OWNER_REQUIRED, 403);
  }
  return authority;
}

/** True while the invocation's caller still passes `requireNativeOwner`. */
export function isNativeOwner(invocation: GatewayMethodInvocation, scopes: readonly string[]): boolean {
  try { requireNativeOwner(invocation, scopes, 'Native work'); return true; } catch { return false; }
}
