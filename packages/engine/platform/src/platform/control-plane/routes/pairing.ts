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
import type { PairingMaker, PairingTokenManager } from '../../pairing/pairing-token-store.js';
import { PairingLimitReachedError, PairingMinterRevokedError, SharedTokenNotReplaceableError, isPairingAttemptId } from '../../pairing/pairing-token-store.js';
import { pairingTokenIdOfCaller } from '../../pairing/principal-ids.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import { admitEffects } from '../../security/effect-authority.js';
import type { ApprovalBroker } from '../approval-broker.js';
import { AGENT_CREDENTIAL_OWNER_ONLY_WORDS, makesOwnerOnlyAct, mintsAgentCredential } from '../../daemon/method-owner-decision.js';

/** The narrow slice of PairingTokenManager these verbs need. */
export type PairingGatewayService = Pick<
  PairingTokenManager,
  'list' | 'mint' | 'mintForMigration' | 'rename' | 'revokeWithMinted' | 'isLegacyRevoked' | 'revokeLegacyShared'
> & Partial<Pick<PairingTokenManager, 'revokeEverywhere' | 'listWithOffers'>>;

/** The tokens the owner sees and may revoke: the paired ones, and those made and not used yet. */
function ownersList(service: PairingGatewayService): ReturnType<PairingGatewayService['list']> {
  return service.listWithOffers ? service.listWithOffers() : service.list();
}

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Sign in first: pairing needs a signed-in user or a paired device', 'UNAUTHENTICATED', 401);
  }
}

/** Who makes the credential, as the dispatch recorded it for this call (in process only), for the store to keep. */
export function credentialMakerOfInvocation(invocation: GatewayMethodInvocation): { readonly madeBy?: PairingMaker } {
  const maker = invocation.context.metadata?.['credentialMaker'] as PairingMaker | undefined;
  return maker !== undefined ? { madeBy: maker } : {};
}

function createListHandler(service: PairingGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    return { tokens: ownersList(service), legacySharedRevoked: service.isLegacyRevoked() };
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
 * A scope list for a device that works in the projects it is given and holds no administrative scope. No longer the default
 * of a new credential (naming no list gives full operator authority, as released, see `mintedPairingScopes`); kept as a
 * list a caller may name.
 */
export const DEFAULT_PAIRED_SCOPES: readonly string[] = Object.freeze([
  'read:sessions', 'write:sessions', 'read:own-sessions', 'read:transcripts', 'read:control-plane', 'write:control-plane',
  'read:tasks', 'read:events', 'read:memory', 'read:knowledge', 'read:knowledge-content', 'read:checkpoints', 'write:checkpoints',
  'read:worktrees', 'write:worktrees', 'read:workspaces', 'read:fleet', 'write:fleet', 'read:automation', 'read:approvals',
  'write:approvals', 'read:skills', 'read:skill-content', 'read:health', 'read:providers', 'read:config', 'read:ci', 'write:ci',
  'read:intelligence',
  // Work in the projects it is given (effect-authority.ts `work.read`, `work.write`): asked for, started, read, stopped.
  'read:work-ledger', 'write:work-ledger',
  // The other project acts in the projects it is given (effect-authority.ts, the project-act rows): its agent tasks, its
  // schedules and their runs (and reading a project's schedules), its triggers, memory records of a project, files it
  // saves. Each held to a given project and, for a change, to what it made itself.
  'write:tasks', 'read:automation-content', 'write:automation', 'read:watchers', 'write:watchers',
  'write:memory', 'read:artifacts', 'write:artifacts',
]);

/**
 * The scope list a new pairing token stores. A caller grants only what it
 * holds: a narrowed caller (not admin) mints a token bounded by its own
 * scopes, inheriting them when it names none, and is refused a scope it does
 * not hold. An admin caller's token holds the list it names, or full operator
 * authority when it names none (as released; `["*"]` says the same).
 */
export function mintedPairingScopes(context: GatewayMethodInvocation['context'], requested: unknown): readonly string[] | undefined {
  let named: string[] | undefined;
  if (requested !== undefined) {
    const full = Array.isArray(requested) && requested.length === 1 && requested[0] === '*';
    if (full) {
      // `["*"]` is full operator authority, the same as naming no list: from a caller that holds it (every credential of
      // the user that is not narrowed); a narrowed caller grants only what it holds.
      if (context.admin === false && context.scopes !== undefined && !context.scopes.includes('*')) {
        throw new GatewayVerbError('A paired device cannot be given scopes this credential does not hold: *. Name only scopes you hold.', 'MISSING_SCOPE', 403, 'scopes');
      }
      return undefined;
    }
    if (!Array.isArray(requested) || requested.length === 0 || requested.some((scope) => typeof scope !== 'string' || !scope.trim() || scope.trim() === '*')) {
      throw new GatewayVerbError('scopes must be a nonempty list of operator scopes (such as read:sessions), or ["*"] for full operator authority (the owner\'s own choice); leave it out for a device that works in the projects it is given.', 'INVALID_ARGUMENT', 400, 'scopes');
    }
    named = [...new Set((requested as string[]).map((scope) => scope.trim()))];
  }
  // An admin caller that names no list mints full operator authority, as released (`undefined`: no stored list).
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
    // The Agent's credential is the owner's model: made only for the owner in person or an Agent turn the daemon hosts
    // (daemon/method-owner-decision.ts `mintsAgentCredential`; the dispatch refuses anyone else before this, and so does
    // this handler for a call that reaches it another way).
    const context = invocation.context;
    if (params.client === 'agent' && !mintsAgentCredential({ actor: context.actor, credentialKind: context.credentialKind ?? undefined,
      registration: context.call?.registration, daemonHosted: context.call?.daemonHosted === true })) {
      throw new GatewayVerbError(AGENT_CREDENTIAL_OWNER_ONLY_WORDS, 'OWNER_ONLY', 403, 'client');
    }
    // The Agent's credential is the owner's model (made only for the owner): it keeps what their program holds. Any other
    // credential holds what the owner names, or the narrow default (`DEFAULT_PAIRED_SCOPES`).
    const scopes = params.client === 'agent' && params.scopes === undefined ? undefined : mintedPairingScopes(invocation.context, params.scopes);
    try {
      return { token: service.mint({ name, mintedBy: pairingTokenIdOfCaller(invocation.context), ...credentialMakerOfInvocation(invocation),
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
      // The owner in person or the owner's own command line (method-owner-decision.ts `makesOwnerOnlyAct`, the one test)
      // moving their own program or session onto its own token keeps what that program holds (full); anyone else (only the
      // daemon itself reaches here: a migration is the owner's own act) gets the narrow default.
      const context = invocation.context;
      const inPerson = makesOwnerOnlyAct({ actor: context.actor, credentialKind: context.credentialKind ?? undefined, registration: context.call?.registration });
      const scopes = inPerson ? undefined : mintedPairingScopes(invocation.context, undefined);
      const maker = credentialMakerOfInvocation(invocation);
      // The owner in person moving their own program or session onto its own token (maker `{owner: true}`: their verified
      // program or their signed-in session, method-owner-decision.ts `ownerHimself`) pairs their own device, with full
      // authority only. A migration the owner said yes to for someone else (maker `{caller, ownersYes}`) gives that caller
      // exactly what the card said, its own administrator key, and never the owner's device: a yes to another's request never
      // raises what a credential is (gate-review-6 G1).
      const ownersPairing = scopes === undefined && maker.madeBy !== undefined && 'owner' in maker.madeBy && inPerson;
      return { token: service.mintForMigration({
        name,
        mintedBy: pairingTokenIdOfCaller(invocation.context),
        ...maker,
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(ownersPairing ? { origin: 'owner-pairing' as const } : {}),
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

/** The approval broker a withdrawal of access is put to the owner through. */
export type PairingOwnerApprovals = Pick<ApprovalBroker, 'raiseApproval' | 'onApproved'>;

function createRevokeHandler(service: PairingGatewayService, onRevoked?: PairingRevokedListener, ownerApprovals?: PairingOwnerApprovals): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const id = requireStringValue(params.id, 'id');
    const revoke = async (): Promise<{ id: string; revoked: true; alsoRevoked: string[] }> => {
      // On every machine of the group: the revocation is an authority record entry.
      const outcome = service.revokeEverywhere ? await service.revokeEverywhere(id) : service.revokeWithMinted(id);
      if (!outcome.revoked) {
        throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
      }
      for (const revokedId of [id, ...outcome.alsoRevoked]) onRevoked?.({ id: revokedId, principalId: invocation.context.principalId });
      return { id, revoked: true, alsoRevoked: [...outcome.alsoRevoked] };
    };
    const token = ownersList(service).find((entry) => entry.id === id);
    if (!token) throw new GatewayVerbError('Unknown pairing token', 'PAIRING_TOKEN_NOT_FOUND', 404);
    // A token the caller holds or minted is the caller's to revoke (control-plane.write, checked by the catalog).
    // Told by the kind of credential: a sign-in user named like a device's principal is never that device.
    const callerTokenId = pairingTokenIdOfCaller(invocation.context);
    if (callerTokenId !== undefined && (token.id === callerTokenId || token.mintedBy === callerTokenId)) return revoke();
    // Any other token is access the user granted: withdrawing it runs at once for every credential of the user (the effect
    // table's `access.withdraw`, which a sign-in under any name, a full device and the operator token all hold); one a
    // narrow device's list does not reach is refused, as released. Nothing is put to anyone.
    void ownerApprovals;
    if (admitEffects(invocation.context.actor ?? systemActor('in-process'), ['access.withdraw']).kind === 'allowed') return revoke();
    throw new GatewayVerbError(`Revoking ${token.name} (${id}) withdraws access this credential neither holds nor minted. Nothing was revoked.`, 'OWNER_ONLY', 403, 'id');
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

const PAIRING_HANDLER_FACTORIES: Readonly<Record<string, (service: PairingGatewayService, onRevoked?: PairingRevokedListener, ownerApprovals?: PairingOwnerApprovals) => GatewayMethodHandler>> = {
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
export function registerPairingGatewayMethods(catalog: GatewayMethodCatalog, service: PairingGatewayService, onRevoked?: PairingRevokedListener, ownerApprovals?: PairingOwnerApprovals): void {
  for (const [methodId, factory] of Object.entries(PAIRING_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(service, onRevoked, ownerApprovals), { replace: true });
    }
  }
}
