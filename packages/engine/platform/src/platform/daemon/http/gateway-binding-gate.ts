import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';
import type { AuthenticatedPrincipal } from '../http-policy.js';

interface GatewayBindingGateDeps {
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'findByHttpBinding'>;
  /** The request's principal, authenticated once at the router's auth gate. */
  readonly authenticateRequest: (req: Request) => { readonly principal: AuthenticatedPrincipal } | null;
  readonly validateGatewayInvocation: (
    descriptor: GatewayMethodDescriptor,
    context?: { readonly principalKind?: AuthenticatedPrincipal['principalKind']; readonly scopes?: readonly string[]; readonly admin?: boolean },
  ) => { status: number; ok: false; body: Record<string, unknown> } | null;
}

/**
 * Holds an authenticated REST call to the access and scopes its catalog entry
 * declares, the same check the WebSocket and method-dispatch paths apply, so a
 * read-only user cannot reach a write verb by its URL. Returns the refusal, or
 * null when the call has no catalog entry or is allowed.
 *
 * Skipped on purpose: remote-peer methods (the peer routes authenticate their
 * own token kind) and entries not invokable through method dispatch (those are
 * still served over their REST binding). Request bodies are left unread; the
 * route that owns the body validates it.
 */
export function gateGatewayBinding(req: Request, deps: GatewayBindingGateDeps): Response | null {
  const descriptor = deps.gatewayMethods.findByHttpBinding(req.method, new URL(req.url).pathname);
  if (!descriptor || descriptor.access === 'remote-peer' || descriptor.invokable === false) return null;
  const principal = deps.authenticateRequest(req)?.principal ?? null;
  // The auth gate already accepted the credential; a kind this resolver cannot describe is left to the route's own check.
  if (!principal) return null;
  const denied = deps.validateGatewayInvocation(descriptor, {
    principalKind: principal.principalKind,
    scopes: principal.scopes,
    admin: principal.admin,
  });
  return denied ? Response.json(denied.body, { status: denied.status }) : null;
}
