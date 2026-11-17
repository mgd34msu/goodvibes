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
import { PairingLimitReachedError, PairingMinterRevokedError, isPairingAttemptId, pairingTokenIdOfPrincipal } from '../../pairing/pairing-token-store.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';

/** The narrow slice of PairingTokenManager these verbs need. */
export type PairingGatewayService = Pick<
  PairingTokenManager,
  'list' | 'mint' | 'mintForMigration' | 'rename' | 'revokeWithMinted' | 'isLegacyRevoked' | 'revokeLegacyShared'
>;

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

function createMintHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireStringValue(params.name, 'name');
    const attemptId = readAttemptId(params);
    if (params.client !== undefined && params.client !== 'agent') {
      throw new GatewayVerbError('client is "agent" or absent', 'INVALID_ARGUMENT', 400, 'client');
    }
    try {
      return { token: service.mint({ name, mintedBy: pairingTokenIdOfPrincipal(invocation.context.principalId),
        ...(attemptId !== undefined ? { attemptId } : {}), ...(params.client === 'agent' ? { client: 'agent' as const } : {}) }) };
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
      return { token: service.mintForMigration({
        name,
        mintedBy: pairingTokenIdOfPrincipal(invocation.context.principalId),
        ...(attemptId !== undefined ? { attemptId } : {}),
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
    if (!service.rename(id, name)) {
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
    const outcome = service.revokeWithMinted(id);
    if (!outcome.revoked) {
      throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
    }
    for (const revokedId of [id, ...outcome.alsoRevoked]) onRevoked?.({ id: revokedId, principalId: invocation.context.principalId });
    return { id, revoked: true, alsoRevoked: [...outcome.alsoRevoked] };
  };
}

function createRevokeSharedHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    service.revokeLegacyShared();
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
