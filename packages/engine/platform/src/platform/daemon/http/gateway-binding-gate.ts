import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';
import { grantedGatewayScopes } from '../../control-plane/method-catalog.js';
import { missingScopeRefusal } from '@goodvibes/engine/daemon-api/error-response';
import { EngineErrorCodes } from '@goodvibes/engine/errors';
import { actorHoldsScope, type Actor } from '../http-policy.js';
import { EFFECTS, admitRules, declaredAccessRules, type EffectAdmission, type EffectRule } from '../../security/effect-authority.js';
import { declaredRouteDescriptor } from './route-manifest.js';
import { pairingGrant } from '../../security/http-auth.js';

type GatewayRefusal = { status: number; ok: false; body: Record<string, unknown> };

/** The rules a method is held to: the effects it declares, or for a plugin's method the access and scopes it declares. */
export function gatewayMethodRules(descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'ownerOnly' | 'effects'> & Partial<Pick<GatewayMethodDescriptor, 'modelRefused'>>): readonly EffectRule[] {
  return descriptor.effects !== undefined ? descriptor.effects.map((id) => EFFECTS[id]) : declaredAccessRules(descriptor);
}

function heldScopes(actor: Actor): readonly string[] {
  return actor.scopes === 'all' ? ['*'] : [...actor.scopes];
}

/** The wire body of an admission refusal: the codes clients branch on, with the effect and what is missing. */
function refusalOf(descriptor: Pick<GatewayMethodDescriptor, 'id'>, admission: Exclude<EffectAdmission, { kind: 'allowed' }>, actor: Actor): GatewayRefusal {
  const named = { effect: admission.effect, ...(admission.kind === 'refused' ? { missing: admission.missing } : {}) };
  if (admission.kind === 'ask-owner') {
    return { status: 403, ok: false, body: {
      error: `${descriptor.id} is the owner's to decide (${admission.reason}).`, code: 'OWNER_ONLY', category: 'authorization', status: 403,
      ...named, next: ['Ask the owner to make this call from his own credential.'],
    } };
  }
  if (admission.code === 'OWNER_ONLY') {
    return { status: 403, ok: false, body: {
      error: actor.agentFor !== undefined
        ? `${descriptor.id} is the owner's own act; a call the Agent makes for him is refused. The owner does it from his own app.`
        : `${descriptor.id}: ${admission.reason}.`,
      code: 'OWNER_ONLY', category: 'authorization', status: 403, ...named, next: [admission.next],
    } };
  }
  if (admission.missing === 'admin') {
    return { status: 403, ok: false, body: {
      error: `Gateway method requires admin access: ${descriptor.id}`, code: 'ADMIN_REQUIRED', category: 'authorization', status: 403, ...named, next: [admission.next],
    } };
  }
  if (admission.missing === 'peer') {
    return { status: 403, ok: false, body: {
      error: `Gateway method requires a remote-peer principal: ${descriptor.id}`, code: 'REMOTE_PEER_REQUIRED', category: 'authorization', status: 403, ...named,
    } };
  }
  if (admission.code === 'NOT_YOURS') {
    return { status: 403, ok: false, body: {
      error: `${descriptor.id}: ${admission.reason}.`, code: 'NOT_YOURS', category: 'authorization', status: 403, ...named, next: [admission.next],
    } };
  }
  const scope = missingScopeRefusal(descriptor.id, [admission.missing], heldScopes(actor));
  return { status: 403, ok: false, body: scope ? { ...scope, ...named } : {
    error: `${descriptor.id}: ${admission.reason}.`, code: 'PERMISSION_DENIED', category: 'authorization', status: 403, ...named, next: [admission.next],
  } };
}

/**
 * The one access check for a cataloged method: the effects it causes,
 * admitted for the actor making the call (security/effect-authority.ts
 * `admitEffects`). Returns the refusal, or null when allowed. Method dispatch
 * adds its own "is this invokable" check in front of it; a REST binding of a
 * method that is not invokable through dispatch is still held to this. A
 * call with no actor is anonymous and reaches only a public method.
 */
export function refuseGatewayAccess(
  descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'ownerOnly' | 'effects'>,
  actor: Actor | undefined,
): GatewayRefusal | null {
  const rules = gatewayMethodRules(descriptor);
  if (actor === undefined) {
    if (rules.every((rule) => rule.public === true)) return null;
    if (rules.some((rule) => rule.least === 'peer')) {
      return { status: 403, ok: false, body: { error: `Gateway method requires a remote-peer principal: ${descriptor.id}`, code: 'REMOTE_PEER_REQUIRED', category: 'authorization', status: 403 } };
    }
    return { status: 401, ok: false, body: { error: `${descriptor.id} needs an authenticated caller.`, code: 'AUTH_REQUIRED', category: 'authentication', status: 401 } };
  }
  const admission = admitRules(actor, rules);
  return admission.kind === 'allowed' ? null : refusalOf(descriptor, admission, actor);
}

/**
 * The one admission check of a cataloged call, for every path a call takes:
 * method dispatch over the wire, the live `isAuthorized(scopes)` a handler
 * asks while it runs, and a call the daemon makes in-process on a caller's
 * behalf. The method must be invokable through dispatch, its effects admitted
 * for the actor, and the actor must hold every further scope the handler asks
 * for. Returns the refusal, or null when allowed.
 */
export function refuseGatewayInvocation(
  descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'invokable' | 'ownerOnly' | 'effects'>,
  actor: Actor | undefined,
  requiredScopes: readonly string[] = [],
): GatewayRefusal | null {
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
  const denied = refuseGatewayAccess(descriptor, actor);
  if (denied || requiredScopes.length === 0 || actor === undefined || descriptor.access === 'public' || descriptor.access === 'remote-peer') return denied;
  const missing = requiredScopes.filter((scope) => !actorHoldsScope(actor, scope));
  if (missing.length === 0) return null;
  const body = missingScopeRefusal(descriptor.id, requiredScopes, heldScopes(actor));
  return body ? { status: 403, ok: false, body: { ...body } } : null;
}

/** The scopes a catalog grants by default: the set it keeps, or one derived from its descriptors. */
export function catalogGrantedScopes(
  catalog: Pick<GatewayMethodCatalog, 'getAllScopes'> & { grantedScopes?(includeWrite: boolean): readonly string[] },
  includeWrite: boolean,
): readonly string[] {
  return typeof catalog.grantedScopes === 'function' ? catalog.grantedScopes(includeWrite) : grantedGatewayScopes(catalog, includeWrite);
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
  return pairingGrant(catalogGrantedScopes(catalog, true), stored);
}

interface GatewayBindingGateDeps {
  readonly gatewayMethods: Pick<GatewayMethodCatalog, 'findByHttpBinding'>;
  /** The request's principal, authenticated once at the router's auth gate. */
  readonly authenticateRequest: (req: Request) => { readonly principal: { readonly actor: Actor } } | null;
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
  const pathname = new URL(req.url).pathname;
  const descriptor = deps.gatewayMethods.findByHttpBinding(req.method, pathname)
    ?? declaredRouteDescriptor(deps.gatewayMethods, req.method, pathname);
  if (!descriptor || descriptor.access === 'remote-peer') return null;
  const principal = deps.authenticateRequest(req)?.principal ?? null;
  // The auth gate already accepted the credential; a kind this resolver cannot describe is left to the route's own check.
  if (!principal) return null;
  const denied = refuseGatewayAccess(descriptor, principal.actor);
  return denied ? Response.json(denied.body, { status: denied.status }) : null;
}
