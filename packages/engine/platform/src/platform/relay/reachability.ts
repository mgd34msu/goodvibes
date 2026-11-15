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
// stay valid across restarts. All I/O is injected, so this is fully testable
// without a daemon.

import {
  createRelayDaemonRegistration,
  type RelayClientWebSocket,
  type RelayDaemonRegistration,
  type RelayRegistrationLogger,
  type RelayRegistrationStatus,
} from '@goodvibes-jev/engine/daemon-api';
import {
  deserializeRelayIdentity,
  generateRelayIdentity,
  randomBytes,
  serializeRelayIdentity,
  toBase64Url,
  type RelayKeyPair,
  type RelayPairingPayload,
  type SerializedRelayIdentity,
} from '@goodvibes-jev/engine/transport-core/relay';

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
  /** Called with a freshly-generated rendezvous id so the caller can persist it. */
  readonly onRendezvousId?: (rid: string) => void;
  readonly logger?: RelayRegistrationLogger;
  readonly onStatusChange?: (status: RelayRegistrationStatus) => void;
}

/** The composed reachability controller. */
export interface RelayReachability {
  /** Start the outbound registration if enabled; otherwise a no-op. */
  start(): Promise<void>;
  /** Stop the outbound registration. A start still in progress is cancelled. */
  stop(): void;
  /**
   * Bring the registration in line with the current settings: start it when it
   * has become enabled, stop it when it has been turned off or its relay url or
   * rendezvous id changed (and start again if still enabled). The daemon calls
   * this when a `relay.*` setting or the `relay-connect` flag changes.
   */
  reconcile(): Promise<void>;
  /** Whether the relay settings and gate currently allow reachability. */
  isEnabled(): boolean;
  /** The rendezvous id of the live registration, or null when none is running. */
  readonly rendezvousId: string | null;
  /** Current status, or `'disabled'` when the relay path is gated off. */
  readonly status: RelayRegistrationStatus | 'disabled';
  /** Mint a pairing payload a surface can scan, or null when disabled. */
  mintPairing(): Promise<RelayPairingPayload | null>;
}

function generateRendezvousId(): string {
  return `rid_${toBase64Url(randomBytes(24))}`;
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
  let identity: RelayKeyPair | null = null;
  // A rendezvous id generated here is kept for this controller's life, so a
  // stop and start does not mint a second one and strand the pairing payloads
  // already handed out for the first.
  let generatedRid = '';
  // One start at a time, and a stop that arrives while one is in flight wins.
  let starting: Promise<void> | null = null;
  let generation = 0;

  async function loadOrCreateIdentity(): Promise<RelayKeyPair> {
    const existing = await options.identityStore.load();
    if (existing) return deserializeRelayIdentity(existing);
    const created = await generateRelayIdentity();
    await options.identityStore.save(await serializeRelayIdentity(created));
    return created;
  }

  async function startRegistration(myGeneration: number): Promise<void> {
    const loaded = await loadOrCreateIdentity();
    if (myGeneration !== generation) return;
    identity = loaded;
    const config = readConfig();
    let rid = config.rendezvousId.trim() || generatedRid;
    if (!rid) {
      rid = generateRendezvousId();
      generatedRid = rid;
      options.onRendezvousId?.(rid);
    }
    const next = createRelayDaemonRegistration({
      relayUrl: config.url,
      rid,
      identity,
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
  }

  const controller: RelayReachability = {
    start(): Promise<void> {
      if (!isEnabled() || registration) return Promise.resolve();
      if (starting) return starting;
      const attempt = startRegistration(generation).finally(() => {
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
        const config = readConfig();
        const wantedRid = config.rendezvousId.trim() || generatedRid;
        if (registeredWith.url === config.url && (wantedRid === '' || registeredWith.rid === wantedRid)) return;
        stopRegistration();
        starting = null;
      }
      await controller.start();
    },
    isEnabled,
    get rendezvousId(): string | null {
      return registeredWith?.rid ?? null;
    },
    get status(): RelayRegistrationStatus | 'disabled' {
      return isEnabled() ? (registration?.status ?? 'idle') : 'disabled';
    },
    async mintPairing(): Promise<RelayPairingPayload | null> {
      if (!registration) return null;
      return registration.mintPairing(readConfig().label || undefined);
    },
  };
  return controller;
}
