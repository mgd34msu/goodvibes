/**
 * routes/pairing-handoff.ts
 *
 * The `pairing.handoff.*` verbs: one pairing exchange carries an OFFER SET
 * (notifications, relay, passkey step-up) so a freshly-paired surface can
 * complete several set-up steps in a single pass, each independently declinable.
 *
 * - pairing.handoff.create mints a per-device token and returns the offer set
 *   that is actually available on this daemon (notifications carry the VAPID
 *   public key; relay/passkey are advertised only when the daemon supports
 *   them), plus the `#pair=<token>` deep-link fragment (and a full deep link
 *   when a web origin is configured). The token secret is returned ONCE.
 * - pairing.handoff.complete applies the surface's per-offer decisions in one
 *   pass: an accepted notifications offer registers the browser push
 *   subscription, an accepted passkey offer registers the WebAuthn credential,
 *   an accepted relay offer is acknowledged; each returns an honest per-offer
 *   result, and a declined/omitted offer is reported as declined, never
 *   silently half-applied.
 */
import { isAutomationCredential } from '@goodvibes-jev/engine/daemon-api/http-policy';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { MintedPairingToken, PairingTokenManager } from '../../pairing/pairing-token-store.js';
import { PairingLimitReachedError, PairingMinterRevokedError, pairingTokenIdOfPrincipal } from '../../pairing/pairing-token-store.js';
import type { StepUpGatewayService } from './stepup.js';
import type { PushGatewayService } from './push.js';
import {
  buildPairingHandoffFragment,
  buildPairingHandoffLink,
  normalizeOffers,
  PAIRING_HANDOFF_OFFER_KINDS,
  type PairingHandoffOfferKind,
} from '../../pairing/pairing-handoff.js';
import { describeOriginPosture } from '../../pairing/origin-posture.js';
import {
  describeAuthSecretProblem,
  describeEndpointProblem,
  describeP256dhProblem,
} from '../../push/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { mintedPairingScopes } from './pairing.js';

/** What the hand-off verbs need from the surrounding composition. */
export interface PairingHandoffDeps {
  readonly tokens: Pick<PairingTokenManager, 'mint' | 'mintForMigration'>;
  /** The push service, VAPID key for the notifications offer + subscription registration. */
  readonly push: Pick<PushGatewayService, 'getPublicKey' | 'subscribe'>;
  /** WebAuthn step-up; present ⇒ the passkey offer is available. */
  readonly stepUp?: Pick<StepUpGatewayService, 'registerCredential'> | undefined;
  /** Whether the rendezvous relay is available ⇒ the relay offer is available. */
  readonly relayAvailable: () => boolean;
  /** The configured web-app origin the QR points at; absent ⇒ only a fragment is returned. */
  readonly webOrigin?: (() => string | undefined) | undefined;
}

function requirePrincipal(invocation: GatewayMethodInvocation): string {
  const principalId = invocation.context.principalId;
  if (!principalId) {
    throw new GatewayVerbError('Pairing hand-off verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
  return principalId;
}

function requestedOffers(value: unknown): readonly PairingHandoffOfferKind[] {
  if (value === undefined) return PAIRING_HANDOFF_OFFER_KINDS;
  if (!Array.isArray(value)) {
    throw new GatewayVerbError('offers must be an array of offer kinds', 'INVALID_ARGUMENT', 400, 'offers');
  }
  return normalizeOffers(value.filter((v): v is string => typeof v === 'string'));
}

/** The offers this daemon can actually satisfy right now. */
function availableOffers(deps: PairingHandoffDeps): Set<PairingHandoffOfferKind> {
  const available = new Set<PairingHandoffOfferKind>(['notifications']);
  if (deps.relayAvailable()) available.add('relay');
  if (deps.stepUp) available.add('passkey');
  return available;
}

function createHandoffCreateHandler(deps: PairingHandoffDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const name = requireStringValue(params.name, 'name');
    // `fromSharedToken`: the calling client (a browser or app signed in with the shared
    // operator token) is pairing itself onto its own token. Only a caller on the shared
    // token may say so.
    const fromSharedToken = params.fromSharedToken === true;
    if (params.fromSharedToken !== undefined && typeof params.fromSharedToken !== 'boolean') {
      throw new GatewayVerbError('fromSharedToken must be true or false', 'INVALID_ARGUMENT', 400, 'fromSharedToken');
    }
    if (fromSharedToken && invocation.context.credentialKind !== 'shared-token' && invocation.context.credentialKind !== 'local') {
      throw new GatewayVerbError('fromSharedToken is for a client signed in with the shared operator token; this credential is not.', 'INVALID_ARGUMENT', 400, 'fromSharedToken');
    }
    const available = availableOffers(deps);
    const offers = requestedOffers(params.offers).filter((kind) => available.has(kind));

    // Resolved before minting: a token whose secret is never returned would still count toward the paired-node cap.
    const offerDetails = await Promise.all(offers.map(async (kind) => {
      if (kind === 'notifications') {
        return { kind, available: true, vapidPublicKey: await deps.push.getPublicKey() };
      }
      return { kind, available: true };
    }));

    // The QR path is where a phone actually pairs, so this is where
    // `device.nodes.maxPaired` has to hold. The refusal names the setting and
    // the live count (see PairingLimitReachedError), 409, because the request
    // is fine and the state is what refuses it. The token is an offer until
    // the phone uses it: unused, it is not a device and expires. A paired
    // device asking records itself as the minter, so revoking it revokes this
    // token too; a device whose own pairing is gone is refused (403).
    const minted: MintedPairingToken = ((): MintedPairingToken => {
      try {
        const scopes = mintedPairingScopes(invocation.context, undefined);
        // The owner's pairing flow: a device paired from the owner's own credential (the
        // operator token, an admin sign-in, an app on his machine, a device he paired himself)
        // with full authority is his device. From an automation or Agent credential, or
        // narrowed, it is automation. Recorded at the mint and never changed afterwards.
        const ownerPairing = scopes === undefined && invocation.context.admin === true
          && invocation.context.credentialKind !== 'agent' && !isAutomationCredential(invocation.context);
        const input = { name, mintedBy: pairingTokenIdOfPrincipal(invocation.context.principalId),
          ...(scopes !== undefined ? { scopes } : {}), ...(ownerPairing ? { origin: 'owner-pairing' as const } : {}) };
        // A client moving off the shared token pairs ITSELF through this flow: it already
        // uses this daemon, so its mint is exempt from device.nodes.maxPaired as
        // pairing.tokens.migrate's is.
        return fromSharedToken ? deps.tokens.mintForMigration(input) : deps.tokens.mint(input);
      } catch (error) {
        if (error instanceof PairingLimitReachedError) {
          throw new GatewayVerbError(error.message, error.code, 409);
        }
        if (error instanceof PairingMinterRevokedError) {
          throw new GatewayVerbError(error.message, error.code, 403);
        }
        throw error;
      }
    })();
    const fragment = buildPairingHandoffFragment({ token: minted.token, offers });
    const webOrigin = deps.webOrigin?.();
    const deepLink = webOrigin ? buildPairingHandoffLink({ webOrigin, token: minted.token, offers }) : undefined;
    return {
      token: minted,
      offers: offerDetails,
      fragment,
      ...(deepLink ? { deepLink } : {}),
      // The honest TLS/capability posture of the origin the QR points at, so a
      // surface states the plain-http-LAN line ONCE at pairing (never a nag)
      // and labels browser-gated gaps instead of rendering dead buttons.
      ...(webOrigin ? { posture: describeOriginPosture(webOrigin) } : {}),
    };
  };
}

/**
 * pairing.posture.get, the same posture read outside a pairing exchange: a
 * surface passes its OWN current origin (or omits it to read the configured web
 * origin) and renders labeled capability gaps for wherever it is running.
 */
function createPostureGetHandler(deps: PairingHandoffDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const origin = typeof params.origin === 'string' && params.origin.trim().length > 0
      ? params.origin
      : deps.webOrigin?.();
    if (!origin) {
      throw new GatewayVerbError('No origin supplied and no web origin is configured', 'ORIGIN_UNKNOWN', 404);
    }
    return { posture: describeOriginPosture(origin) };
  };
}

interface OfferResult {
  readonly kind: PairingHandoffOfferKind;
  readonly status: 'completed' | 'declined' | 'unavailable' | 'failed';
  readonly detail?: string;
}

/**
 * The same content validation `push.subscriptions.create` applies: a hand-off
 * is a registration too, so junk key material is refused here rather than
 * stored and left to fail at delivery time.
 */
function readKeys(value: unknown): { p256dh: string; auth: string } {
  if (value === null || typeof value !== 'object') {
    throw new GatewayVerbError('notifications.keys is required', 'INVALID_ARGUMENT', 400, 'notifications.keys');
  }
  const keys = value as Record<string, unknown>;
  const p256dh = requireStringValue(keys.p256dh, 'notifications.keys.p256dh');
  const auth = requireStringValue(keys.auth, 'notifications.keys.auth');
  const p256dhProblem = describeP256dhProblem(p256dh);
  if (p256dhProblem) throw new GatewayVerbError(p256dhProblem, 'INVALID_ARGUMENT', 400, 'notifications.keys.p256dh');
  const authProblem = describeAuthSecretProblem(auth);
  if (authProblem) throw new GatewayVerbError(authProblem, 'INVALID_ARGUMENT', 400, 'notifications.keys.auth');
  return { p256dh, auth };
}

/** The endpoint must be a bounded http(s) URL, same rule as push.subscriptions.create. */
function readEndpoint(value: unknown): string {
  const endpoint = requireStringValue(value, 'notifications.endpoint');
  const problem = describeEndpointProblem(endpoint);
  if (problem) throw new GatewayVerbError(problem, 'INVALID_ARGUMENT', 400, 'notifications.endpoint');
  return endpoint;
}

function createHandoffCompleteHandler(deps: PairingHandoffDeps): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const accept = (params.accept && typeof params.accept === 'object' ? params.accept : {}) as Record<string, unknown>;
    const available = availableOffers(deps);
    const results: OfferResult[] = [];

    for (const kind of PAIRING_HANDOFF_OFFER_KINDS) {
      const offered = accept[kind];
      if (offered === undefined || offered === false) {
        // Omitted or explicitly declined, reported, never silently applied.
        results.push({ kind, status: 'declined' });
        continue;
      }
      if (!available.has(kind)) {
        results.push({ kind, status: 'unavailable', detail: `${kind} is not offered by this daemon` });
        continue;
      }
      try {
        if (kind === 'notifications') {
          const offer = offered as Record<string, unknown>;
          const endpoint = readEndpoint(offer.endpoint);
          const keys = readKeys(offer.keys);
          const deviceId = typeof offer.deviceId === 'string' ? offer.deviceId : undefined;
          await deps.push.subscribe({ principalId, endpoint, keys, ...(deviceId ? { deviceId } : {}) });
          results.push({ kind, status: 'completed' });
        } else if (kind === 'passkey' && deps.stepUp) {
          const offer = offered as Record<string, unknown>;
          await deps.stepUp.registerCredential({
            rpId: requireStringValue(offer.rpId, 'passkey.rpId'),
            origin: requireStringValue(offer.origin, 'passkey.origin'),
            credentialId: requireStringValue(offer.credentialId, 'passkey.credentialId'),
            publicKeyCose: requireStringValue(offer.publicKeyCose, 'passkey.publicKeyCose'),
          });
          results.push({ kind, status: 'completed' });
        } else if (kind === 'relay') {
          // Relay acceptance is an acknowledgement: the surface is cleared to
          // connect through the rendezvous relay with its pairing token. The
          // detail says so, because "completed" alone reads as something armed.
          results.push({ kind, status: 'completed', detail: 'Acknowledged: nothing was set up on the daemon; this surface may connect through the relay with its pairing token.' });
        } else {
          results.push({ kind, status: 'unavailable', detail: `${kind} cannot be completed here` });
        }
      } catch (error) {
        // A refused offer (bad key material, missing field) is that offer's own failed result: earlier offers already took effect and must still be reported.
        results.push({ kind, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }

    return { results };
  };
}

const HANDOFF_HANDLER_FACTORIES: Readonly<Record<string, (deps: PairingHandoffDeps) => GatewayMethodHandler>> = {
  'pairing.handoff.create': createHandoffCreateHandler,
  'pairing.handoff.complete': createHandoffCompleteHandler,
  'pairing.posture.get': createPostureGetHandler,
};

/**
 * Attach the `pairing.handoff.*` handlers to their cataloged descriptors. A
 * missing descriptor is a silent no-op (construction must never fail because one
 * verb failed to register; the operator-contract gates catch a real drift).
 */
export function registerPairingHandoffGatewayMethods(catalog: GatewayMethodCatalog, deps: PairingHandoffDeps): void {
  for (const [methodId, factory] of Object.entries(HANDOFF_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(deps), { replace: true });
    }
  }
}
