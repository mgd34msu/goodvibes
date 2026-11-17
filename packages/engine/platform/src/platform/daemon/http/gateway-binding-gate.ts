import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';
import { grantedGatewayScopes } from '../../control-plane/method-catalog.js';
import { missingScopeRefusal } from '@goodvibes-jev/engine/daemon-api/error-response';
import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
import type { AuthenticatedPrincipal, CredentialKind } from '../http-policy.js';

/** Who is calling, as the access and scope check reads it. */
export interface GatewayAccessCaller {
  readonly principalKind?: AuthenticatedPrincipal['principalKind'] | 'remote-peer' | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly admin?: boolean | undefined;
  /** Which credential the transport authenticated; `agent` is the Agent's model calling on the owner's behalf. */
  readonly credentialKind?: CredentialKind | null | undefined;
}

/**
 * The one access and scope check for a cataloged method: who may call an
 * owner-only method, its declared access level, then every scope it lists.
 * Returns the refusal, or null when allowed.
 * Method dispatch adds its own "is this invokable" check in front of it; a
 * REST binding of a method that is not invokable through dispatch is still
 * held to this.
 */
export function refuseGatewayAccess(
  descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'ownerOnly'>,
  caller: GatewayAccessCaller | undefined,
): { status: number; ok: false; body: Record<string, unknown> } | null {
  // The owner's own act (answering what was put to him, granting or withdrawing access) is never
  // taken from the Agent's model, whatever it was approved by.
  if (descriptor.ownerOnly === true && caller?.credentialKind === 'agent') {
    return {
      status: 403,
      ok: false,
      body: {
        error: `${descriptor.id} is the owner's own act; a call the Agent makes for him is refused. The owner does it from his own app.`,
        code: 'OWNER_ONLY',
        category: 'authorization',
        status: 403,
      },
    };
  }
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

/**
 * The one admission check of a cataloged call, for every path a call takes:
 * method dispatch over the wire, the live `isAuthorized(scopes)` a handler
 * asks while it runs, and a call the daemon makes in-process on a caller's
 * behalf. The method must be invokable through dispatch, the caller must meet
 * its access level and hold every scope it lists, and every further scope the
 * handler asks for. Returns the refusal, or null when allowed.
 */
export function refuseGatewayInvocation(
  descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'invokable' | 'ownerOnly'>,
  caller: GatewayAccessCaller | undefined,
  requiredScopes: readonly string[] = [],
): { status: number; ok: false; body: Record<string, unknown> } | null {
  if (descriptor.invokable === false) {
    return {
      status: 400,
      ok: false,
      body: {
        error: `Gateway method is cataloged but not invokable through method dispatch: ${descriptor.id}`,
        // Machine-readable, following the EngineErrorCodes.SESSION_CLOSED precedent
        // (session-broker.ts), consumers match on `code`, never on the message
        // string. See the `invokable` field's doc comment (method-catalog-shared.ts)
        // for what this status does and does not mean.
        code: EngineErrorCodes.NOT_INVOKABLE,
      },
    };
  }
  const denied = refuseGatewayAccess(descriptor, caller);
  if (denied || requiredScopes.length === 0 || descriptor.access === 'public' || descriptor.access === 'remote-peer') return denied;
  const body = missingScopeRefusal(descriptor.id, requiredScopes, caller?.scopes);
  return body ? { status: 403, ok: false, body: { ...body } } : null;
}

/** The scopes a catalog grants by default: the set it keeps, or one derived from its descriptors. */
export function catalogGrantedScopes(
  catalog: Pick<GatewayMethodCatalog, 'getAllScopes'> & { grantedScopes?(includeWrite: boolean): readonly string[] },
  includeWrite: boolean,
): readonly string[] {
  return typeof catalog.grantedScopes === 'function' ? catalog.grantedScopes(includeWrite) : grantedGatewayScopes(catalog, includeWrite);
}

/** The default grant, narrowed to a stored list. A stored list never widens it. */
export function narrowGatewayGrant(defaults: readonly string[], stored: readonly string[] | undefined): readonly string[] {
  if (stored === undefined || stored.includes('*')) return defaults;
  const allowed = new Set(stored);
  return Object.freeze(defaults.filter(scope => allowed.has(scope)));
}

/**
 * What a pairing-token caller holds: full operator authority (admin, and the
 * catalog's whole read and write grant) unless its pairing stores a narrower
 * list. The Agent's pairing (`client: 'agent'`) is minted with no list, so it
 * holds the full grant; a call the daemon makes in-process as the Agent is
 * held to this same caller.
 */
export function pairingTokenCaller(
  catalog: Parameters<typeof catalogGrantedScopes>[0],
  stored?: readonly string[] | undefined,
): { readonly principalKind: 'token'; readonly admin: boolean; readonly scopes: readonly string[] } {
  return {
    principalKind: 'token',
    admin: stored === undefined || stored.includes('*'),
    scopes: narrowGatewayGrant(catalogGrantedScopes(catalog, true), stored),
  };
}

interface GatewayBindingGateDeps {
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'findByHttpBinding'>;
  /** The request's principal, authenticated once at the router's auth gate. */
  readonly authenticateRequest: (req: Request) => { readonly principal: AuthenticatedPrincipal & { readonly credentialKind?: CredentialKind | null | undefined } } | null;
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
