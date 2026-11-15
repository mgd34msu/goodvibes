import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';
import { missingScopeRefusal } from '@goodvibes-jev/engine/daemon-api/error-response';
import type { AuthenticatedPrincipal } from '../http-policy.js';

/** Who is calling, as the access and scope check reads it. */
export interface GatewayAccessCaller {
  readonly principalKind?: AuthenticatedPrincipal['principalKind'] | 'remote-peer' | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly admin?: boolean | undefined;
}

/**
 * The one access and scope check for a cataloged method: its declared access
 * level, then every scope it lists. Returns the refusal, or null when allowed.
 * Method dispatch adds its own "is this invokable" check in front of it; a
 * REST binding of a method that is not invokable through dispatch is still
 * held to this.
 */
export function refuseGatewayAccess(
  descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes'>,
  caller: GatewayAccessCaller | undefined,
): { status: number; ok: false; body: Record<string, unknown> } | null {
  if (descriptor.access === 'public') return null;
  if (descriptor.access === 'admin' && !caller?.admin) {
    return {
      status: 403,
      ok: false,
      body: {
        error: `Gateway method requires admin access: ${descriptor.id}`,
        code: 'ADMIN_REQUIRED',
        category: 'authorization',
        status: 403,
      },
    };
  }
  if (descriptor.access === 'remote-peer' && caller?.principalKind !== 'remote-peer') {
    return {
      status: 403,
      ok: false,
      body: { error: `Gateway method requires a remote-peer principal: ${descriptor.id}`, code: 'REMOTE_PEER_REQUIRED', category: 'authorization', status: 403 },
    };
  }
  const body = missingScopeRefusal(descriptor.id, descriptor.scopes, caller?.scopes);
  return body ? { status: 403, ok: false, body: { ...body } } : null;
}

interface GatewayBindingGateDeps {
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'findByHttpBinding'>;
  /** The request's principal, authenticated once at the router's auth gate. */
  readonly authenticateRequest: (req: Request) => { readonly principal: AuthenticatedPrincipal } | null;
}

/**
 * Holds an authenticated REST call to the access and scopes its catalog entry
 * declares, the same check the WebSocket and method-dispatch paths apply, so a
 * read-only user cannot reach a write or admin route by its URL. Returns the
 * refusal, or null when the call has no catalog entry or is allowed.
 *
 * Skipped on purpose: remote-peer methods (the peer routes authenticate their
 * own token kind). An entry not invokable through method dispatch is still
 * served over its REST binding, so it is held to its access and scopes too.
 * Request bodies are left unread; the route that owns the body validates it.
 */
export function gateGatewayBinding(req: Request, deps: GatewayBindingGateDeps): Response | null {
  const descriptor = deps.gatewayMethods.findByHttpBinding(req.method, new URL(req.url).pathname);
  if (!descriptor || descriptor.access === 'remote-peer') return null;
  const principal = deps.authenticateRequest(req)?.principal ?? null;
  // The auth gate already accepted the credential; a kind this resolver cannot describe is left to the route's own check.
  if (!principal) return null;
  const denied = refuseGatewayAccess(descriptor, principal);
  return denied ? Response.json(denied.body, { status: denied.status }) : null;
}
