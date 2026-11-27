/**
 * Devices and network, shared by both terminal apps. There is no `/devices`
 * command: everything it did is a control in the Devices and network place.
 *
 * - What is paired, the relay, the devices waiting to pair, the phones, their
 *   grants and the captures are the daemon's, and are capabilities of the daemon
 *   (platform capabilities/builtin/devices.ts); the live lists their forms
 *   choose from are defined here, by name.
 * - Pairing something new on this program's screen and this program's own
 *   credential for its daemon are session capabilities (platform
 *   capabilities/builtin/devices-session.ts); each program supplies them through
 *   `pairingServices`, from its session capabilities' services.
 */
import type { DevicesClient } from '@goodvibes/engine/platform/platform/runtime/client';
import { formatDeviceLine, type PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import type { DevicesSessionServices, PairHostRequest, PairingAnswer } from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

export interface DeviceTokens {
  /** Where the devices are, for the lines printed ("this machine's daemon"). */
  readonly where: string;
  readonly tokens: readonly PublicPairingToken[];
  readonly sharedRevoked: boolean;
}

export interface RelayCode { readonly id: string; readonly name: string; readonly createdAt: number; readonly lastSeenAt?: number | undefined }

/** A device asking to pair as a node (a browser's Phone node, a peer daemon), as `remote.pair.requests.list` reports it. */
export interface PairRequest {
  readonly id: string;
  readonly label: string;
  /** The node id the device asks to pair as; an existing peer with it is replaced when the device verifies. */
  readonly requestedId: string;
  readonly status: string;
  readonly platform?: string | undefined;
  readonly deviceFamily?: string | undefined;
  readonly capabilities: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** The daemon's devices waiting to pair (`remote.pair.requests.list`), for the list a form chooses from. */
export interface PairRequestsHost<Ctx> {
  readonly list: (ctx: Ctx) => Promise<readonly PairRequest[]>;
}

/** How one app reads what its forms choose from (the paired devices, the relay's devices, the requests, the phones). */
export interface DevicesListsHost<Ctx> {
  readonly tokens: (ctx: Ctx) => Promise<DeviceTokens>;
  readonly devices: (ctx: Ctx) => DevicesClient | undefined;
  readonly relayCodes?: ((ctx: Ctx) => Promise<readonly RelayCode[]>) | undefined;
  readonly pairRequests: PairRequestsHost<Ctx>;
}

let hostOf: DevicesListsHost<unknown> | undefined;
function host(): DevicesListsHost<unknown> {
  if (!hostOf) throw commandRefusal('The device lists are not wired in this program.');
  return hostOf;
}
function requireDevices(ctx: unknown): DevicesClient {
  const devices = host().devices(ctx);
  if (!devices) throw commandRefusal('Paired phones are served by the daemon, and this runtime has no daemon connection.', 'Start the daemon and try again', 'DAEMON_UNAVAILABLE');
  return devices;
}

const when = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/** "Linux, phone · offers camera, location · pairs as node-1 · asked 2026-11-20 09:15". */
function pairRequestDetail(request: PairRequest): string {
  return [
    [request.platform, request.deviceFamily].filter(Boolean).join(', '),
    request.capabilities.length > 0 ? `offers ${request.capabilities.join(', ')}` : 'offers nothing yet',
    `pairs as ${request.requestedId}`,
    `asked ${when(request.createdAt)}`,
  ].filter(Boolean).join(' · ');
}

// The live lists the daemon's devices capabilities choose from (their inputs name them: devices.tokens, ...).
defineList<unknown>({
  name: 'devices.tokens',
  async read(ctx) {
    return (await host().tokens(ctx)).tokens.map((token): ListRow => ({ value: token.id, label: token.name, detail: formatDeviceLine(token) }));
  },
  operator: { method: 'pairing.tokens.list', input: {}, rows: { from: 'tokens', value: 'id', label: 'name' } },
});
defineList<unknown>({
  name: 'devices.relay-codes',
  async read(ctx) {
    const codes = host().relayCodes;
    return codes ? (await codes(ctx)).map((code): ListRow => ({ value: code.id, label: code.name, detail: code.lastSeenAt ? `last used ${when(code.lastSeenAt)}` : 'not used yet' })) : [];
  },
  operator: { method: 'relay.codes.list', input: {}, rows: { from: 'codes', value: 'id', label: 'name' } },
});
defineList<unknown>({
  name: 'devices.pair-requests',
  async read(ctx) {
    return (await host().pairRequests.list(ctx)).filter((request) => request.status === 'pending').map((request): ListRow => ({
      value: request.id, label: request.label, detail: pairRequestDetail(request),
    }));
  },
  operator: { method: 'remote.pair.requests.list', input: {}, rows: { from: 'requests', value: 'id', label: 'label', detail: 'requestedId' } },
});
defineList<unknown>({
  name: 'devices.grants',
  async read(ctx) {
    return (await requireDevices(ctx).listGrants()).map((grant): ListRow => ({
      value: grant.grantId, label: `${grant.capabilityTitle ?? grant.capabilityId ?? '?'} on ${grant.nodeId ?? '?'}`, detail: `used ${grant.useCount ?? 0}x`,
    }));
  },
  operator: { method: 'devices.grants.list', input: {}, rows: { from: 'grants', value: 'grantId', label: 'capabilityTitle', detail: 'nodeId' } },
});
defineList<unknown>({
  name: 'devices.captures',
  async read(ctx) {
    return (await requireDevices(ctx).listArtifacts()).artifacts.map((artifact): ListRow => ({
      value: artifact.artifactId, label: `${String(artifact.capabilityId ?? '?')} from ${String(artifact.nodeId ?? '?')}`,
    }));
  },
  operator: { method: 'devices.artifacts.list', input: {}, rows: { from: 'artifacts', value: 'artifactId', label: 'capabilityId', detail: 'nodeId' } },
});

/** Give the device lists this app's readers (once, at command registration). */
export function wireDevicesLists<Ctx>(devicesHost: DevicesListsHost<Ctx>, binding?: DaemonCapabilityBinding<Ctx>): void {
  hostOf = devicesHost as unknown as DevicesListsHost<unknown>;
  bindingOf = binding as unknown as DaemonCapabilityBinding<unknown> | undefined;
}

let bindingOf: DaemonCapabilityBinding<unknown> | undefined;

// The settings whose pulled value disagrees (settings-sync.resolve chooses from it): the daemon's capability, both owners.
defineList<unknown>({
  name: 'settings-sync.conflicts',
  async read(ctx) {
    if (!bindingOf) throw commandRefusal('The settings that disagree are read from the daemon, which this program cannot reach here.');
    const answer = await runDaemonCapability('settings-sync.conflicts', {}, ctx as CommandActionContext, bindingOf as DaemonCapabilityBinding<CommandActionContext>);
    const conflicts = Array.isArray(answer.data?.conflicts) ? answer.data.conflicts as { key?: unknown; owner?: unknown }[] : [];
    return conflicts.filter((conflict) => typeof conflict.key === 'string').map((conflict): ListRow => ({ value: String(conflict.key), label: String(conflict.key), detail: `${String(conflict.owner)}'s setting` }));
  },
  operator: { method: 'capabilities.run', input: { id: 'settings-sync.conflicts' }, rows: { from: 'data.conflicts', value: 'key', label: 'key', detail: 'owner' } },
});

// The shared settings that differ between this machine and the group, each with both values (cluster.publish and
// cluster.accept choose from it, filtered by typing): the daemon's capability, read from the daemon the screen talks to.
defineList<unknown>({
  name: 'cluster.setting-differences',
  async read(ctx) {
    if (!bindingOf) throw commandRefusal('The settings that differ from the group\'s are read from the daemon, which this program cannot reach here.');
    const answer = await runDaemonCapability('cluster.differences', {}, ctx as CommandActionContext, bindingOf as DaemonCapabilityBinding<CommandActionContext>);
    const settings = Array.isArray(answer.data?.settings) ? answer.data.settings as { path?: unknown; shown?: unknown }[] : [];
    return settings.filter((setting) => typeof setting.path === 'string').map((setting): ListRow => ({ value: String(setting.path), label: String(setting.path), detail: typeof setting.shown === 'string' ? setting.shown : '' }));
  },
  operator: { method: 'capabilities.run', input: { id: 'cluster.differences' }, rows: { from: 'data.settings', value: 'path', label: 'path', detail: 'shown' } },
});

/** How one app pairs on its own screen and keeps its own credential for its daemon (each piece it has). */
export interface DevicesPairingHost<Ctx> {
  /** A phone's or another device's pairing: its words, and its link and QR code as the answer's one-time `reveal` (never in the words). */
  readonly pairDevice: (ctx: Ctx, name: string) => Promise<string | void | PairingAnswer>;
  readonly pairHost?: ((ctx: Ctx, request: PairHostRequest) => Promise<string | void>) | undefined;
  readonly pairRelay?: ((ctx: Ctx, name: string) => Promise<string | PairingAnswer>) | undefined;
  readonly pairChannel?: ((ctx: Ctx, channel: string) => Promise<string | void>) | undefined;
  readonly hostStatus?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly unpairHost?: ((ctx: Ctx) => Promise<string>) | undefined;
}

/** The session capabilities' pairing services (builtin/devices-session.ts) for this context, from the app's host. */
export function pairingServices<Ctx>(pairing: DevicesPairingHost<Ctx>, ctx: Ctx): NonNullable<DevicesSessionServices['pairing']> {
  const { pairHost, pairRelay, pairChannel, hostStatus, unpairHost } = pairing;
  return {
    pairDevice: (name) => pairing.pairDevice(ctx, name),
    ...(pairHost ? { pairHost: (request: PairHostRequest) => pairHost(ctx, request) } : {}),
    ...(pairRelay ? { pairRelay: (name: string) => pairRelay(ctx, name) } : {}),
    ...(pairChannel ? { pairChannel: (channel: string) => pairChannel(ctx, channel) } : {}),
    ...(hostStatus ? { hostStatus: () => hostStatus(ctx) } : {}),
    ...(unpairHost ? { unpairHost: () => unpairHost(ctx) } : {}),
  };
}
