/**
 * settings.ts, turn the `cluster.*` config category into election settings.
 *
 * The config schema owns every default and every range, and a settings file
 * is checked against it when it is read and when a value is set, so nothing
 * here repeats either. What is left are the rules the schema cannot state on a
 * single setting: the master timeout is at least two heartbeats (the setting's
 * description says a lower value is raised at runtime), and a booting node
 * waits for a master's answer no longer than the master timeout. The values
 * returned are the ones in effect; timing.ts derives from them unchanged.
 */
import { clusterConfigDefaults, type ClusterConfig } from '../config/schema-domain-cluster.js';
import type { ClusterSettings } from './types.js';

/**
 * Administratively-scoped multicast group (239.0.0.0/8, RFC 2365), never
 * routed off the local network by a conforming router. The last two octets
 * are the ASCII codes for "GV". Defined by the config schema.
 */
export const DEFAULT_CLUSTER_MULTICAST_GROUP = clusterConfigDefaults.cluster.multicastGroup;

/**
 * Inside the IANA Dynamic/Private range and above the Linux ephemeral range, so
 * a transient outbound socket cannot take it first. Defined by the config schema.
 */
export const DEFAULT_CLUSTER_PORT = clusterConfigDefaults.cluster.port;

/** Resolve the `cluster` category. Absent fields take the schema's defaults. */
export function resolveClusterSettings(config?: Readonly<Partial<ClusterConfig>>): ClusterSettings {
  const source = { ...clusterConfigDefaults.cluster, ...config };
  // A master timeout below two heartbeats would declare a healthy master
  // dead between its own beats.
  const masterTimeoutSeconds = Math.max(source.masterTimeoutSeconds, source.heartbeatSeconds * 2);
  return {
    enabled: source.enabled,
    heartbeatSeconds: source.heartbeatSeconds,
    masterTimeoutSeconds,
    bootProbeSeconds: Math.min(source.bootProbeSeconds, masterTimeoutSeconds),
    port: source.port,
    // The schema has no rule for these two: a blank group and blank peers mean
    // "not set", not an address.
    multicastGroup: source.multicastGroup.trim() || DEFAULT_CLUSTER_MULTICAST_GROUP,
    secret: source.secret,
    peers: source.peers.filter((entry) => typeof entry === 'string' && entry.trim().length > 0),
  };
}

export const DEFAULT_CLUSTER_SETTINGS: ClusterSettings = resolveClusterSettings();
