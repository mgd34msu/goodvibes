/**
 * routes/pairing.ts
 *
 * Handlers for the `pairing.tokens.*` verbs over the PairingTokenManager. Thin
 * verb registration in the same `catalog.register(descriptor, handler)` pattern
 * push.* / fleet.* use, reached through the generic
 * `/api/control-plane/methods/{id}/invoke` endpoint.
 *
 * These verbs manage the daemon's own paired-device tokens, so they require an
 * authenticated operator principal (the invoke layer already gates on the
 * write:/read:control-plane scopes the descriptors declare); the secret is
 * returned only by mint/migrate, and only once. A token minted by a paired
 * device records that device, and revoking the device revokes it too.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { PairingTokenManager } from '../../pairing/pairing-token-store.js';
import { PairingLimitReachedError, PairingMinterRevokedError, SharedTokenNotReplaceableError, isPairingAttemptId, pairingTokenIdOfPrincipal } from '../../pairing/pairing-token-store.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';

/** The narrow slice of PairingTokenManager these verbs need. */
export type PairingGatewayService = Pick<
  PairingTokenManager,
  'list' | 'mint' | 'mintForMigration' | 'rename' | 'revokeWithMinted' | 'isLegacyRevoked' | 'revokeLegacyShared'
> & Partial<Pick<PairingTokenManager, 'revokeEverywhere'>>;

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Pairing verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
}

function createListHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    return { tokens: service.list(), legacySharedRevoked: service.isLegacyRevoked() };
  };
}

/**
 * Turn a paired-node cap refusal into a wire error that names the setting and
 * the count. 409, because the request is well-formed and the state is what
 * refuses it, and it becomes satisfiable by unpairing a device or raising
 * `device.nodes.maxPaired`, with no change to the request.
 */
function rethrowAsVerbError(error: unknown): never {
  if (error instanceof PairingLimitReachedError) {
    throw new GatewayVerbError(error.message, error.code, 409);
  }
  if (error instanceof PairingMinterRevokedError) {
    throw new GatewayVerbError(error.message, error.code, 403);
  }
  throw error;
}

function readAttemptId(params: Record<string, unknown>): string | undefined {
  const raw = params.attemptId;
  if (raw === undefined) return undefined;
  if (!isPairingAttemptId(raw)) {
    throw new GatewayVerbError('attemptId must be 8 to 128 letters, digits or . _ : -', 'INVALID_ARGUMENT', 400, 'attemptId');
  }
  return raw;
}

/**
 * The scope list a new pairing token stores. A caller grants only what it
 * holds: a narrowed caller (not admin) mints a token bounded by its own
 * scopes, inheriting them when it names none, and is refused a scope it does
 * not hold. An admin caller's token holds the list it names, or full operator
 * authority when it names none.
 */
export function mintedPairingScopes(context: GatewayMethodInvocation['context'], requested: unknown): readonly string[] | undefined {
  let named: string[] | undefined;
  if (requested !== undefined) {
    if (!Array.isArray(requested) || requested.length === 0 || requested.some((scope) => typeof scope !== 'string' || !scope.trim() || scope.trim() === '*')) {
      throw new GatewayVerbError('scopes must be a nonempty list of operator scopes (such as read:sessions); leave it out for full operator authority.', 'INVALID_ARGUMENT', 400, 'scopes');
    }
    named = [...new Set((requested as string[]).map((scope) => scope.trim()))];
  }
  if (context.admin !== false || context.scopes === undefined) return named;
  const held = new Set(context.scopes);
  if (named === undefined) return [...held];
  const missing = named.filter((scope) => !held.has(scope));
  if (missing.length > 0) {
    throw new GatewayVerbError(`A paired device cannot be given scopes this credential does not hold: ${missing.join(', ')}. Name only scopes you hold, or ask an admin.`, 'MISSING_SCOPE', 403, 'scopes');
  }
  return named;
}

function createMintHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireStringValue(params.name, 'name');
    const attemptId = readAttemptId(params);
    if (params.client !== undefined && params.client !== 'agent') {
      throw new GatewayVerbError('client is "agent" or absent', 'INVALID_ARGUMENT', 400, 'client');
    }
    const scopes = mintedPairingScopes(invocation.context, params.scopes);
    try {
      return { token: service.mint({ name, mintedBy: pairingTokenIdOfPrincipal(invocation.context.principalId),
        ...(attemptId !== undefined ? { attemptId } : {}), ...(params.client === 'agent' ? { client: 'agent' as const } : {}),
        ...(scopes !== undefined ? { scopes } : {}) }) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createMigrateHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireStringValue(params.name, 'name');
    const attemptId = readAttemptId(params);
    try {
      // A device moving off the legacy shared token is not a NEW node, it is a
      // node that is already using this daemon. Refusing it at the cap would
      // strand a working device on a token that is about to be revoked, so the
      // migration mint is exempt from the cap. A repeated attempt id (the client
      // lost the reply) re-issues the offer that attempt made instead of adding one.
      const scopes = mintedPairingScopes(invocation.context, undefined);
      return { token: service.mintForMigration({
        name,
        mintedBy: pairingTokenIdOfPrincipal(invocation.context.principalId),
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
      }) };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createRenameHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const id = requireStringValue(params.id, 'id');
    const name = requireStringValue(params.name, 'name');
    let renamed: boolean;
    try {
      renamed = await service.rename(id, name);
    } catch (error) {
      rethrowAsVerbError(error);
    }
    if (!renamed) {
      throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
    }
    return { id, renamed: true };
  };
}

/** Told after a paired-device token was really revoked. */
export type PairingRevokedListener = (event: { readonly id: string; readonly principalId: string | undefined }) => void;

function createRevokeHandler(service: PairingGatewayService, onRevoked?: PairingRevokedListener): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const id = requireStringValue(params.id, 'id');
    // On every machine of the group: the revocation is an authority record entry.
    const outcome = service.revokeEverywhere ? await service.revokeEverywhere(id) : service.revokeWithMinted(id);
    if (!outcome.revoked) {
      throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
    }
    for (const revokedId of [id, ...outcome.alsoRevoked]) onRevoked?.({ id: revokedId, principalId: invocation.context.principalId });
    return { id, revoked: true, alsoRevoked: [...outcome.alsoRevoked] };
  };
}

/**
 * Revoke the shared token. On the daemon this replaces it in the same step:
 * every copy another device holds stops signing in, and the apps on the
 * daemon's machine read the new value from its home and stay signed in.
 */
function createRevokeSharedHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    try {
      service.revokeLegacyShared();
    } catch (error) {
      // 409: the request is fine; the daemon serves a token it cannot replace.
      if (error instanceof SharedTokenNotReplaceableError) throw new GatewayVerbError(error.message, error.code, 409);
      throw error;
    }
    return { legacySharedRevoked: true };
  };
}

const PAIRING_HANDLER_FACTORIES: Readonly<Record<string, (service: PairingGatewayService, onRevoked?: PairingRevokedListener) => GatewayMethodHandler>> = {
  'pairing.tokens.list': createListHandler,
  'pairing.tokens.create': createMintHandler,
  'pairing.tokens.migrate': createMigrateHandler,
  'pairing.tokens.rename': createRenameHandler,
  'pairing.tokens.delete': createRevokeHandler,
  'pairing.tokens.revokeShared': createRevokeSharedHandler,
};

/**
 * Attach the `pairing.tokens.*` handlers to their cataloged descriptors. A
 * missing descriptor is a silent no-op rather than a throw, construction must
 * never fail because one verb failed to register; the operator-contract gates
 * catch a real drift.
 */
export function registerPairingGatewayMethods(catalog: GatewayMethodCatalog, service: PairingGatewayService, onRevoked?: PairingRevokedListener): void {
  for (const [methodId, factory] of Object.entries(PAIRING_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(service, onRevoked), { replace: true });
    }
  }
}
