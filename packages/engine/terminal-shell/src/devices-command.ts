/**
 * `/devices`, described once (command-actions/) for both terminal apps: what
 * is paired with the daemon and how to pair something new. "Pair something"
 * is the one pairing action; it asks what to pair (a phone or other device by
 * QR code, this terminal with its daemon, a device through the relay, or a
 * chat channel). The rest lists and revokes what was paired: device tokens,
 * relay codes, the devices waiting to pair as nodes (approved or rejected
 * here), the phones paired as device nodes with their always-allow grants and
 * the captures the daemon keeps. Each app says how it reaches the
 * daemon; an action only one app can do is refused in the other with why.
 */
import type { DevicesClient } from '@goodvibes/engine/platform/platform/runtime/client';
import { formatDeviceLine, resolveTokenByIdPrefix, type PublicPairingToken } from '@goodvibes/engine/platform/platform/pairing';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, InputDescription, ListName } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';
import { runDeviceCapabilitySubcommand } from './device-capabilities-command.js';

export interface DeviceTokens {
  /** Where the devices are, for the lines printed ("this machine's daemon"). */
  readonly where: string;
  readonly tokens: readonly PublicPairingToken[];
  readonly sharedRevoked: boolean;
}

export interface RelayCode { readonly id: string; readonly name: string; readonly createdAt: number; readonly lastSeenAt?: number | undefined }
export interface HostPairingRequest { readonly name: string; readonly bootstrapShared: boolean; readonly apply: boolean }

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

/**
 * The daemon's pair requests, through `remote.pair.requests.*`. A refusal keeps
 * the daemon's code (`readRefusal(error).code`), so a request that would replace
 * a paired device (`REMOTE_PAIR_REPLACES_PEER`) is told apart from any other.
 */
export interface PairRequestsHost<Ctx> {
  readonly list: (ctx: Ctx) => Promise<readonly PairRequest[]>;
  readonly approve: (ctx: Ctx, id: string, confirmReplace: boolean) => Promise<PairRequest>;
  readonly reject: (ctx: Ctx, id: string) => Promise<PairRequest>;
}

/** How one app reaches what is paired. A missing reader refuses its action with the reason for that app. */
export interface DevicesHost<Ctx> {
  readonly tokens: (ctx: Ctx) => Promise<DeviceTokens>;
  readonly rename: (ctx: Ctx, id: string, name: string) => Promise<boolean>;
  readonly revoke: (ctx: Ctx, id: string) => Promise<boolean>;
  readonly devices: (ctx: Ctx) => DevicesClient | undefined;
  /** Pair a phone or another device: a QR code of a pairing offer. */
  readonly pairDevice: (ctx: Ctx, name: string) => Promise<string | void>;
  readonly pairHost?: ((ctx: Ctx, request: HostPairingRequest) => Promise<string | void>) | undefined;
  readonly hostStatus?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly unpairHost?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly pairRelay?: ((ctx: Ctx, name: string) => Promise<string>) | undefined;
  readonly relayStatus?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly relayCodes?: ((ctx: Ctx) => Promise<readonly RelayCode[]>) | undefined;
  readonly revokeRelayCode?: ((ctx: Ctx, id: string) => Promise<string>) | undefined;
  readonly pairChannel?: ((ctx: Ctx, channel: string) => Promise<string | void>) | undefined;
  readonly migrateShared?: ((ctx: Ctx, name: string) => Promise<string>) | undefined;
  readonly revokeShared?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly pairRequests: PairRequestsHost<Ctx>;
}

const TERMINAL_ONLY = 'the terminal app holds this (its own host credential, the relay and channel setup); run it in goodvibes';

function missing(what: string, where: string): never {
  throw commandRefusal(`${what} is not available in this program: ${where}.`);
}

let hostOf: DevicesHost<unknown> | undefined;
function host(): DevicesHost<unknown> {
  if (!hostOf) throw commandRefusal('/devices is not wired in this program.');
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

const PAIR_REQUEST_REPLACES_PEER = 'REMOTE_PAIR_REPLACES_PEER';

const TOKENS = defineList<unknown>({
  name: 'devices.tokens',
  async read(ctx) {
    return (await host().tokens(ctx)).tokens.map((token): ListRow => ({ value: token.id, label: token.name, detail: formatDeviceLine(token) }));
  },
  operator: { method: 'pairing.tokens.list', input: {}, rows: { from: 'tokens', value: 'id', label: 'name' } },
});
const RELAY_CODES = defineList<unknown>({
  name: 'devices.relay-codes',
  async read(ctx) {
    const codes = host().relayCodes;
    return codes ? (await codes(ctx)).map((code): ListRow => ({ value: code.id, label: code.name, detail: code.lastSeenAt ? `last used ${when(code.lastSeenAt)}` : 'not used yet' })) : [];
  },
  operator: { method: 'relay.codes.list', input: {}, rows: { from: 'codes', value: 'id', label: 'name' } },
});
const PAIR_REQUESTS = defineList<unknown>({
  name: 'devices.pair-requests',
  async read(ctx) {
    return (await host().pairRequests.list(ctx)).filter((request) => request.status === 'pending').map((request): ListRow => ({
      value: request.id, label: request.label, detail: pairRequestDetail(request),
    }));
  },
  operator: { method: 'remote.pair.requests.list', input: {}, rows: { from: 'requests', value: 'id', label: 'label', detail: 'requestedId' } },
});
const GRANTS = defineList<unknown>({
  name: 'devices.grants',
  async read(ctx) {
    return (await requireDevices(ctx).listGrants()).map((grant): ListRow => ({
      value: grant.grantId, label: `${grant.capabilityTitle ?? grant.capabilityId ?? '?'} on ${grant.nodeId ?? '?'}`, detail: `used ${grant.useCount ?? 0}x`,
    }));
  },
  operator: { method: 'devices.grants.list', input: {}, rows: { from: 'grants', value: 'grantId', label: 'capabilityTitle', detail: 'nodeId' } },
});
const CAPTURES = defineList<unknown>({
  name: 'devices.captures',
  async read(ctx) {
    return (await requireDevices(ctx).listArtifacts()).artifacts.map((artifact): ListRow => ({
      value: artifact.artifactId, label: `${String(artifact.capabilityId ?? '?')} from ${String(artifact.nodeId ?? '?')}`,
    }));
  },
  operator: { method: 'devices.artifacts.list', input: {}, rows: { from: 'artifacts', value: 'artifactId', label: 'capabilityId', detail: 'nodeId' } },
});

const DEVICE: InputDescription = listInput({ id: 'device', label: 'Device', help: 'Your paired devices', list: TOKENS, other: 'a device id or the start of one' });

async function resolveDevice(ctx: unknown, idOrPrefix: string): Promise<{ readonly token: PublicPairingToken; readonly where: string }> {
  const { tokens, where } = await host().tokens(ctx);
  const resolved = resolveTokenByIdPrefix(tokens, idOrPrefix);
  if (!resolved.ok) {
    throw resolved.reason === 'ambiguous'
      ? commandRefusal(`Ambiguous device id "${idOrPrefix}": use more characters.`, '/devices list shows each device id', 'AMBIGUOUS')
      : commandRefusal(`No device matches "${idOrPrefix}".`, '/devices list shows each device id', 'NOT_FOUND');
  }
  return { token: resolved.token, where };
}

async function capability(ctx: unknown, words: readonly string[]): Promise<string> {
  const printed: string[] = [];
  await runDeviceCapabilitySubcommand(words, requireDevices(ctx), (message) => printed.push(message.replace(/^\[devices\] /, '')));
  return printed.join('\n');
}

/** Register `/devices` with how this app reaches what is paired; `channels` is the live list of channels (from /channels). */
export function registerDevicesCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, devicesHost: DevicesHost<Ctx>, channels: ListName): void {
  hostOf = devicesHost as unknown as DevicesHost<unknown>;
  const h = devicesHost;
  const actions: ActionDescription<Ctx>[] = [
    readAction<Ctx>({
      id: 'list', label: 'See your paired devices', word: 'list',
      sentence: 'Lists each paired device with when it was paired and last seen, and whether the old shared token still works.',
      operator: { method: 'pairing.tokens.list', fields: {} },
      async run(_values, ctx) {
        const { where, tokens, sharedRevoked } = await h.tokens(ctx);
        return [
          `Paired devices on ${where}:`,
          ...(tokens.length === 0 ? ['  (none yet: /devices pair pairs one)'] : tokens.map((token) => `  ${formatDeviceLine(token)}`)),
          '',
          sharedRevoked
            ? 'Shared token: revoked and replaced; only the apps on this machine hold it.'
            : 'Shared token: active, also held by devices paired before per-device tokens; /devices migrate-shared then /devices revoke-shared retire their copies.',
        ].join('\n');
      },
    }),
    {
      id: 'pair', label: 'Pair something', word: 'pair',
      inputs: [
        { id: 'what', label: 'What to pair', help: 'A phone or another device, this terminal with its daemon, a device through the relay, or a chat channel', kind: 'choice',
          choices: [
            { value: 'device', label: 'A phone or another device', help: 'Shows a QR code; the device gets its own token' },
            { value: 'host', label: 'This terminal with its daemon', help: 'For a daemon on another machine; asks you to confirm in this terminal' },
            { value: 'relay', label: 'A device through the relay', help: 'Reaches the daemon from outside your network' },
            { value: 'channel', label: 'A chat channel', help: 'Slack, Telegram, Discord, ...: asks for its keys, then switches it on' },
          ],
          required: true, typed: { position: 1 }, step: 1 },
        { ...listInput({ id: 'channel', label: 'Channel', help: 'The channel to set up', list: channels, position: 2, other: 'a channel kind (slack, telegram, discord, ntfy, webhook, ...)' }), showWhen: { input: 'what', is: 'channel' }, step: 2 },
        textInput({ id: 'name', label: 'Name', help: 'What to call it in the device list', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'a name chosen for it' }, step: 2 }),
        { id: 'shared', label: 'Shared token', help: 'Pair with the daemon\'s shared token first (bootstrap), for a daemon that has no device token for this terminal yet', kind: 'choice',
          choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, start from the shared token' }],
          required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--bootstrap-shared', switchOn: 'yes' }, showWhen: { input: 'what', is: 'host' }, step: 2 },
        { id: 'apply', label: 'Apply', help: 'Review and confirm the pairing now, rather than only see what it would do', kind: 'choice',
          choices: [{ value: 'no', label: 'Only show what it would do' }, { value: 'yes', label: 'Review and confirm it' }],
          required: { default: 'no', defaultMeans: 'only show what it would do' }, typed: { flag: '--apply', switchOn: 'yes' }, showWhen: { input: 'what', is: 'host' }, step: 2 },
      ],
      stepTitles: ['What do you want to pair?', 'Which one, and what to call it'],
      sentence: 'The {what} you chose is paired and may reach the daemon, until you change it.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'revoke',
      ownerOnly: { reason: 'pairing gives something new access to the daemon', instead: '/devices list shows what is paired' },
      operator: { terminalOnly: 'pairing shows a code or asks for keys in the terminal; the web UI pairs a device from its own Devices page' },
      example: { what: 'device' },
      async run(values, ctx) {
        const name = values.name ?? '';
        if (values.what === 'device') return await h.pairDevice(ctx, name);
        if (values.what === 'host') {
          return h.pairHost ? await h.pairHost(ctx, { name, bootstrapShared: values.shared === 'yes', apply: values.apply === 'yes' }) : missing('Pairing this terminal with its daemon', 'pair with the connected host through /setup pair');
        }
        if (values.what === 'relay') return h.pairRelay ? await h.pairRelay(ctx, name) : missing('Pairing through the relay', TERMINAL_ONLY);
        if (!values.channel) throw commandRefusal('Name the channel to pair.', '/devices pair channel <channel>');
        return h.pairChannel ? await h.pairChannel(ctx, values.channel) : missing('Setting up a channel', 'the Agent sets channels up with /channels guide and its workspace');
      },
    },
    {
      id: 'rename', label: 'Rename a device', word: 'rename',
      inputs: [DEVICE, textInput({ id: 'name', label: 'New name', help: 'What to call it', why: 'a name you choose', typed: { tail: true } })],
      sentence: '{device} is called {name} in the device list, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none',
      operator: { method: 'pairing.tokens.rename', fields: { id: 'device', name: 'name' } },
      example: { device: 'a1b2c3', name: 'Work phone' },
      async run(values, ctx) {
        const { token, where } = await resolveDevice(ctx, values.device!);
        if (!await h.rename(ctx, token.id, values.name!)) throw commandRefusal(`No device matches "${values.device}" any more (it was revoked elsewhere); nothing was renamed.`, '/devices list shows each device id', 'NOT_FOUND');
        return `Renamed device to "${values.name}" on ${where}.`;
      },
    },
    {
      id: 'revoke', label: 'Revoke a device', word: 'revoke', inputs: [DEVICE],
      sentence: '{device} stops reaching the daemon at once and has to pair again for a new token.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'pairing.tokens.delete', fields: { id: 'device' } },
      example: { device: 'a1b2c3' },
      async run(values, ctx) {
        const { token, where } = await resolveDevice(ctx, values.device!);
        return await h.revoke(ctx, token.id) ? `Revoked "${token.name}" on ${where}: its token stops working immediately.` : `Device "${token.name}" was already gone.`;
      },
    },
    {
      id: 'migrate-shared', label: 'Give an old device its own token', word: 'migrate-shared',
      inputs: [textInput({ id: 'name', label: 'Name', help: 'What to call the device', why: 'a name you choose', typed: { tail: true }, optional: { default: '', means: 'migrated device' } })],
      sentence: 'A new token of its own is made for a device that still uses the shared token, kept until you change it; it is shown once in the Paired Devices view.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it makes a token that gives a device access', instead: '/devices list shows what is paired' },
      operator: { method: 'pairing.tokens.migrate', fields: { name: 'name' } },
      example: { name: 'Old tablet' },
      async run(values, ctx) { return h.migrateShared ? await h.migrateShared(ctx, values.name || 'migrated device') : missing('Migrating the shared token', 'its one-time token is shown in the terminal app\'s Paired Devices view; run it in goodvibes'); },
    },
    {
      id: 'revoke-shared', label: 'Retire the shared token', word: 'revoke-shared',
      sentence: 'Every device still using the shared token is signed out and has to pair again; the apps on this machine get its replacement.', done: '',
      inputs: [], touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'pairing.tokens.revokeShared', fields: {} },
      example: {},
      async run(_values, ctx) { return h.revokeShared ? await h.revokeShared(ctx) : missing('Retiring the shared token', TERMINAL_ONLY); },
    },
    readAction<Ctx>({
      id: 'host-status', label: 'See how this terminal reaches its daemon', word: 'host-status',
      sentence: 'Shows whether this terminal holds a device pairing for its daemon, or uses this machine\'s operator token.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) { return h.hostStatus ? await h.hostStatus(ctx) : missing('This terminal\'s host pairing', '/setup pair shows how this program reaches its connected host'); },
    }),
    {
      id: 'unpair-host', label: 'Forget this terminal\'s daemon pairing', word: 'unpair-host',
      sentence: 'This terminal forgets its host credential and cannot reach that daemon until you pair it again, until you change it.', done: '',
      inputs: [], touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'pair',
      ownerOnly: { reason: 'it cuts this terminal off from its daemon', instead: '/devices host-status shows how this terminal reaches its daemon' },
      operator: { terminalOnly: TERMINAL_ONLY },
      example: {},
      async run(_values, ctx) { return h.unpairHost ? await h.unpairHost(ctx) : missing('Forgetting the host pairing', 'forget the connected host\'s credential with /setup unpair'); },
    },
    readAction<Ctx>({
      id: 'relay-status', label: 'See whether the relay is reachable', word: 'relay-status',
      sentence: 'Shows whether the relay is on, the daemon\'s live registration with it, and what the relay refused if it did.',
      operator: { method: 'relay.reachability.get', fields: {} },
      async run(_values, ctx) { return h.relayStatus ? await h.relayStatus(ctx) : missing('The relay status', TERMINAL_ONLY); },
    }),
    readAction<Ctx>({
      id: 'relay-codes', label: 'See devices paired through the relay', word: 'relay-codes',
      sentence: 'Lists each relay code, one per device paired through the relay, with when it was last used.',
      operator: { method: 'relay.codes.list', fields: {} },
      async run(_values, ctx) {
        if (!h.relayCodes) return missing('Relay codes', TERMINAL_ONLY);
        const codes = await h.relayCodes(ctx);
        if (codes.length === 0) return 'No device is paired through the relay. /devices pair relay pairs one.';
        return [`Relay codes (${codes.length}), one per device paired through the relay:`,
          ...codes.map((code) => `  ${code.id}  ${code.name}  created ${when(code.createdAt)}  ${code.lastSeenAt ? `last used ${when(code.lastSeenAt)}` : 'not used yet'}`)].join('\n');
      },
    }),
    {
      id: 'relay-revoke', label: 'Cut a device off the relay', word: 'relay-revoke',
      inputs: [listInput({ id: 'code', label: 'Relay code', help: 'The devices paired through the relay', list: RELAY_CODES })],
      sentence: 'The device paired with {code} is refused at its next request through the relay; every other device keeps working.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'relay.codes.revoke', fields: { id: 'code' } },
      example: { code: 'rc-1' },
      async run(values, ctx) { return h.revokeRelayCode ? await h.revokeRelayCode(ctx, values.code!) : missing('Revoking a relay code', TERMINAL_ONLY); },
    },
    readAction<Ctx>({
      id: 'requests', label: 'See devices waiting to pair', word: 'requests',
      sentence: 'Lists each device that asked to pair as a node (a browser\'s Phone node, a peer daemon) and waits for your approval, with what it offers and the node id it pairs as.',
      operator: { method: 'remote.pair.requests.list', fields: {} },
      async run(_values, ctx) {
        const pending = (await h.pairRequests.list(ctx)).filter((request) => request.status === 'pending');
        if (pending.length === 0) return 'No device is waiting to pair. A device asks from its own screen (the web UI\'s phone node page: Pair this phone).';
        return [`Waiting to pair (${pending.length}); approve one only if you recognise it, then press Finish pairing on it:`,
          ...pending.map((request) => `  ${request.id}  ${request.label}  ${pairRequestDetail(request)}  expires ${when(request.expiresAt)}`)].join('\n');
      },
    }),
    {
      id: 'approve', label: 'Approve a device waiting to pair', word: 'approve',
      inputs: [
        listInput({ id: 'request', label: 'Request', help: 'The devices waiting to pair', list: PAIR_REQUESTS }),
        { id: 'replace', label: 'Replace', help: 'The request names a device already paired: approve it as that same device pairing again, which ends the old pairing', kind: 'choice',
          choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, it is the same device pairing again' }],
          required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--replace', switchOn: 'yes' } },
      ],
      sentence: 'The device that sent {request} may finish pairing and then reach the daemon as a node, until you revoke it.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'approving gives a device access to the daemon', instead: '/devices requests shows the devices waiting to pair' },
      operator: { method: 'remote.pair.requests.approve', fields: { requestId: 'request' } },
      example: { request: 'pair-1' },
      async run(values, ctx) {
        const id = values.request!;
        try {
          const approved = await h.pairRequests.approve(ctx, id, values.replace === 'yes');
          return `Approved "${approved.label}". Press Finish pairing on that device to complete it.`;
        } catch (error) {
          if (readRefusal(error)?.code !== PAIR_REQUEST_REPLACES_PEER) throw error;
          throw commandRefusal(`Request ${id} names a device that is already paired; approving it replaces that device's pairing. Nothing was approved.`,
            `/devices approve ${id} --replace, only if it is that same device pairing again`, PAIR_REQUEST_REPLACES_PEER);
        }
      },
    },
    {
      id: 'reject', label: 'Reject a device waiting to pair', word: 'reject',
      inputs: [listInput({ id: 'request', label: 'Request', help: 'The devices waiting to pair', list: PAIR_REQUESTS })],
      sentence: 'The device that sent {request} is not paired and has to ask again.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'answering a pairing request is the owner\'s own act', instead: '/devices requests shows the devices waiting to pair' },
      operator: { method: 'remote.pair.requests.reject', fields: { requestId: 'request' } },
      example: { request: 'pair-1' },
      async run(values, ctx) {
        const rejected = await h.pairRequests.reject(ctx, values.request!);
        return `Rejected "${rejected.label}"; it has to ask again to pair.`;
      },
    },
    readAction<Ctx>({
      id: 'nodes', label: 'See phones paired as device nodes', word: 'nodes',
      sentence: 'Lists each phone paired as a device node and what it can serve.',
      operator: { method: 'devices.nodes.list', fields: {} },
      async run(_values, ctx) { return await capability(ctx, ['nodes']); },
    }),
    readAction<Ctx>({
      id: 'grants', label: 'See always-allow grants', word: 'grants',
      sentence: 'Lists the "always allow" answers given to phone capabilities, with how often each was used.',
      operator: { method: 'devices.grants.list', fields: {} },
      async run(_values, ctx) { return await capability(ctx, ['grants']); },
    }),
    {
      id: 'revoke-grant', label: 'Revoke an always-allow grant', word: 'revoke-grant',
      inputs: [listInput({ id: 'grant', label: 'Grant', help: 'The always-allow grants', list: GRANTS })],
      sentence: 'The "always allow" answer {grant} is removed; the next request for that capability asks you again, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none',
      operator: { method: 'devices.grants.revoke', fields: { grantId: 'grant' } },
      example: { grant: 'g-1' },
      async run(values, ctx) { return await capability(ctx, ['revoke-grant', values.grant!]); },
    },
    readAction<Ctx>({
      id: 'captures', label: 'See captures the daemon keeps', word: 'captures',
      sentence: 'Lists the photos and screen captures the daemon is keeping, and when each is deleted.',
      operator: { method: 'devices.artifacts.list', fields: {} },
      async run(_values, ctx) { return await capability(ctx, ['captures']); },
    }),
    {
      id: 'delete-capture', label: 'Delete a capture now', word: 'delete-capture',
      inputs: [listInput({ id: 'capture', label: 'Capture', help: 'The captures the daemon keeps', list: CAPTURES })],
      sentence: 'The capture {capture} and its record are removed from the daemon host now.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'devices.artifacts.delete', fields: { artifactId: 'capture' } },
      example: { capture: 'art-1' },
      async run(values, ctx) { return await capability(ctx, ['delete-capture', values.capture!]); },
    },
  ];
  registry.register(defineCommand<Ctx>({
    name: 'devices',
    title: 'Paired devices',
    summary: 'Pair a device, this terminal, a relay device or a chat channel, and see and revoke what is paired',
    group: 'Devices',
    report: 'list',
    firstScreenRows: [
      'list', 'pair', 'rename', 'revoke',
      { label: 'Phones as device nodes…', actions: ['requests', 'approve', 'reject', 'nodes', 'grants', 'revoke-grant', 'captures', 'delete-capture'] },
      { label: 'The relay…', actions: ['relay-status', 'relay-codes', 'relay-revoke'] },
      { label: 'This terminal and the shared token…', actions: ['host-status', 'unpair-host', 'migrate-shared', 'revoke-shared'] },
    ],
    actions,
  }));
}
