/**
 * schema-domain-cluster.ts, the `cluster.*` config domain.
 *
 * These settings describe how the local network's goodvibes nodes agree on
 * which ONE of them consumes inbound channel messages. They never affect
 * outbound sends, sessions, the control plane, or HTTP, those run on every
 * node regardless of who holds the role.
 *
 * `cluster.peers` is a list setting; its row is in schema-domain-lists.ts.
 */
import { intRange, port, type ConfigSettingDefinition } from './schema-shared.js';

/** LAN leader election (`cluster.*`). */
export interface ClusterConfig {
  enabled: boolean;
  heartbeatSeconds: number;
  masterTimeoutSeconds: number;
  bootProbeSeconds: number;
  port: number;
  multicastGroup: string;
  secret: string;
  /**
   * Static list of other nodes, as `host` or `host:port`, for networks that
   * drop multicast (many corporate wireless networks, some VPN interfaces).
   * Additive rather than exclusive: coordination messages go to the multicast
   * group AND to every host listed here, so a mixed network where only some
   * links carry multicast still converges. Empty, the default, means
   * multicast only, and this setting does nothing.
   */
  peers: string[];
  /** How often the internal group key is replaced, in hours. */
  keyRotationHours: number;
  /** How long both generations are accepted around a rotation, in minutes. */
  keyRotationGraceMinutes: number;
  /** How often this machine advertises its group on the network, in seconds. */
  beaconSeconds: number;
  /** How often the member list is shared with the group, in seconds. */
  rosterGossipSeconds: number;
  /** How long a removal or revocation is kept on the group's record after every member has it, in minutes. */
  revocationRetentionMinutes: number;
  /** This machine's name in the group's member list; empty uses a slice of its node id. */
  nodeName: string;
}


export const clusterConfigDefaults: { cluster: ClusterConfig } = {
  cluster: {
    // OFF by default, deliberately. See the setting's description: switching
    // it on is the operator asserting that every goodvibes node on this network
    // is theirs, and that assertion is the whole trust boundary.
    enabled: false,
    // A crashed holder is noticed only by its silence, so these two set how long
    // a surface goes unread after a crash: three missed heartbeats. One small
    // datagram per held surface every 5 seconds on the local network.
    heartbeatSeconds: 5,
    masterTimeoutSeconds: 15,
    bootProbeSeconds: 3,
    // Administratively-scoped multicast (RFC 2365, 239.0.0.0/8): a conforming
    // router never forwards it off the local network.
    multicastGroup: '239.255.71.86',
    // IANA Dynamic/Private range, above the Linux ephemeral range so an
    // outbound socket cannot claim it first.
    port: 61860,
    secret: '',
    peers: [],
    keyRotationHours: 24,
    keyRotationGraceMinutes: 5,
    beaconSeconds: 15,
    rosterGossipSeconds: 60,
    revocationRetentionMinutes: 43_200,
    nodeName: '',
  },
};

const clusterSettingRows: ConfigSettingDefinition[] = [
  {
    key: 'cluster.enabled', valueKind: 'opening-switch',
    label: 'Share chat-app work with your other machines',
    type: 'boolean',
    description:
      'Let this machine share inbound channel work with your OTHER goodvibes machines on this network, so exactly one of them reads each inbox (Telegram polling, ntfy subscriptions, inbox pollers) instead of all of them answering the same message. For a homelab where you run goodvibes on several machines that are all yours and configured with the same surfaces: switch it on everywhere and they sort it out between themselves, including taking over at once when one is shut down normally, and within about 20 seconds when one crashes (cluster.masterTimeoutSeconds, 15 by default, plus a short election). Off by default because switching it on asserts that every goodvibes node on this network belongs to you, on a shared network (an office, a shared house) a stranger\'s node would join the same coordination and one of you would stop receiving messages with nothing to indicate why. Outbound sends, sessions and the control plane are unaffected either way.',
  },
  {
    key: 'cluster.heartbeatSeconds',
    label: 'How often the lead machine says it is alive (seconds)',
    type: 'number',
    description:
      'How often the responsible node tells the others it is still alive, in seconds. Lower means slightly faster notice that a node is alive and more network chatter; it does not by itself shorten a crash takeover, which waits for cluster.masterTimeoutSeconds.',
    ...intRange(1, 3_600),
  },
  {
    key: 'cluster.masterTimeoutSeconds',
    label: 'Silence before another machine takes the lead (seconds)',
    type: 'number',
    description:
      'How long a standby node waits without a heartbeat before it decides the responsible node has crashed and holds an election, in seconds. This is the CRASH path only: a node shut down normally hands over immediately, so ordinary restarts never wait this out. Used as at least two heartbeats: a value below that is raised to two heartbeats at runtime.',
    ...intRange(2, 86_400),
  },
  {
    key: 'cluster.bootProbeSeconds',
    label: 'Wait for a lead machine at start (seconds)',
    type: 'number',
    description:
      'How long a starting node listens for an existing responsible node before claiming the role itself, in seconds.',
    ...intRange(1, 300),
  },
  {
    key: 'cluster.port',
    label: 'Port your machines talk on',
    type: 'number',
    description:
      'UDP port used for node-to-node coordination on the local network. Every node that should coordinate must share this port. Change it only to avoid a collision with something else on your network.',
    ...port(),
  },
  {
    key: 'cluster.multicastGroup',
    label: 'Network group your machines talk on',
    type: 'string',
    description:
      'IPv4 multicast group the nodes coordinate over. The default sits in the administratively-scoped range (239.0.0.0/8), which routers do not forward off the local network. Every node that should coordinate must share this value.',
  },
  {
    key: 'cluster.secret',
    label: 'Shared phrase for machines outside a group',
    type: 'string',
    description:
      'Optional shared phrase for coordinating machines that are not in a group (no `cluster create` or `cluster join`). When set, their coordination messages are signed with it and any message that does not verify is ignored, so only nodes that know the phrase can take the responsible role; every such node must use the same value. When it names a stored secret that cannot be read, this machine sends and takes no coordination messages at all until it can (rather than run unsigned), and `cluster status` says election traffic is unavailable. Inside a group it is not used: the group key signs every coordination message.',
  },
  {
    key: 'cluster.keyRotationHours',
    label: 'How often the group key changes (hours)',
    type: 'number',
    description:
      'How often the group replaces the internal key it signs coordination messages with, in hours. This is NOT the join key you type when adding a machine, that one is stable and changes only when you change it. This key rotates by itself, is never shown to you, and rotating it limits how long a copy taken off an old disk or a backup would be accepted. Lower means a shorter window and a little more network traffic once per rotation; the changeover never interrupts anything, because both the new key and the previous one are accepted for a few minutes either side of it.',
    ...intRange(1, 8_760),
  },
  {
    key: 'cluster.keyRotationGraceMinutes',
    label: 'Old group key still accepted for (minutes)',
    type: 'number',
    description:
      'How long both the new and the previous internal group key are accepted around a rotation, in minutes. This exists so that machines which have not yet picked up the new key are still heard while they catch up, without it, a rotation would look like every other machine going silent at once, and the group would needlessly hand work around. Raise it if your machines are often asleep or on a flaky link. It does NOT apply when you remove a machine: that rotation takes effect at once, which is the point of it.',
    ...intRange(1, 120),
  },
  {
    key: 'cluster.beaconSeconds',
    label: 'How often this machine announces its group (seconds)',
    type: 'number',
    description:
      'How often this machine advertises its group on the local network, in seconds. The advertisement carries the group\'s id, its name, how many machines are in it and this build\'s version, and nothing else. It is what lets a new machine running `cluster join` see the group and pick it from a list. Lower means a new machine finds the group faster; higher means slightly less traffic.',
    ...intRange(5, 3_600),
  },
  {
    key: 'cluster.rosterGossipSeconds',
    label: 'How often machines compare shared settings (seconds)',
    type: 'number',
    description:
      'How often this machine tells the others which revision of the group\'s shared settings and of its record (members, removals, key generations, devices, users) it holds, in seconds. A change is sent to every machine when it is made; this is how a machine that missed one (a lost message, or switched off at the time) notices and takes it. Checked on a 30 second timer, so any value below 30 behaves as 30. Higher means a missed change settles more slowly.',
    ...intRange(10, 3_600),
  },
  {
    key: 'cluster.revocationRetentionMinutes',
    label: 'Remember removed items for (minutes)',
    type: 'number',
    description:
      'How long a removed or revoked entry (a deleted schedule, a revoked device token, user, grant or peer) is kept on the group\'s record before it is dropped, in minutes; 43200 (30 days) by default. A machine that has not heard the group for longer than this, or has never synced with the group it is in, takes the group\'s record as the truth when it returns: what the group no longer holds is dropped on that machine, not brought back, unless that machine made it after it last synced, and `cluster status` lists what was dropped. It must span four gossip rounds: at least 4 x cluster.rosterGossipSeconds (counted as 30 when lower), in minutes rounded up, so 4 with the default gossip; a lower value is refused naming the minimum, and one in a hand-edited file is raised to it. Set the same value on every machine.',
    ...intRange(1, 525_600),
  },
  {
    key: 'cluster.nodeName',
    label: "This machine's name in the group",
    type: 'string',
    description:
      'A name for THIS machine in the group\'s member list (`cluster nodes` and the web UI), such as "desktop" or "laptop", so you can tell the machines apart when removing one or reading which machine holds a surface. Up to 48 characters. Empty, the default, shows "machine" and the first 8 characters of its node id; the hostname is never used, because the member list replicates and the group is advertised on the network. Kept on this machine only. Other machines record the name this machine had when it created or joined the group.',
    validate: (v) => typeof v === 'string' && v.trim().length <= 48,
    validationHint: 'up to 48 characters',
  },
];

/**
 * Settings the group runtime resolves once when the daemon starts. A change is
 * saved at once but only takes effect after a restart; the description says so
 * on every surface that shows it.
 */
export const CLUSTER_STARTUP_ONLY_KEYS: ReadonlySet<string> = new Set([
  'cluster.heartbeatSeconds',
  'cluster.masterTimeoutSeconds',
  'cluster.bootProbeSeconds',
  'cluster.port',
  'cluster.multicastGroup',
  'cluster.beaconSeconds',
  'cluster.rosterGossipSeconds',
  'cluster.keyRotationHours',
  'cluster.keyRotationGraceMinutes',
  'cluster.nodeName',
]);

export const CLUSTER_RESTART_NOTE = 'Applies after the daemon restarts.';

export const clusterConfigSettings: ConfigSettingDefinition[] = clusterSettingRows.map(row => (
  CLUSTER_STARTUP_ONLY_KEYS.has(row.key) ? { ...row, description: `${row.description} ${CLUSTER_RESTART_NOTE}` } : row
));
