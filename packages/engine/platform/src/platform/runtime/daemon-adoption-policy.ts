/**
 * daemon-adoption-policy.ts, the SHARED adopt DECISION policy.
 *
 * Find an already-running compatible daemon and attach to it, else run without
 * one. A surface never starts a daemon of its own: a daemon that is installed
 * but stopped is started through the service manager
 * (runtime/client/daemon-autostart.ts). The probing I/O lives in
 * bootstrap-services.ts behind injectable seams; THIS module is the pure decision
 * every consumer routes through, so the ruling is identical everywhere and unit
 * testable without real sockets.
 *
 *   - A compatible-daemon check is ALWAYS applied before adopting.
 *   - A probe is always the source of truth for "is a daemon there and mine"
 *     (no pid/lockfile is trusted; that is the caller's discovery hint only).
 */

/** Result of probing the occupant of the configured daemon host/port. */
export interface DaemonIdentityProbeResult {
  readonly kind: 'goodvibes' | 'unauthorized' | 'unknown';
  readonly status?: string | undefined;
  /** The daemon artifact's own release version (its package version, e.g. 1.28.x). */
  readonly version?: string | undefined;
  /**
   * The platform build the daemon is composed from (`/status` serves it as
   * `platformVersion`). THIS is the wire-compatibility axis: a surface and a
   * daemon are wire-compatible when their platform builds share a band, and
   * comparing the artifact version instead put the daemon's 1.x package
   * number against a surface's 2.x platform number and refused every adoption.
   */
  readonly platformVersion?: string | undefined;
  readonly reason?: string | undefined;
}

/** How a probed occupant is classified against this surface. */
export type DaemonProbeClassification = 'adopt' | 'incompatible' | 'blocked';

export interface DaemonProbeClassificationInput {
  readonly identity: DaemonIdentityProbeResult;
  /** This surface's own version. */
  readonly localVersion: string;
  /** Version band predicate (defaults to the shared band policy at the call site). */
  readonly versionCompatible: (localVersion: string, remoteVersion: string | undefined) => boolean;
}

/**
 * Classify the occupant of the configured port:
 *   - a verified GoodVibes daemon on a compatible version band → `adopt`;
 *   - a verified GoodVibes daemon on an INCOMPATIBLE band → `incompatible`
 *     (never adopt, never start a competitor);
 *   - anything unverified (unauthorized/unknown) → `blocked`.
 *
 * The version band-check is UNCONDITIONAL here: `goodvibes` proves it is a
 * GoodVibes daemon, not that it speaks a wire version this surface can adopt.
 */
export function classifyDaemonProbe(input: DaemonProbeClassificationInput): DaemonProbeClassification {
  if (input.identity.kind !== 'goodvibes') return 'blocked';
  // Band-check the PLATFORM build when the daemon reports one: wire
  // compatibility is an platform-contract property, and the artifact's own release
  // number lives on a different axis (daemon 1.28.x carries platform 2.x). A
  // daemon old enough not to report platformVersion is judged by its
  // artifact version, which for such builds is the only signal there is.
  const remoteWireVersion = input.identity.platformVersion ?? input.identity.version;
  return input.versionCompatible(input.localVersion, remoteWireVersion) ? 'adopt' : 'incompatible';
}

/** The action the adopt policy selects. */
export type DaemonAdoptionAction =
  | 'disabled'      // daemon.enabled is false
  | 'adopt'         // a compatible GoodVibes daemon is already running, attach
  | 'incompatible'  // a GoodVibes daemon is running on an incompatible band, refuse to adopt it
  | 'blocked'       // the port is occupied by an unverified process, continue without a daemon
  | 'absent';       // port free: no daemon is running, continue without one

export interface DaemonAdoptionDecision {
  readonly action: DaemonAdoptionAction;
  /** Honest, human-readable reason for the chosen action. */
  readonly reason: string;
  /** The probe result, when the port was occupied. */
  readonly identity?: DaemonIdentityProbeResult | undefined;
}

export interface DaemonAdoptionPolicyInput {
  /** Whether the daemon is enabled for this surface (daemon.enabled). */
  readonly enabled: boolean;
  /** Whether the configured host/port is currently accepting connections. */
  readonly portInUse: boolean;
  /** The identity probe of the occupant, required when `portInUse`, ignored otherwise. */
  readonly identity: DaemonIdentityProbeResult | null;
  readonly localVersion: string;
  readonly versionCompatible: (localVersion: string, remoteVersion: string | undefined) => boolean;
}

/**
 * Decide whether to adopt, from probe results + config. Pure. The caller maps the
 * returned action onto a status (adopt = external, absent = unavailable, etc.)
 * and supplies the surface-specific
 * status strings, this function owns only the ruling, so it is identical for
 * every consumer.
 */
export function decideDaemonAdoption(input: DaemonAdoptionPolicyInput): DaemonAdoptionDecision {
  if (!input.enabled) {
    return { action: 'disabled', reason: 'daemon.enabled is false' };
  }

  if (input.portInUse) {
    const identity = input.identity ?? { kind: 'unknown', reason: 'Configured daemon port is occupied by an unverified process' };
    const classification = classifyDaemonProbe({
      identity,
      localVersion: input.localVersion,
      versionCompatible: input.versionCompatible,
    });
    if (classification === 'adopt') {
      return { action: 'adopt', identity, reason: 'A compatible GoodVibes daemon is already running on the configured host/port' };
    }
    if (classification === 'incompatible') {
      return { action: 'incompatible', identity, reason: 'A GoodVibes daemon is running on an incompatible version band; refusing to adopt or start a competing daemon' };
    }
    return { action: 'blocked', identity, reason: identity.reason ?? 'Configured daemon port is occupied by an unverified process' };
  }

  return { action: 'absent', reason: 'No GoodVibes daemon is running on the configured host/port' };
}
