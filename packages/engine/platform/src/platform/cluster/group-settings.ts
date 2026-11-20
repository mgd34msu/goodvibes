/**
 * group-settings.ts, the `cluster.*` settings the group layer reads.
 *
 * Kept apart from settings.ts (which resolves the election's timing) so the two
 * concerns can be changed independently, and so a consumer that only wants one
 * of them does not pull in the other.
 *
 * Every value is CLAMPED rather than rejected. A daemon that refuses to
 * participate because someone typed `keyRotationHours: 0` is worse than one
 * that uses a sane floor and says what it did in the log.
 */

/** Resolved group-layer settings. */
export interface ClusterGroupSettings {
  /**
   * Whether this machine takes part at all.
   *
   * The same `cluster.enabled` the election reads. With it off, the group layer
   * opens no socket, sends no beacon and runs no timers, it only reads what is
   * already stored, so `cluster status`, `cluster key` and `cluster nodes` can
   * still answer honestly about a group this machine belongs to but is not
   * currently participating in.
   */
  readonly enabled: boolean;
  /** How often the internal group key is replaced, in hours. */
  readonly keyRotationHours: number;
  /** How long both generations are accepted around a rotation, in minutes. */
  readonly keyRotationGraceMinutes: number;
  /** How often this node advertises its group on the network, in seconds. */
  readonly beaconSeconds: number;
  /** How often the member list is gossiped to the group, in seconds. */
  readonly rosterGossipSeconds: number;
  /**
   * How long a revoked entry stays on the record, in minutes, never below
   * `revocationRetentionFloorMinutes(rosterGossipSeconds)`.
   */
  readonly revocationRetentionMinutes: number;
}

export const DEFAULT_CLUSTER_GROUP_SETTINGS: ClusterGroupSettings = {
  enabled: false,
  keyRotationHours: 24,
  keyRotationGraceMinutes: 5,
  beaconSeconds: 15,
  rosterGossipSeconds: 60,
  revocationRetentionMinutes: 43_200,
};

/** The gossip is checked on a 30 second timer, so a shorter setting gossips every 30 s. */
const GOSSIP_CHECK_SECONDS = 30;
/**
 * Gossip rounds a member may miss before it counts as behind its group. The
 * retention also decides that (authority-sync.ts), so it must span several
 * rounds, or members in step would keep reading as behind.
 */
export const REVOCATION_RETENTION_GOSSIP_ROUNDS = 4;

/** The least `cluster.revocationRetentionMinutes` allowed with this gossip interval. */
export function revocationRetentionFloorMinutes(rosterGossipSeconds: unknown): number {
  const gossip = typeof rosterGossipSeconds === 'number' && Number.isFinite(rosterGossipSeconds) ? rosterGossipSeconds : 60;
  return Math.ceil((REVOCATION_RETENTION_GOSSIP_ROUNDS * Math.max(GOSSIP_CHECK_SECONDS, gossip)) / 60);
}

/** The retention in force, in ms: the setting, raised to the floor a hand-edited file could go under. */
export function revocationRetentionMs(settings: Pick<ClusterGroupSettings, 'revocationRetentionMinutes'>): number {
  return settings.revocationRetentionMinutes * 60_000;
}

function numberOf(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Normalize a raw `cluster` config category into resolved group settings. */
export function resolveClusterGroupSettings(raw: unknown): ClusterGroupSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_CLUSTER_GROUP_SETTINGS;
  const source = raw as Record<string, unknown>;
  return {
    enabled: source['enabled'] === true,
    // One hour is the floor: rotating faster than the acceptance window is wide
    // would leave a node permanently mid-cutover. One year is the ceiling, past
    // which "rotates automatically" stops being a true description.
    keyRotationHours: numberOf(source['keyRotationHours'], 24, 1, 8_760),
    keyRotationGraceMinutes: numberOf(source['keyRotationGraceMinutes'], 5, 1, 120),
    beaconSeconds: numberOf(source['beaconSeconds'], 15, 5, 3_600),
    rosterGossipSeconds: numberOf(source['rosterGossipSeconds'], 60, 10, 3_600),
    revocationRetentionMinutes: Math.max(
      revocationRetentionFloorMinutes(numberOf(source['rosterGossipSeconds'], 60, 10, 3_600)),
      numberOf(source['revocationRetentionMinutes'], 43_200, 1, 525_600)),
  };
}

/** Rotation interval in ms. */
export function keyRotationMs(settings: ClusterGroupSettings): number {
  return settings.keyRotationHours * 60 * 60 * 1_000;
}

/** Dual-generation acceptance window in ms. */
export function keyRotationGraceMs(settings: ClusterGroupSettings): number {
  return settings.keyRotationGraceMinutes * 60 * 1_000;
}
