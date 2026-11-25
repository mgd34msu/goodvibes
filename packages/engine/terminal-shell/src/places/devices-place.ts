/**
 * devices-place.ts, the Devices and network place: what is paired with the
 * daemon and how other machines reach it.
 *
 * Every list is the daemon's own and read from it: the paired devices and the
 * old shared token (`pairing.tokens.list`), the devices waiting to pair as
 * nodes (`remote.pair.requests.list`), the phones paired as device nodes
 * (`devices.nodes.list`), their always-allow grants (`devices.grants.list`),
 * the captures the daemon keeps (`devices.artifacts.list`), the devices paired
 * through the relay (`relay.codes.list`), this machine's group with your other
 * machines, the machines in it and the groups announced nearby (the group
 * capabilities), and the Cloudflare integration (`cloudflare.status`). Every
 * action is a capability on the item it acts on; pairing something new keeps
 * its own screen (the QR code and the other ways to sign in), and the Secure
 * address screen in Settings opens from here as it is.
 */
import { definePlace, type PlaceItem } from './place-types.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const list = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object') : [];
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Names and reasons another device or machine chose, without control characters. */
const plain = (value: unknown): string => text(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
const when = (at: number | undefined): string => at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : 'never';
/** A capability's answer, as `capabilities.run` gives it: its `data`. */
const dataOf = (output: unknown): Record<string, unknown> => record(record(output).data);

interface DeviceItem extends PlaceItem {
  readonly state: 'paired' | 'agent' | 'shared-active' | 'shared-retired';
  readonly name: string;
  readonly createdAt?: number | undefined;
  readonly lastSeenAt?: number | undefined;
  readonly owner?: boolean | undefined;
  readonly scopes: readonly string[];
}
interface RequestItem extends PlaceItem { readonly state: 'pending'; readonly label: string; readonly requestedId: string; readonly about: string; readonly offers: readonly string[]; readonly createdAt?: number | undefined; readonly expiresAt?: number | undefined }
interface PhoneItem extends PlaceItem { readonly state: 'ready' | 'out-of-date'; readonly label: string; readonly kind: string; readonly platform: string; readonly supported: readonly string[]; readonly gated: readonly string[] }
interface GrantItem extends PlaceItem { readonly state: 'allowed'; readonly what: string; readonly node: string; readonly grantedAt?: number | undefined; readonly expiresAt?: number | undefined; readonly lastUsedAt?: number | undefined; readonly uses: number }
interface CaptureItem extends PlaceItem { readonly state: 'kept'; readonly what: string; readonly node: string; readonly capturedAt?: number | undefined; readonly expiresAt?: number | undefined; readonly bytes: number; readonly reason: string }
interface RelayItem extends PlaceItem { readonly state: 'paired'; readonly name: string; readonly createdAt?: number | undefined; readonly lastSeenAt?: number | undefined }
interface GroupItem extends PlaceItem { readonly state: 'no-group' | 'member' | 'unreadable'; readonly name: string; readonly machine: string; readonly members: number; readonly keyGeneration?: number | undefined; readonly awaitingSync: boolean }
interface MachineItem extends PlaceItem { readonly state: 'member' | 'this-machine'; readonly name: string; readonly lastSeenAt?: number | undefined; readonly heard: boolean }
interface NearbyItem extends PlaceItem { readonly state: 'announced'; readonly name: string; readonly machines: number; readonly lastSeenAt?: number | undefined }
interface CloudflareItem extends PlaceItem { readonly state: 'on' | 'off'; readonly ready: boolean; readonly deployed: readonly string[]; readonly warnings: readonly string[] }

/** The network-scan decision (one item), then each model server the daemon's scans kept. */
interface ScanItem extends PlaceItem { readonly state: 'on' | 'off' | 'unreadable' | 'server'; readonly name: string; readonly detail: string; readonly network: boolean; readonly models: number }

/** Settings sync: one row for your settings as a whole (export, pull, review), then each setting that disagrees. */
interface SyncItem extends PlaceItem { readonly state: 'settings' | 'conflict'; readonly name: string; readonly owner: string; readonly from: string }

type Item = DeviceItem | RequestItem | PhoneItem | GrantItem | CaptureItem | RelayItem | GroupItem | MachineItem | NearbyItem | CloudflareItem | ScanItem | SyncItem | SettingItem;

/** One setting shown where the thing it sets is (the Cloudflare tab's, the addresses phones use, the phones'). */
interface SettingItem extends PlaceItem { readonly state: 'setting'; readonly value: string }

/** The daemon's settings (`config.get`), flat by key whether the answer is flat or nested. */
function flatSettings(output: unknown): ReadonlyMap<string, unknown> {
  const flat = new Map<string, unknown>();
  const walk = (node: unknown, prefix: string): void => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, prefix ? `${prefix}.${key}` : key);
    } else if (prefix) flat.set(prefix, node);
  };
  const body = record(output);
  walk(body.config ?? body.settings ?? body, '');
  return flat;
}

/** The settings a tab shows, by key or key prefix, each with its value as words (never a secret: these hold references). */
function settingsOf(match: (key: string) => boolean) {
  return (output: unknown): readonly SettingItem[] => [...flatSettings(output)].filter(([key]) => match(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]): SettingItem => ({
    id: key, state: 'setting',
    value: value === undefined || value === null || value === '' ? 'not set' : typeof value === 'string' ? plain(value) : plain(JSON.stringify(value)),
  }));
}
const ADDRESS_KEYS = /^(controlPlane|httpListener|web)\.(hostMode|host|port|trustProxy|trustCloudflare)$/;
const settingRow = (item: PlaceItem) => ({ title: item.id, right: (item as SettingItem).value.slice(0, 24) });
const settingDetail = (item: PlaceItem) => [{ label: 'Value', text: (item as SettingItem).value }, { text: 'Change it here; Settings shows what it does.', tone: 'muted' as const }];

const OWNER_WORDS: Readonly<Record<string, string>> = { daemon: 'the daemon\'s', tui: 'the terminal app\'s', agent: 'the Agent\'s' };

function settingsSync(output: unknown): readonly SyncItem[] {
  const conflicts = list(dataOf(output).conflicts).filter((conflict) => text(conflict.key)).map((conflict): SyncItem => ({
    id: text(conflict.key), state: 'conflict', name: plain(conflict.key), owner: OWNER_WORDS[text(conflict.owner)] ?? plain(conflict.owner), from: plain(conflict.path),
  }));
  return [{ id: 'your-settings', state: 'settings', name: 'Your settings', owner: '', from: '' }, ...conflicts];
}

/** The old shared token, as an item of the device list: the one thing that retires it. */
const SHARED_TOKEN_ID = 'shared-token';

function devices(output: unknown): readonly DeviceItem[] {
  const body = record(output);
  const tokens = list(body.tokens).filter((token) => text(token.id)).map((token): DeviceItem => ({
    id: text(token.id),
    state: token.client === 'agent' ? 'agent' : 'paired',
    name: plain(token.name) || text(token.id),
    createdAt: time(token.createdAt),
    lastSeenAt: time(token.lastSeenAt),
    owner: token.origin === 'owner-pairing',
    scopes: strings(token.scopes),
  }));
  const shared: DeviceItem = {
    id: SHARED_TOKEN_ID, state: body.legacySharedRevoked === true ? 'shared-retired' : 'shared-active', name: 'The old shared token', scopes: [],
  };
  return [...tokens, shared];
}

function requests(output: unknown): readonly RequestItem[] {
  return list(record(output).requests).filter((request) => text(request.id) && request.status === 'pending').map((request): RequestItem => ({
    id: text(request.id),
    state: 'pending',
    label: plain(request.label) || text(request.id),
    requestedId: plain(request.requestedId),
    about: [plain(request.platform), plain(request.deviceFamily)].filter(Boolean).join(', '),
    offers: strings(request.capabilities).map(plain),
    createdAt: time(request.createdAt),
    expiresAt: time(request.expiresAt),
  }));
}

function phones(output: unknown): readonly PhoneItem[] {
  return list(record(output).nodes).filter((node) => text(node.nodeId)).map((node): PhoneItem => ({
    id: text(node.nodeId),
    state: node.contractCompatible === false ? 'out-of-date' : 'ready',
    label: plain(node.label) || text(node.nodeId),
    kind: plain(node.nodeKindLabel),
    platform: plain(node.platform),
    supported: strings(node.supported),
    gated: strings(node.gatedBySecureContext),
  }));
}

function grants(output: unknown): readonly GrantItem[] {
  return list(record(output).grants).filter((grant) => text(grant.grantId)).map((grant): GrantItem => ({
    id: text(grant.grantId),
    state: 'allowed',
    what: plain(grant.capabilityTitle) || plain(grant.capabilityId),
    node: plain(grant.nodeId),
    grantedAt: time(grant.grantedAt),
    expiresAt: time(grant.expiresAt),
    lastUsedAt: time(grant.lastUsedAt),
    uses: typeof grant.useCount === 'number' ? grant.useCount : 0,
  }));
}

function captures(output: unknown): readonly CaptureItem[] {
  return list(record(output).artifacts).filter((artifact) => text(artifact.artifactId)).map((artifact): CaptureItem => ({
    id: text(artifact.artifactId),
    state: 'kept',
    what: plain(artifact.kind) || plain(artifact.capabilityId),
    node: plain(artifact.nodeId),
    capturedAt: time(artifact.capturedAt),
    expiresAt: time(artifact.expiresAt),
    bytes: typeof artifact.byteLength === 'number' ? artifact.byteLength : 0,
    reason: plain(artifact.reason),
  }));
}

function relayCodes(output: unknown): readonly RelayItem[] {
  return list(record(output).codes).filter((code) => text(code.id)).map((code): RelayItem => ({
    id: text(code.id), state: 'paired', name: plain(code.name) || text(code.id), createdAt: time(code.createdAt), lastSeenAt: time(code.lastSeenAt),
  }));
}

function group(output: unknown): readonly GroupItem[] {
  const report = record(dataOf(output).report);
  if (!report.membership) return [];
  const state = report.membership === 'member' ? 'member' : report.membership === 'unreadable-key-material' ? 'unreadable' : 'no-group';
  return [{
    id: 'this-machine-group',
    state,
    name: state === 'member' ? plain(report.groupName) || 'Your group' : 'No group',
    machine: plain(report.nodeName),
    members: typeof report.memberCount === 'number' ? report.memberCount : 0,
    keyGeneration: typeof report.keyGeneration === 'number' ? report.keyGeneration : undefined,
    awaitingSync: record(report.replication).awaitingSync === true,
  }];
}

function machines(output: unknown): readonly MachineItem[] {
  return list(dataOf(output).members).filter((member) => text(member.nodeId)).map((member): MachineItem => ({
    id: text(member.nodeId),
    state: member.isThisMachine === true ? 'this-machine' : 'member',
    name: plain(member.displayName) || text(member.nodeId),
    lastSeenAt: time(member.lastSeenAt),
    heard: member.heardSinceStart === true,
  }));
}

function nearby(output: unknown): readonly NearbyItem[] {
  return list(dataOf(output).groups).filter((found) => text(found.groupId)).map((found): NearbyItem => ({
    id: text(found.groupId), state: 'announced', name: plain(found.displayName) || text(found.groupId),
    machines: typeof found.nodeCount === 'number' ? found.nodeCount : 0, lastSeenAt: time(found.lastSeenAt),
  }));
}

const PART_WORDS: Readonly<Record<string, string>> = {
  workers: 'the worker', queueName: 'its queue', queues: 'its queues', tunnel: 'the tunnel', access: 'Access', kv: 'KV', durableObjects: 'Durable Objects', r2: 'R2', secretsStore: 'the Secrets Store',
};

function cloudflare(output: unknown): readonly CloudflareItem[] {
  const data = dataOf(output);
  const configured = record(data.configured);
  return [{
    id: 'cloudflare',
    state: data.enabled === true ? 'on' : 'off',
    ready: data.ready === true,
    deployed: Object.entries(configured).filter(([, on]) => on === true).map(([part]) => PART_WORDS[part] ?? part),
    warnings: strings(data.warnings).map(plain),
  }];
}

function networkScan(output: unknown): readonly ScanItem[] {
  const data = dataOf(output);
  const state = data.state === 'on' ? 'on' : data.state === 'unreadable' ? 'unreadable' : 'off';
  const last = record(data.last);
  const lastWords = data.scanning === true ? 'scanning now'
    : last.at ? `last scan ${plain(last.at).slice(0, 16).replace('T', ' ')}: ${last.failed ? `failed, ${plain(last.failed)}` : `found ${typeof last.found === 'number' ? last.found : 0}`}` : '';
  const decision: ScanItem = {
    id: 'network-scan', state, name: 'Scan your network for model servers', network: false, models: 0,
    detail: [state === 'unreadable' ? `The decision could not be read: ${plain(data.reason)}.` : '', lastWords].filter(Boolean).join(' '),
  };
  const servers = list(data.servers).filter((server) => text(server.host)).map((server): ScanItem => ({
    id: `${text(server.host)}:${String(server.port)}`, state: 'server', name: plain(server.name) || `${plain(server.host)}:${String(server.port)}`,
    detail: `${plain(server.host)}:${String(server.port)}`, network: server.network === true, models: Array.isArray(server.models) ? server.models.length : 0,
  }));
  return [decision, ...servers];
}

const PAIRED_DEVICES = { domains: ['workspace'], events: [], lists: ['paired-devices'] } as const;
const NETWORK_SCAN_EVENTS = { domains: ['workspace'], events: [], lists: ['network-scan'] } as const;
/** A device asked to pair, was approved, rejected or finished pairing: the daemon's remote pairing events. */
const PAIR_REQUEST_EVENTS = { domains: ['workspace'], events: ['remote-pair-requested', 'remote-pair-approved', 'remote-pair-rejected', 'remote-pair-verified', 'remote-peer-disconnected'], lists: ['paired-devices'] } as const;
const RELAY_EVENTS = { domains: ['workspace'], events: [], lists: ['relay'] } as const;

const run = (id: string) => ({ id, inputs: {} });

export const DEVICES_PLACE = definePlace<Item>({
  id: 'devices',
  group: 'devices',
  title: 'Devices and network',
  lists: [
    {
      id: 'devices',
      label: 'Paired',
      noun: 'your paired devices',
      source: { kind: 'daemon', method: 'pairing.tokens.list', input: {}, items: devices },
      follows: PAIRED_DEVICES,
      empty: 'Nothing is paired yet.',
      row: (item) => {
        const device = item as DeviceItem;
        if (device.state === 'shared-active') return { title: device.name, right: 'still works', mark: 'attention' };
        if (device.state === 'shared-retired') return { title: device.name, right: 'retired', mark: 'paused' };
        return { title: device.name, ...(device.state === 'agent' ? { right: 'the Agent' } : {}), mark: 'ok' };
      },
      detail: (item) => {
        const device = item as DeviceItem;
        if (device.state === 'shared-active') {
          return [
            { text: 'Devices paired before each device had its own token may still sign in with the one token every app on this machine shares.' },
            { label: 'Retiring it', text: 'signs every such device out; they pair again for a token of their own. The apps on this machine get its replacement.', tone: 'muted' },
          ];
        }
        if (device.state === 'shared-retired') return [{ text: 'The old shared token was retired and replaced; only the apps on this machine hold the replacement.' }];
        return [
          { label: 'Paired', text: when(device.createdAt) },
          { label: 'Last seen', text: when(device.lastSeenAt) },
          { label: 'Kind', text: device.state === 'agent' ? 'the GoodVibes Agent\'s credential for calls it makes for you' : device.owner ? 'a device you paired yourself' : 'a device paired for automation' },
          { label: 'Access', text: device.scopes.length > 0 ? `only ${device.scopes.join(', ')}` : 'everything the daemon offers' },
        ];
      },
    },
    {
      id: 'waiting',
      label: 'Waiting to pair',
      noun: 'the devices waiting to pair',
      source: { kind: 'daemon', method: 'remote.pair.requests.list', input: {}, items: requests },
      follows: PAIR_REQUEST_EVENTS,
      empty: 'No device is waiting to pair. A phone asks from its own screen (the web UI\'s Pair this phone).',
      row: (item) => ({ title: (item as RequestItem).label, right: 'waiting', mark: 'waiting' }),
      detail: (item) => {
        const request = item as RequestItem;
        return [
          ...(request.about ? [{ label: 'Device', text: request.about }] : []),
          { label: 'Offers', text: request.offers.length > 0 ? request.offers.join(', ') : 'nothing yet' },
          { label: 'Pairs as', text: request.requestedId || 'not said' },
          { label: 'Asked', text: when(request.createdAt) },
          { label: 'Expires', text: when(request.expiresAt) },
          { text: 'Approve it only if you recognise it; then press Finish pairing on that device.', tone: 'muted' },
        ];
      },
    },
    {
      id: 'phones',
      label: 'Phones',
      noun: 'the phones paired as device nodes',
      source: { kind: 'daemon', method: 'devices.nodes.list', input: {}, items: phones },
      follows: PAIR_REQUEST_EVENTS,
      empty: 'No phone is paired as a device node.',
      row: (item) => {
        const phone = item as PhoneItem;
        return { title: phone.label, ...(phone.state === 'out-of-date' ? { right: 'needs an update' } : {}), mark: phone.state === 'ready' ? 'ok' : 'attention' };
      },
      detail: (item) => {
        const phone = item as PhoneItem;
        return [
          ...(phone.kind || phone.platform ? [{ label: 'Device', text: [phone.kind, phone.platform].filter(Boolean).join(', ') }] : []),
          { label: 'Can serve', text: phone.supported.length > 0 ? phone.supported.join(', ') : 'nothing yet' },
          ...(phone.gated.length > 0 ? [{ label: 'Needs https', text: `${phone.gated.join(', ')}: a secure address in Settings turns these on`, tone: 'warning' as const }] : []),
          ...(phone.state === 'out-of-date' ? [{ label: 'Needs a look', text: 'its app speaks an older version of the device contract; update it', tone: 'warning' as const }] : []),
        ];
      },
    },
    {
      id: 'grants',
      label: 'Always allowed',
      noun: 'the "always allow" answers given to your phones',
      source: { kind: 'daemon', method: 'devices.grants.list', input: {}, items: grants },
      follows: PAIRED_DEVICES,
      empty: 'No "always allow" answer was given: each request from a phone asks you.',
      row: (item) => ({ title: `${(item as GrantItem).what} on ${(item as GrantItem).node}`, mark: 'ok' }),
      detail: (item) => {
        const grant = item as GrantItem;
        return [
          { label: 'Allowed', text: when(grant.grantedAt) },
          { label: 'Ends', text: when(grant.expiresAt) },
          { label: 'Used', text: `${grant.uses} time${grant.uses === 1 ? '' : 's'}${grant.lastUsedAt ? `, last ${when(grant.lastUsedAt)}` : ''}` },
        ];
      },
    },
    {
      id: 'captures',
      label: 'Captures',
      noun: 'the photos and screen captures the daemon keeps',
      source: { kind: 'daemon', method: 'devices.artifacts.list', input: {}, items: captures },
      follows: PAIRED_DEVICES,
      empty: 'No photo or screen capture is kept.',
      row: (item) => ({ title: `${(item as CaptureItem).what} from ${(item as CaptureItem).node}`, right: when((item as CaptureItem).capturedAt), mark: 'ok' }),
      detail: (item) => {
        const capture = item as CaptureItem;
        return [
          { label: 'Taken', text: when(capture.capturedAt) },
          { label: 'Deleted by itself', text: when(capture.expiresAt) },
          { label: 'Size', text: `${Math.max(1, Math.round(capture.bytes / 1024))} KB` },
          ...(capture.reason ? [{ label: 'Asked for because', text: capture.reason }] : []),
        ];
      },
    },
    {
      id: 'relay',
      label: 'Relay',
      noun: 'the devices paired through the relay',
      source: { kind: 'daemon', method: 'relay.codes.list', input: {}, items: relayCodes },
      follows: RELAY_EVENTS,
      empty: 'No device is paired through the relay (the way in from outside your network).',
      row: (item) => ({ title: (item as RelayItem).name, right: (item as RelayItem).lastSeenAt ? undefined : 'not used yet', mark: 'ok' }),
      detail: (item) => [
        { label: 'Paired', text: when((item as RelayItem).createdAt) },
        { label: 'Last used', text: when((item as RelayItem).lastSeenAt) },
      ],
    },
    {
      id: 'group',
      label: 'Machine group',
      noun: 'this machine\'s group',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('cluster.status'), items: group },
      empty: 'This daemon runs no machine group.',
      row: (item) => {
        const own = item as GroupItem;
        if (own.state === 'no-group') return { title: 'In no group', mark: 'paused' };
        if (own.state === 'unreadable') return { title: 'Group key could not be read', mark: 'attention' };
        return { title: own.name, right: `${own.members} machine${own.members === 1 ? '' : 's'}`, mark: own.awaitingSync ? 'attention' : 'ok' };
      },
      detail: (item) => {
        const own = item as GroupItem;
        if (own.state === 'no-group') {
          return [
            { label: 'This machine', text: own.machine || 'not named' },
            { text: 'A group shares inbound channel work and a few settings with your other GoodVibes machines on this network. Start one here, or join one from Nearby groups.' },
          ];
        }
        if (own.state === 'unreadable') return [{ text: 'This machine\'s group key could not be read, so it cannot take part in its group. Leave the group and join it again with its key.', tone: 'warning' }];
        return [
          { label: 'This machine', text: own.machine || 'not named' },
          { label: 'Machines', text: String(own.members) },
          ...(own.keyGeneration !== undefined ? [{ label: 'Key', text: `generation ${own.keyGeneration}` }] : []),
          ...(own.awaitingSync ? [{ label: 'Needs a look', text: 'this machine does not hold the group\'s settings yet', tone: 'warning' as const }] : []),
        ];
      },
    },
    {
      id: 'machines',
      label: 'Machines',
      noun: 'the machines in your group',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('cluster.nodes'), items: machines },
      empty: 'No machine group yet: start or join one under Machine group.',
      row: (item) => {
        const machine = item as MachineItem;
        return { title: machine.name, ...(machine.state === 'this-machine' ? { right: 'this machine' } : machine.heard ? {} : { right: 'not heard' }), mark: machine.heard || machine.state === 'this-machine' ? 'ok' : 'attention' };
      },
      detail: (item) => {
        const machine = item as MachineItem;
        return [{ label: 'Last heard', text: machine.state === 'this-machine' ? 'this is the machine you are on' : machine.heard ? when(machine.lastSeenAt) : 'nothing since this machine started' }];
      },
    },
    {
      id: 'nearby',
      label: 'Nearby groups',
      noun: 'the groups announced on this network',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('cluster.groups'), items: nearby },
      empty: 'No group is announced on this network.',
      row: (item) => ({ title: (item as NearbyItem).name, right: `${(item as NearbyItem).machines} machine${(item as NearbyItem).machines === 1 ? '' : 's'}`, mark: 'ok' }),
      detail: (item) => [
        { label: 'Group id', text: item.id },
        { label: 'Last heard', text: when((item as NearbyItem).lastSeenAt) },
        { text: 'Joining needs the key a machine already in the group shows.', tone: 'muted' },
      ],
    },
    {
      id: 'cloudflare-settings',
      label: 'Cloudflare settings',
      noun: 'the Cloudflare settings',
      source: { kind: 'daemon', method: 'config.get', input: {}, items: settingsOf((key) => key.startsWith('cloudflare.')) },
      follows: { domains: ['config'], events: [] },
      empty: 'No Cloudflare setting is known to this daemon.',
      row: settingRow,
      detail: settingDetail,
    },
    {
      id: 'addresses',
      label: 'Addresses and ports',
      noun: 'the addresses and ports your other devices reach GoodVibes at',
      source: { kind: 'daemon', method: 'config.get', input: {}, items: settingsOf((key) => ADDRESS_KEYS.test(key)) },
      follows: { domains: ['config'], events: [] },
      empty: 'No address or port setting is known to this daemon.',
      row: settingRow,
      detail: settingDetail,
    },
    {
      id: 'phone-settings',
      label: 'Phone and voice settings',
      noun: 'the settings for paired phones and voice',
      source: { kind: 'daemon', method: 'config.get', input: {}, items: settingsOf((key) => key.startsWith('device.') || /^(voice|tts|stt)\./.test(key)) },
      follows: { domains: ['config'], events: [] },
      empty: 'No phone or voice setting is known to this daemon.',
      row: settingRow,
      detail: settingDetail,
    },
    {
      id: 'network-scan',
      label: 'Network scan',
      noun: 'whether your network is scanned for model servers',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('network-scan.status'), items: networkScan },
      follows: NETWORK_SCAN_EVENTS,
      empty: 'The network-scan decision could not be described.',
      row: (item) => {
        const scan = item as ScanItem;
        if (scan.state === 'server') return { title: scan.name, right: scan.network ? 'on your network' : 'this computer', mark: 'ok' };
        return { title: scan.name, right: scan.state === 'on' ? 'on' : scan.state === 'off' ? 'off' : 'could not be read', mark: scan.state === 'on' ? 'ok' : scan.state === 'off' ? 'paused' : 'attention' };
      },
      detail: (item) => {
        const scan = item as ScanItem;
        if (scan.state === 'server') return [{ label: 'Address', text: scan.detail }, { label: 'Models', text: String(scan.models) }, { text: 'Models and providers lists it as a provider.', tone: 'muted' }];
        return [
          { text: 'Model servers on this computer are always found. Turned on, the daemon also checks the other devices on your local network (your subnet only, nothing beyond it), now and at each start.' },
          ...(scan.detail ? [{ label: scan.state === 'unreadable' ? 'Needs a look' : 'Scan', text: scan.detail, tone: scan.state === 'unreadable' ? 'warning' as const : 'plain' as const }] : []),
        ];
      },
    },
    {
      id: 'settings-sync',
      label: 'Settings sync',
      noun: 'the settings that disagree after a pull',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('settings-sync.conflicts'), items: settingsSync },
      follows: { domains: ['workspace'], events: [], lists: ['settings-sync'] },
      empty: 'Settings sync could not be described.',
      row: (item) => {
        const sync = item as SyncItem;
        return sync.state === 'settings' ? { title: sync.name, mark: 'ok' } : { title: sync.name, right: 'disagrees', mark: 'attention' };
      },
      detail: (item) => {
        const sync = item as SyncItem;
        if (sync.state === 'settings') {
          return [
            { text: 'Carry your settings to another machine as a file: the daemon\'s settings and this program\'s, each part labelled with whose it is. Pulling a file applies each part to its owner and says what was left.' },
            { text: 'Settings that disagree after a pull are listed below, to settle one by one.', tone: 'muted' },
          ];
        }
        return [{ label: 'Whose', text: sync.owner || 'not said' }, { label: 'Pulled from', text: sync.from || 'not said' }];
      },
    },
    {
      id: 'cloudflare',
      label: 'Cloudflare',
      noun: 'the Cloudflare integration',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('cloudflare.status'), items: cloudflare },
      empty: 'Cloudflare could not be described.',
      row: (item) => {
        const cf = item as CloudflareItem;
        return { title: 'Cloudflare', right: cf.state === 'off' ? 'off' : cf.ready ? 'on, ready' : 'on, not ready', mark: cf.state === 'off' ? 'paused' : cf.ready ? 'ok' : 'attention' };
      },
      detail: (item) => {
        const cf = item as CloudflareItem;
        return [
          { text: 'Optional: batches and remote work through a worker on your own Cloudflare account.' },
          { label: 'Deployed', text: cf.deployed.length > 0 ? cf.deployed.join(', ') : 'nothing yet' },
          ...cf.warnings.map((warning) => ({ label: 'Warning', text: warning, tone: 'warning' as const })),
        ];
      },
    },
  ],
  actions: [
    // A setting shown where its thing is, changed in place through Settings' own capability (the key given by the row).
    { key: 'enter', id: 'change-setting', list: 'addresses', states: ['setting'], capability: 'settings.set', label: 'change', fill: { key: 'id' } },
    { key: 'enter', id: 'change-phone-setting', list: 'phone-settings', states: ['setting'], capability: 'settings.set', label: 'change', fill: { key: 'id' } },
    { key: 'enter', id: 'change-cloudflare-setting', list: 'cloudflare-settings', states: ['setting'], capability: 'settings.set', label: 'change', fill: { key: 'id' } },
    // Pairing something new keeps its own screen: the QR code, and the other ways to sign in.
    { key: 'p', capability: 'devices.pair', label: 'pair something' },
    { key: 'n', list: 'devices', states: ['paired', 'agent'], capability: 'devices.rename', label: 'rename', fill: { device: 'id' } },
    { key: 'x', list: 'devices', states: ['paired', 'agent'], capability: 'devices.revoke', label: 'revoke', fill: { device: 'id' } },
    { key: 'x', id: 'retire-shared', list: 'devices', states: ['shared-active'], capability: 'devices.revoke-shared', label: 'retire it' },
    // Its one-time token is the outcome's reveal: shown whole in the place's own pane, with the copy key, until left.
    { key: 'g', id: 'migrate-shared', list: 'devices', states: ['shared-active'], capability: 'devices.migrate-shared', label: 'give a device its own token' },
    // This program's own credential for its daemon (builtin/devices-session.ts): how it reaches it, and forgetting it.
    { key: 'h', id: 'host-status', list: 'devices', whole: true, capability: 'devices.host-status', label: 'how this terminal connects' },
    { key: 'U', id: 'unpair-host', list: 'devices', whole: true, capability: 'devices.unpair-host', label: 'forget its daemon pairing' },
    // The Secure address screen in Settings, as it is: an https address for phones.
    { key: 's', id: 'secure-address', list: 'devices', capability: 'settings.open', label: 'secure address', fill: { where: () => 'secure address' } },
    { key: 'a', list: 'waiting', states: ['pending'], capability: 'devices.approve', label: 'approve', fill: { request: 'id' } },
    { key: 'x', list: 'waiting', states: ['pending'], capability: 'devices.reject', label: 'reject', fill: { request: 'id' } },
    { key: 'x', list: 'grants', states: ['allowed'], capability: 'devices.revoke-grant', label: 'stop allowing', fill: { grant: 'id' } },
    { key: 'x', list: 'captures', states: ['kept'], capability: 'devices.delete-capture', label: 'delete now', fill: { capture: 'id' } },
    { key: 'x', list: 'relay', states: ['paired'], capability: 'devices.relay-revoke', label: 'cut off', fill: { code: 'id' } },
    { key: 'y', list: 'relay', capability: 'devices.relay-status', label: 'is the relay reachable' },
    { key: 'c', list: 'group', states: ['no-group'], capability: 'cluster.create', label: 'start a group' },
    { key: 'k', list: 'group', states: ['member'], capability: 'cluster.key', label: 'join key' },
    { key: 'n', list: 'group', states: ['member'], capability: 'cluster.rename', label: 'rename' },
    { key: 'o', list: 'group', states: ['member'], capability: 'cluster.rotate', label: 'new key' },
    { key: 'u', list: 'group', states: ['member'], capability: 'cluster.publish', label: 'share a setting' },
    { key: 't', list: 'group', states: ['member'], capability: 'cluster.accept', label: 'take the group\'s setting' },
    { key: 'l', list: 'group', states: ['member', 'unreadable'], capability: 'cluster.leave', label: 'leave' },
    { key: 'x', list: 'machines', states: ['member'], capability: 'cluster.forget', label: 'remove', fill: { node: 'id' } },
    { key: 'j', list: 'nearby', states: ['announced'], capability: 'cluster.join', label: 'join', fill: { group: 'id' } },
    { key: 'o', list: 'network-scan', states: ['off', 'unreadable'], capability: 'network-scan.on', label: 'turn on' },
    { key: 'o', list: 'network-scan', states: ['on'], capability: 'network-scan.off', label: 'turn off' },
    { key: 'v', list: 'settings-sync', states: ['settings'], capability: 'settings-sync.review', label: 'where they come from' },
    { key: 'e', list: 'settings-sync', states: ['settings'], capability: 'settings-sync.export', label: 'save to a file' },
    { key: 'i', list: 'settings-sync', states: ['settings'], capability: 'settings-sync.inspect', label: 'look inside a file' },
    { key: 'P', list: 'settings-sync', states: ['settings'], capability: 'settings-sync.pull', label: 'pull a file' },
    { key: 'w', list: 'settings-sync', states: ['settings'], capability: 'settings-sync.show', label: 'one setting' },
    { key: 'f', list: 'settings-sync', states: ['settings'], capability: 'settings-sync.failures', label: 'recent failures' },
    { key: 'k', list: 'settings-sync', states: ['conflict'], capability: 'settings-sync.resolve', label: 'settle it', fill: { key: 'id' } },
    { key: 'w', id: 'show-conflict', list: 'settings-sync', states: ['conflict'], capability: 'settings-sync.show', label: 'where its value comes from', fill: { key: 'id' } },
    { key: 'q', list: 'cloudflare', capability: 'cloudflare.requirements', label: 'what the token needs' },
    { key: 't', list: 'cloudflare', capability: 'cloudflare.create-token', label: 'create the token' },
    { key: 'd', list: 'cloudflare', capability: 'cloudflare.discover', label: 'find accounts' },
    { key: 'v', list: 'cloudflare', capability: 'cloudflare.validate', label: 'check a token' },
    { key: 'e', list: 'cloudflare', capability: 'cloudflare.provision', label: 'deploy' },
    { key: 'k', list: 'cloudflare', states: ['on'], capability: 'cloudflare.verify', label: 'check the worker' },
    { key: 'x', list: 'cloudflare', states: ['on'], capability: 'cloudflare.disable', label: 'turn off' },
  ],
  count: (lists) => {
    const waiting = (lists.waiting ?? []).length;
    return waiting > 0 ? { count: waiting, words: `${waiting} waiting to pair`, tone: 'waiting' } : undefined;
  },
});
