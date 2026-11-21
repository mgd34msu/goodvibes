// relay/reachability.ts
//
// The daemon-side controller that decides whether the daemon should be reachable
// through the zero-knowledge relay, and owns the outbound registration's
// lifecycle. It sits between the daemon boot graph and the transport-level
// registration manager (createRelayDaemonRegistration), keeping the boot seam a
// couple of lines: the facade constructs one of these and calls start()/stop().
//
// Enablement is deliberately double-gated, mirroring how exec-sandbox gates
// itself: the `relay.enabled` setting AND the `relay-connect` capability gate
// AND a configured `relay.url` must all be true. Any one off keeps the daemon
// LAN-only with the relay path byte-for-byte inert.
//
// The daemon relay identity is generated once and persisted through an injected
// store (a thin adapter over the daemon SecretsManager), so pairing payloads
// stay valid across restarts; the controller loads it once and keeps it. All I/O is injected, so this is fully testable
// without a daemon.

import {
  createRelayDaemonRegistration,
  type RelayClientWebSocket,
  type RelayDaemonRegistration,
  type RelayRegistrationLogger,
  type RelayRegistrationRefusal,
  type RelayRegistrationStatus,
} from '@goodvibes/engine/daemon-api';
import {
  deserializeRelayIdentity,
  generateRelayIdentity,
  relayIdentityRendezvousId,
  serializeRelayIdentity,
  type RelayKeyPair,
  type RelayPairingPayload,
  type SerializedRelayIdentity,
} from '@goodvibes/engine/transport-core/relay';

/** Durable custody of the daemon's relay identity (adapter over SecretsManager). */
export interface RelayIdentityStore {
  load(): Promise<SerializedRelayIdentity | null>;
  save(identity: SerializedRelayIdentity): Promise<void>;
}

/** The `relay.*` config slice this controller reads. */
export interface RelayReachabilityConfig {
  readonly enabled: boolean;
  readonly url: string;
  readonly rendezvousId: string;
  readonly label: string;
}

export interface RelayReachabilityOptions {
  /** The `relay.*` settings; a function is read each time they are needed, so a change applies without a rebuild. */
  readonly config: RelayReachabilityConfig | (() => RelayReachabilityConfig);
  /** Whether the `relay-connect` capability gate is on; a function is read each time it is needed. */
  readonly featureFlagEnabled: boolean | (() => boolean);
  readonly identityStore: RelayIdentityStore;
  /** Replay a reconstructed request against the daemon (e.g. facade.handleRequest). */
  readonly dispatch: (req: Request) => Promise<Response | null>;
  /** Base URL used to resolve tunneled paths (host is irrelevant; routing is by path). */
  readonly localBaseUrl?: string;
  readonly webSocketImpl?: (url: string) => RelayClientWebSocket;
  /**
   * Called with the rendezvous id derived from the identity key when it differs
   * from the recorded `relay.rendezvousId`, so the caller can record it.
   */
  readonly onRendezvousId?: (rid: string) => void;
  readonly logger?: RelayRegistrationLogger;
  readonly onStatusChange?: (status: RelayRegistrationStatus) => void;
}

/** What `relay.reachability.get` reports as the relay status. */
export type RelayReachabilityStatus = RelayRegistrationStatus | 'disabled' | 'failed';

/** The composed reachability controller. */
export interface RelayReachability {
  /** Start the outbound registration if enabled; otherwise a no-op. */
  start(): Promise<void>;
  /** Stop the outbound registration. A start still in progress is cancelled. */
  stop(): void;
  /**
   * Bring the registration in line with the current settings: start it when it
   * has become enabled, stop it when it has been turned off or its relay url
   * changed (and start again if still enabled). The daemon calls this when a
   * `relay.*` setting or the `relay-connect` flag changes.
   */
  reconcile(): Promise<void>;
  /** Whether the relay settings and gate currently allow reachability. */
  isEnabled(): boolean;
  /**
   * The rendezvous id the live registration is registered under, derived from
   * the daemon's relay identity key, or null when none is running.
   */
  readonly rendezvousId: string | null;
  /**
   * Current status: `'disabled'` when the relay path is gated off, `'failed'`
   * when the last start failed before a registration existed (lastRefusal says
   * why), else the registration's own status.
   */
  readonly status: RelayReachabilityStatus;
  /**
   * Why the relay last refused the live registration, or why the last start
   * failed (what is true, what to do, and whether the daemon keeps trying), or
   * null when neither happened.
   */
  readonly lastRefusal: RelayRegistrationRefusal | null;
  /** Mint a pairing payload carrying `code` (the device's relay code) that a surface can scan, or null when disabled. */
  mintPairing(code: string): Promise<RelayPairingPayload | null>;
  /**
   * End every relay connection that presented a relay code `revoked` answers
   * true for (a code just revoked): its streams are closed with `reason`, its
   * requests aborted. Resolves to how many connections were closed.
   */
  closeConnectionsPresenting(revoked: (code: string) => boolean, reason: string): Promise<number>;
}

/** Whether all three gates are satisfied. */
export function isRelayReachabilityEnabled(config: RelayReachabilityConfig, featureFlagEnabled: boolean): boolean {
  return config.enabled && featureFlagEnabled && config.url.trim().length > 0;
}

export function createRelayReachability(options: RelayReachabilityOptions): RelayReachability {
  const readConfig = (): RelayReachabilityConfig =>
    typeof options.config === 'function' ? options.config() : options.config;
  const readFlag = (): boolean =>
    typeof options.featureFlagEnabled === 'function' ? options.featureFlagEnabled() : options.featureFlagEnabled;
  const isEnabled = (): boolean => isRelayReachabilityEnabled(readConfig(), readFlag());
  let registration: RelayDaemonRegistration | null = null;
  let registeredWith: { readonly url: string; readonly rid: string } | null = null;
  // One start at a time, and a stop that arrives while one is in flight wins.
  let starting: Promise<void> | null = null;
  let generation = 0;
  // The identity is loaded (or created and saved) once for the controller's
  // life. A start that follows a stop while the first load is still running
  // reuses that load, so two key pairs are never generated and saved at once.
  // A failed load is forgotten so the next start tries again.
  let identityPromise: Promise<RelayKeyPair> | null = null;
  // Why the last start failed before a registration existed; cleared by a
  // start that succeeds and by a stop. The next reconcile starts again.
  let startFailure: RelayRegistrationRefusal | null = null;

  function startFailureOf(error: unknown): RelayRegistrationRefusal {
    return {
      code: 'relay-start-failed',
      message: `The relay registration could not be started: ${error instanceof Error ? error.message : String(error)}`,
      state: 'This daemon is not reachable through the relay; it is reachable on its own network only.',
      next: ['Change relay.url, or turn relay.enabled off and on again, to start it again.', 'Or restart the daemon.'],
      retryable: true,
    };
  }

  async function loadOrCreateIdentity(): Promise<RelayKeyPair> {
    const existing = await options.identityStore.load();
    if (existing) return deserializeRelayIdentity(existing);
    const created = await generateRelayIdentity();
    await options.identityStore.save(await serializeRelayIdentity(created));
    return created;
  }

  function relayIdentity(): Promise<RelayKeyPair> {
    identityPromise ??= loadOrCreateIdentity().catch((error: unknown) => {
      identityPromise = null;
      throw error;
    });
    return identityPromise;
  }

  async function startRegistration(myGeneration: number): Promise<void> {
    const loaded = await relayIdentity();
    // The relay admits the daemon only under the id derived from its public key,
    // so that id is the one fact; the setting only records it.
    const rid = await relayIdentityRendezvousId(loaded);
    if (myGeneration !== generation) return;
    const config = readConfig();
    if (config.rendezvousId.trim() !== rid) options.onRendezvousId?.(rid);
    const next = createRelayDaemonRegistration({
      relayUrl: config.url,
      rid,
      identity: loaded,
      localBaseUrl: options.localBaseUrl ?? 'http://daemon.local',
      dispatch: options.dispatch,
      ...(options.webSocketImpl ? { webSocketImpl: options.webSocketImpl } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.onStatusChange ? { onStatusChange: options.onStatusChange } : {}),
    });
    registration = next;
    registeredWith = { url: config.url, rid };
    next.start();
  }

  function stopRegistration(): void {
    generation += 1;
    registration?.stop();
    registration = null;
    registeredWith = null;
    startFailure = null;
  }

  const controller: RelayReachability = {
    start(): Promise<void> {
      if (!isEnabled() || registration) return Promise.resolve();
      if (starting) return starting;
      const myGeneration = generation;
      const attempt = startRegistration(myGeneration).then(() => {
        if (myGeneration === generation) startFailure = null;
      }, (error: unknown) => {
        if (myGeneration === generation) startFailure = startFailureOf(error);
        throw error;
      }).finally(() => {
        if (starting === attempt) starting = null;
      });
      starting = attempt;
      return attempt;
    },
    stop(): void {
      stopRegistration();
      starting = null;
    },
    async reconcile(): Promise<void> {
      if (!isEnabled()) {
        if (registration || starting) stopRegistration();
        starting = null;
        return;
      }
      if (registration && registeredWith) {
        // The rendezvous id follows the identity key, which does not change for
        // this controller's life, so only the relay url can call for a restart.
        if (registeredWith.url === readConfig().url) return;
        stopRegistration();
        starting = null;
      }
      await controller.start();
    },
    isEnabled,
    get rendezvousId(): string | null {
      return registeredWith?.rid ?? null;
    },
    get status(): RelayReachabilityStatus {
      if (!isEnabled()) return 'disabled';
      if (registration) return registration.status;
      return startFailure ? 'failed' : 'idle';
    },
    get lastRefusal(): RelayRegistrationRefusal | null {
      if (!isEnabled()) return null;
      return registration ? registration.lastRefusal : startFailure;
    },
    async mintPairing(code: string): Promise<RelayPairingPayload | null> {
      if (!registration) return null;
      return registration.mintPairing(code, readConfig().label || undefined);
    },
    async closeConnectionsPresenting(revoked: (code: string) => boolean, reason: string): Promise<number> {
      return registration ? registration.closePipesPresenting(revoked, reason) : 0;
    },
  };
  return controller;
}
