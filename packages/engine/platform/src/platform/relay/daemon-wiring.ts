// relay/daemon-wiring.ts
//
// Binds the injected-I/O reachability controller (reachability.ts) to the live
// daemon's config, capability gate, secret custody, and request dispatch. Kept out
// of the daemon facade so the facade's boot seam stays a single call and the
// controller itself stays free of daemon-specific types.

import { revealOrNull } from '../security/secret.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { isFeatureGateEnabled, type FeatureFlagReader } from '../runtime/feature-flags/index.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import type { SerializedRelayIdentity } from '@goodvibes/engine/transport-core/relay';
import { isRelayTunneledRequest } from '@goodvibes/engine/daemon-api';
import { refusal, refusalErrorBody } from '@goodvibes/engine/errors';
import { createRelayReachability, type RelayReachability } from './reachability.js';
import type { RelayCodeStore } from './relay-codes.js';
import { RELAY_CODE_HEADER } from '@goodvibes/engine/transport-core/relay';
import type { StepUpService } from './step-up-service.js';
import {
  STEP_UP_ASSERTION_HEADER,
  callNeedsStepUp,
  evaluateStepUp,
  type StepUpAssertionVerifier,
} from './step-up-policy.js';

/** What the gate reads on every request, so a setting changed while the daemon runs applies to the next call. */
export interface StepUpGateState {
  /** Whether relay reachability is currently allowed at all. */
  relayEnabled(): boolean;
  /** Whether state-changing relay calls currently need a step-up assertion. */
  requireStepUp(): boolean;
  /** The rendezvous id of the live relay registration, when there is one. */
  rendezvousId(): string | null;
  /**
   * Whether the relay code a relayed request presented is one this daemon
   * issued and has not revoked (relay-codes.ts). Absent: every relayed request is refused.
   */
  relayCodeAdmits?(code: string | null): boolean;
}

/**
 * What the daemon already knows about a relayed request before it runs: the
 * scopes of the catalog method it addresses and who it authenticates as.
 */
export interface RelayRequestFacts {
  /** Scopes of the catalog method the request addresses, or null when it addresses none. */
  methodScopes(req: Request): readonly string[] | null;
  /** The principal the request authenticates as, or null when it carries no valid credential. */
  principalId(req: Request): string | null;
}

const GENERIC_INVOKE_PATH = /^\/api\/(?:control-plane\/methods|control\/gateway-methods)\/([^/]+)\/invoke$/;

/**
 * Request facts from the daemon's method catalog and its request
 * authentication. A generic invoke is one map read; a REST binding is the
 * catalog's own binding match. Authentication binds its context to the
 * request, so the router's check of the same request is an integer compare.
 */
export function relayRequestFactsFrom(
  catalog: Pick<GatewayMethodCatalog, 'get' | 'findByHttpBinding'>,
  authenticate: (req: Request) => { readonly principal: { readonly principalId: string } } | null,
): RelayRequestFacts {
  return {
    methodScopes(req) {
      const pathname = new URL(req.url).pathname;
      const invoke = req.method.toUpperCase() === 'POST' ? GENERIC_INVOKE_PATH.exec(pathname) : null;
      if (invoke) {
        let id: string;
        try {
          id = decodeURIComponent(invoke[1]!);
        } catch {
          return null;
        }
        return catalog.get(id)?.scopes ?? null;
      }
      return catalog.findByHttpBinding(req.method, pathname)?.scopes ?? null;
    },
    principalId: (req) => authenticate(req)?.principal.principalId ?? null,
  };
}

/** The session a request path addresses (`/api/sessions/<id>/...`), when it names one. */
function sessionIdOfPath(pathname: string): string | undefined {
  const match = /^\/api\/sessions\/([^/]+)/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Wrap a dispatch so relayed calls follow the current relay settings: a call
 * that arrives over the relay after relay access was turned off is refused, and
 * state-changing relay calls are gated by the WebAuthn step-up policy while the
 * requirement is on. Both settings are read per request (two in-memory reads),
 * so turning relay access off or the requirement on applies to the next call
 * without a restart. The step-up gate fails closed unless the verifier
 * genuinely confirms a fresh assertion carried in the step-up header, and a
 * refusal names the reason and the action that gets past it.
 *
 * With `facts`, whether a call changes state is read from its catalog method's
 * scopes and the challenge must have been minted by the same principal; without
 * them (a host that has no catalog) the HTTP verb decides.
 */
export function wrapDispatchWithStepUp(
  dispatch: (req: Request) => Promise<Response | null>,
  gate: StepUpGateState,
  verifier: StepUpAssertionVerifier,
  facts?: RelayRequestFacts,
): (req: Request) => Promise<Response | null> {
  return async (req) => {
    const viaRelay = isRelayTunneledRequest(req);
    if (!viaRelay) return dispatch(req);
    if (!gate.relayEnabled()) {
      return jsonResponse(refusalErrorBody(refusal({
        code: 'RELAY_DISABLED',
        state: 'relay access is turned off on this daemon',
        reason: 'This call arrived over the relay, and relay access is turned off on this daemon (relay.enabled or the relay-connect flag).',
        next: ['Connect to the daemon directly (same network), or turn relay access back on there with relay.enabled and the relay-connect flag.'],
        status: 503,
        retryable: false,
      })), 503);
    }
    // Each paired device presents its own relay code; a revoked or unknown one is refused before anything runs.
    if (gate.relayCodeAdmits?.(req.headers.get(RELAY_CODE_HEADER)) !== true) {
      return jsonResponse(refusalErrorBody(refusal({
        code: 'RELAY_CODE_REVOKED',
        state: 'this device\'s relay access is revoked or was never issued',
        reason: 'This call arrived over the relay with a relay code this daemon did not issue or has revoked.',
        next: ['Pair this device with the relay again from the home network: /devices pair relay in the terminal app, or goodvibes-agent relay pair.'],
        status: 401,
        retryable: false,
      })), 401);
    }
    if (!gate.requireStepUp()) return dispatch(req);
    const pathname = new URL(req.url).pathname;
    // Minting a challenge is the prerequisite for producing an assertion, so it
    // cannot itself require one. Its catalog method is a read; this covers a
    // host with no catalog.
    if (!facts && pathname === STEP_UP_CHALLENGE_MINT_PATH) return dispatch(req);
    const mutating = callNeedsStepUp(facts ? facts.methodScopes(req) : null, req.method);
    if (!mutating) return dispatch(req);
    const rendezvousId = gate.rendezvousId() ?? undefined;
    const sessionId = sessionIdOfPath(pathname);
    const principalId = facts ? (facts.principalId(req) ?? '') : undefined;
    const verification = await verifier(req.headers.get(STEP_UP_ASSERTION_HEADER), {
      method: req.method,
      path: pathname,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(rendezvousId !== undefined ? { rendezvousId } : {}),
      ...(principalId !== undefined ? { principalId } : {}),
    });
    const decision = evaluateStepUp({ viaRelay, mutating, requireStepUp: true, verification });
    if (!decision.allow) {
      const body = refusalErrorBody(refusal({
        code: decision.code,
        state: 'the call was not run',
        reason: decision.message,
        next: decision.next,
        status: 401,
        retryable: decision.action !== 'register-locally',
      }));
      // The credential was accepted; the call needs a passkey confirmation on top of it,
      // so the category is 'permission', never 'authentication' (which clients read as "sign in again").
      return jsonResponse({ ...body, category: 'permission', reason: decision.reason, action: decision.action }, 401, { 'www-authenticate': 'WebAuthn' });
    }
    return dispatch(req);
  };
}

const IDENTITY_SECRET_KEY = 'relay.identity';

/** How many step-up passkeys the daemon holds: a read, and the count as last read or written. */
export type StepUpCredentialCount = Pick<StepUpService, 'credentialCount' | 'lastKnownCredentialCount'>;

/**
 * Refuse turning `relay.requireStepUpForMutations` on while no passkey is
 * registered: every state-changing relay call would then be refused, and a
 * passkey cannot be registered through the relay, so the owner would learn it
 * only away from home. The store is read now, so the count is known by the
 * time anyone writes the setting; an unread count is refused as unconfirmed.
 */
export function admitStepUpRequirement(configManager: Pick<ConfigManager, 'registerWriteAdmission'>, credentials: StepUpCredentialCount): () => void {
  const refresh = (): void => { void credentials.credentialCount().catch(() => undefined); };
  refresh();
  return configManager.registerWriteAdmission('relay.requireStepUpForMutations', (value, current) => {
    if (value !== true || current === true) return null;
    const count = credentials.lastKnownCredentialCount();
    if (count !== undefined && count > 0) return null;
    // Read again, so a passkey registered by another process is seen on the next try.
    refresh();
    const register = 'Register a passkey with stepup.credentials.register over a direct connection to the daemon (not through the relay), then turn this on.';
    return count === 0
      ? { reason: 'no step-up passkey is registered, so requiring step-up would refuse every state-changing call through the relay, and a passkey cannot be registered through the relay.', next: [register] }
      : { reason: 'the daemon has not finished reading its passkey store, so it cannot confirm a passkey is registered.', next: ['Try again in a moment.', register] };
  });
}

/** The step-up challenge-mint REST path, exempt from the step-up gate (bootstrap) on a host with no catalog. */
const STEP_UP_CHALLENGE_MINT_PATH = '/api/stepup/challenge';

/**
 * Compose a {@link RelayReachability} from daemon collaborators. The daemon's
 * relay identity is persisted through the SecretsManager (JSON), and tunneled
 * requests are replayed through `dispatch`, the daemon's own request handler,
 * so a relayed call is indistinguishable from a LAN call save for the via-relay
 * marker header.
 */
export function buildDaemonRelayReachability(
  configManager: ConfigManager,
  secrets: Pick<SecretsManager, 'get' | 'set'>,
  featureFlags: FeatureFlagReader,
  dispatch: (req: Request) => Promise<Response | null>,
  logger: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void },
  verifyStepUp: StepUpAssertionVerifier,
  requestFacts?: RelayRequestFacts,
  stepUpCredentials?: StepUpCredentialCount,
  relayCodes?: Pick<RelayCodeStore, 'verify'>,
): RelayReachability {
  if (stepUpCredentials) admitStepUpRequirement(configManager, stepUpCredentials);
  const gate: StepUpGateState = {
    relayEnabled: () => reachability.isEnabled(),
    requireStepUp: () => configManager.get('relay.requireStepUpForMutations'),
    rendezvousId: () => reachability.rendezvousId,
    relayCodeAdmits: (code) => relayCodes?.verify(code) != null,
  };
  const reachability: RelayReachability = createRelayReachability({
    // Read when needed, not once here, so a changed setting applies on the next
    // reconcile or request instead of waiting for a daemon restart.
    config: () => ({
      enabled: configManager.get('relay.enabled'),
      url: configManager.get('relay.url'),
      rendezvousId: configManager.get('relay.rendezvousId'),
      label: configManager.get('relay.label'),
    }),
    featureFlagEnabled: () => isFeatureGateEnabled(featureFlags, 'relay-connect'),
    identityStore: {
      load: async () => {
        const raw = revealOrNull(await secrets.get(IDENTITY_SECRET_KEY), 'dispatch');
        return raw ? (JSON.parse(raw) as SerializedRelayIdentity) : null;
      },
      save: async (identity) => {
        await secrets.set(IDENTITY_SECRET_KEY, JSON.stringify(identity));
      },
    },
    dispatch: wrapDispatchWithStepUp(dispatch, gate, verifyStepUp, requestFacts),
    onRendezvousId: (rid) => configManager.set('relay.rendezvousId', rid),
    logger: {
      info: (m, f) => logger.info(`relay: ${m}`, f),
      warn: (m, f) => logger.warn(`relay: ${m}`, f),
      error: (m, f) => logger.warn(`relay: ${m}`, f),
    },
  });
  return reachability;
}
