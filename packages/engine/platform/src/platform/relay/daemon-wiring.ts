// relay/daemon-wiring.ts
//
// Binds the injected-I/O reachability controller (reachability.ts) to the live
// daemon's config, capability gate, secret custody, and request dispatch. Kept out
// of the daemon facade so the facade's boot seam stays a single call and the
// controller itself stays free of daemon-specific types.

import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { isFeatureGateEnabled, type FeatureFlagReader } from '../runtime/feature-flags/index.js';
import type { SerializedRelayIdentity } from '@goodvibes-jev/engine/transport-core/relay';
import { isRelayTunneledRequest } from '@goodvibes-jev/engine/daemon-api';
import { createRelayReachability, type RelayReachability } from './reachability.js';
import {
  STEP_UP_ASSERTION_HEADER,
  evaluateStepUp,
  isMutatingMethod,
  type StepUpAssertionVerifier,
} from './step-up-policy.js';

/** What the gate reads on every request, so a setting changed while the daemon runs applies to the next call. */
export interface StepUpGateState {
  /** Whether relay reachability is currently allowed at all. */
  relayEnabled(): boolean;
  /** Whether mutating relay calls currently need a step-up assertion. */
  requireStepUp(): boolean;
  /** The rendezvous id of the live relay registration, when there is one. */
  rendezvousId(): string | null;
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

/**
 * Wrap a dispatch so relayed calls follow the current relay settings: a call
 * that arrives over the relay after relay access was turned off is refused, and
 * mutating relay calls are gated by the WebAuthn step-up policy while the
 * requirement is on. Both are read per request, so neither needs a restart. The
 * step-up gate fails closed unless the verifier genuinely confirms a fresh
 * assertion carried in the step-up header.
 */
export function wrapDispatchWithStepUp(
  dispatch: (req: Request) => Promise<Response | null>,
  gate: StepUpGateState,
  verifier: StepUpAssertionVerifier,
): (req: Request) => Promise<Response | null> {
  return async (req) => {
    const viaRelay = isRelayTunneledRequest(req);
    if (!viaRelay) return dispatch(req);
    if (!gate.relayEnabled()) {
      return new Response(JSON.stringify({
        error: 'relay-disabled',
        message: 'Relay access is turned off on this daemon (relay.enabled or the relay-connect flag).',
      }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    if (!gate.requireStepUp()) return dispatch(req);
    const mutating = isMutatingMethod(req.method);
    const pathname = new URL(req.url).pathname;
    // Bootstrap exemption: minting a step-up challenge is the prerequisite for
    // producing an assertion, so it cannot itself require one, otherwise a relay
    // client could never obtain a challenge (a deadlock). It creates only an
    // ephemeral, single-use challenge and returns no privileged data. Credential
    // registration is deliberately NOT exempt: it is an admin/local-only
    // bootstrap that a mutating-relay caller must not be able to perform.
    if (mutating && pathname === STEP_UP_CHALLENGE_MINT_PATH) {
      return dispatch(req);
    }
    if (mutating) {
      const assertion = req.headers.get(STEP_UP_ASSERTION_HEADER);
      const rendezvousId = gate.rendezvousId() ?? undefined;
      const sessionId = sessionIdOfPath(pathname);
      const verified = assertion
        ? await verifier(assertion, {
          method: req.method,
          path: pathname,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(rendezvousId !== undefined ? { rendezvousId } : {}),
        })
        : false;
      const decision = evaluateStepUp({ viaRelay, mutating, requireStepUp: true, assertionVerified: verified });
      if (!decision.allow) {
        return new Response(JSON.stringify({ error: decision.code, message: decision.message }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'WebAuthn' },
        });
      }
    }
    return dispatch(req);
  };
}

const IDENTITY_SECRET_KEY = 'relay.identity';

/** The step-up challenge-mint REST path, exempt from the step-up gate (bootstrap). */
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
): RelayReachability {
  const gate: StepUpGateState = {
    relayEnabled: () => reachability.isEnabled(),
    requireStepUp: () => configManager.get('relay.requireStepUpForMutations'),
    rendezvousId: () => reachability.rendezvousId,
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
        const raw = await secrets.get(IDENTITY_SECRET_KEY);
        return raw ? (JSON.parse(raw) as SerializedRelayIdentity) : null;
      },
      save: async (identity) => {
        await secrets.set(IDENTITY_SECRET_KEY, JSON.stringify(identity));
      },
    },
    dispatch: wrapDispatchWithStepUp(dispatch, gate, verifyStepUp),
    onRendezvousId: (rid) => configManager.set('relay.rendezvousId', rid),
    logger: {
      info: (m, f) => logger.info(`relay: ${m}`, f),
      warn: (m, f) => logger.warn(`relay: ${m}`, f),
      error: (m, f) => logger.warn(`relay: ${m}`, f),
    },
  });
  return reachability;
}
