/**
 * `/channels`, described once (command-actions/) for both terminal apps: the
 * daemon's channels (Slack, Telegram, ntfy, ...) — their status, accounts,
 * setup and repairs, who may reach the assistant on each (ingress rules), the
 * model and permission mode each channel's sessions get (profiles), a test
 * message, and the Telegram reading position. What the daemon owns is read
 * and changed over its `channels.*` methods, which each app reaches its own
 * way. What one app keeps itself (the terminal app's route and delivery
 * snapshots and its routes view; the Agent's setup readiness, guide, inbox,
 * delivery receipts and sends) comes from that app's host, and the other app
 * refuses those actions saying why.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { SESSION_GATE_PRESET_NAMES, gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, ActionValues, CommandActionContext, FixedChoice, InputDescription } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';

type ChannelsMethod =
  | 'channels.status' | 'channels.accounts.list' | 'channels.doctor.get' | 'channels.setup.get' | 'channels.test.send'
  | 'channels.policies.list' | 'channels.policies.update'
  | 'channels.profiles.list' | 'channels.profiles.get' | 'channels.profiles.set' | 'channels.profiles.delete';
/** Call one channels method on the daemon this app works with; throws a refusal saying why it could not. */
export type ChannelsInvoke<Ctx> = <M extends ChannelsMethod>(ctx: Ctx, method: M, input: OperatorMethodInput<M>) => Promise<OperatorMethodOutput<M>>;
type ChannelPolicy = OperatorMethodOutput<'channels.policies.list'>['policies'][number];
type ChannelProfileBinding = OperatorMethodOutput<'channels.profiles.list'>['bindings'][number];
type PolicyUpdateInput = OperatorMethodInput<'channels.policies.update'>;
type PolicyUpdateFields = { -readonly [K in Exclude<keyof PolicyUpdateInput, 'surface'>]?: PolicyUpdateInput[K] };

/** The values of "Send a message to a channel", as the Agent's delivery reads them. */
export interface ChannelSendValues {
  readonly message: string;
  readonly title?: string | undefined;
  readonly channel?: string | undefined;
  readonly route?: string | undefined;
  readonly webhook?: string | undefined;
  readonly link?: string | undefined;
}

export type ChannelReadinessFilter = 'all' | 'ready' | 'attention';

/**
 * How one app reaches the daemon's channels, and what it keeps itself. An
 * action whose reader this app does not have is refused with `missing`'s
 * reason, so each action says where it is done instead.
 */
export interface ChannelsHost<Ctx> {
  readonly invoke: ChannelsInvoke<Ctx>;
  /** Pick up Telegram where it left off: review and bind a saved reading position. */
  readonly telegramCursor: (ctx: Ctx) => Promise<void>;
  /** Whether a channel is switched on in this app's settings, shown beside its rules. */
  readonly enabledInSettings?: ((ctx: Ctx, surface: string) => boolean | undefined) | undefined;
  readonly openView?: ((ctx: Ctx) => void) | undefined;
  readonly overview?: ((ctx: Ctx) => string) | undefined;
  readonly routes?: ((ctx: Ctx) => string) | undefined;
  readonly delivery?: ((ctx: Ctx) => string) | undefined;
  readonly readiness?: ((ctx: Ctx, filter: ChannelReadinessFilter) => string) | undefined;
  readonly configured?: ((ctx: Ctx, channel: string) => string) | undefined;
  readonly guide?: ((ctx: Ctx, channel: string) => string) | undefined;
  readonly triage?: ((ctx: Ctx, limit: string) => Promise<string>) | undefined;
  readonly receipts?: ((ctx: Ctx, limit: string) => string) | undefined;
  readonly send?: ((ctx: Ctx, values: ChannelSendValues) => Promise<string>) | undefined;
}

const AGENT_ONLY = 'the Agent keeps this itself (its channel setup, inbox and delivery receipts); run it in goodvibes-agent';
const TERMINAL_ONLY = 'the terminal app keeps this itself (its routes and delivery snapshots); run it in goodvibes';

function missing(what: string, where: string): never {
  throw commandRefusal(`${what} is not available in this program: ${where}.`);
}

type JsonRecord = Readonly<Record<string, unknown>>;
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function str(record: JsonRecord, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}
function flag(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}
function records(value: unknown, key: string): readonly JsonRecord[] {
  const list = isRecord(value) ? value[key] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

const SHOWN = 20;
function more(total: number, what: string): string[] {
  return total > SHOWN ? [`  ${total - SHOWN} more ${what} not shown.`] : [];
}

function formatStatus(body: unknown): string {
  const channels = records(body, 'channels');
  if (channels.length === 0) return 'The daemon reports no channels. /channels setup <channel> shows what one needs.';
  return ['Channels:', ...channels.slice(0, SHOWN).map((channel) => {
    const state = str(channel, 'state', str(channel, 'status', 'unknown'));
    return `  ${str(channel, 'surface', 'unknown')}: ${flag(channel, 'enabled') ? 'on' : 'off'}; ${flag(channel, 'ready') ? 'ready' : 'not ready'}; ${state}`;
  }), ...more(channels.length, 'channels')].join('\n');
}

function formatAccounts(body: unknown): string {
  const accounts = records(body, 'accounts');
  if (accounts.length === 0) return 'The daemon reports no channel accounts.';
  return ['Channel accounts (secret values are never shown):', ...accounts.slice(0, SHOWN).map((account) => {
    const accountId = str(account, 'accountId');
    const secrets = records(account, 'secrets').map((secret) => str(secret, 'field', 'secret'));
    return `  ${str(account, 'surface', 'unknown')}${accountId ? `/${accountId}` : ''}: ${flag(account, 'configured') ? 'configured' : 'not configured'}; ${flag(account, 'linked') ? 'linked' : 'not linked'}; sign-in ${str(account, 'authState', str(account, 'state', 'unknown'))}${secrets.length > 0 ? `; secrets held for ${secrets.join(', ')}` : ''}`;
  }), ...more(accounts.length, 'accounts')].join('\n');
}

function formatDoctor(surface: string, body: unknown): string {
  const root = isRecord(body) ? body : {};
  const checks = records(body, 'checks');
  const repairs = records(body, 'repairActions');
  const lines = [`Checks for ${str(root, 'surface', surface)}:`];
  if (checks.length === 0) lines.push('  No checks reported.');
  for (const check of checks.slice(0, SHOWN)) lines.push(`  ${str(check, 'id', 'check')}: ${str(check, 'status', 'unknown')}`);
  if (repairs.length > 0) lines.push('Repairs the daemon offers:', ...repairs.slice(0, 12).map((action) => `  ${str(action, 'id', 'repair')}`));
  return lines.join('\n');
}

function formatSetup(surface: string, body: unknown): string {
  const root = isRecord(body) ? body : {};
  const fields = records(body, 'fields');
  const secrets = records(body, 'secretTargets');
  const lines = [`What ${str(root, 'surface', surface)} needs (no value is shown):`];
  if (fields.length > 0) lines.push('  Settings:', ...fields.slice(0, SHOWN).map((field) => `    ${str(field, 'id', 'field')}`));
  if (secrets.length > 0) lines.push('  Secrets:', ...secrets.slice(0, 12).map((target) => `    ${str(target, 'id', 'secret')} (${flag(target, 'required') ? 'required' : 'optional'})`));
  if (fields.length === 0 && secrets.length === 0) lines.push('  Nothing is declared.');
  return lines.join('\n');
}

function renderPolicy(policy: ChannelPolicy, enabledInSettings: boolean | undefined): string {
  const onOff = (value: boolean): string => (value ? 'on' : 'off');
  const list = (values: readonly string[]): string => (values.length > 0 ? values.join(', ') : 'anyone');
  const lines = [
    `  ${policy.surface}${enabledInSettings === undefined ? '' : `  (${enabledInSettings ? 'on' : 'off'} in settings)`}`,
    `    messages: ${policy.enabled ? 'accepted' : 'refused'}; mention required: ${onOff(policy.requireMention)}; commands without a mention: ${onOff(policy.allowTextCommandsWithoutMention)}`,
    `    direct messages: ${onOff(policy.allowDirectMessages)} (${policy.dmPolicy}); groups: ${onOff(policy.allowGroupMessages)} (${policy.groupPolicy}); threads: ${onOff(policy.allowThreadMessages)}`,
    `    users: ${list(policy.allowlistUserIds)}; channels: ${list(policy.allowlistChannelIds)}; groups: ${list(policy.allowlistGroupIds)}`,
    `    open (anyone may write and no owner claim is raised, while no list is set): ${onOff(policy.open === true)}`,
    `    commands: ${policy.allowedCommands.length > 0 ? policy.allowedCommands.join(', ') : 'all'}`,
  ];
  for (const group of policy.groupPolicies) {
    lines.push(`    group rule ${group.label ?? group.id}${group.groupId ? ` (group ${group.groupId})` : group.channelId ? ` (channel ${group.channelId})` : ''}`);
  }
  return lines.join('\n');
}

/** A profile change that loosens a channel's permission mode, put to the owner instead of applied: what is true and what to do. */
function ownerPendingText(result: object): string {
  const answer = result as { readonly approvalId?: unknown; readonly state?: unknown };
  const approval = typeof answer.approvalId === 'string' ? ` as approval ${answer.approvalId}` : '';
  const state = typeof answer.state === 'string' ? answer.state : 'nothing was changed yet; this loosens the permission mode, which only the owner does';
  return `Not applied: ${state}. It was put to the owner${approval}; he approves it from his own app (/approval waiting).`;
}

function renderProfileBinding(binding: ChannelProfileBinding): string {
  const scope = binding.channelId ? `${binding.surfaceKind}:${binding.channelId}` : `${binding.surfaceKind} (the whole channel kind)`;
  const lines = [`  ${scope}`];
  if (binding.model) lines.push(`    model: ${binding.model}${binding.provider ? ` (${binding.provider})` : ''}`);
  if (binding.permissionMode) lines.push(`    permission mode: ${binding.permissionMode}`);
  if (binding.invalid) lines.push(`    needs attention: ${binding.invalid.reason}`);
  return lines.join('\n');
}

function renderEffectiveProfile(effective: OperatorMethodOutput<'channels.profiles.get'>['effective']): string {
  const fields = [
    ['model', effective.profile.model, effective.sources.model],
    ['provider', effective.profile.provider, effective.sources.provider],
    ['permission mode', effective.profile.permissionMode, effective.sources.permissionMode],
  ] as const;
  const lines = ['  sessions from this channel get:'];
  for (const [label, value, source] of fields) lines.push(`    ${label}: ${value ?? '(host default)'}${value !== undefined && source ? ` (from ${source})` : ''}`);
  return lines.join('\n');
}

let hostOf: ChannelsHost<unknown> | undefined;
function host(): ChannelsHost<unknown> {
  if (!hostOf) throw commandRefusal('/channels is not wired in this program.');
  return hostOf;
}

/** The daemon's channels as a live list ("Pair something" under /devices chooses from it too). */
export const CHANNELS_LIST = defineList<unknown>({
  name: 'channels',
  async read(ctx) {
    const body = await host().invoke(ctx, 'channels.status', {});
    return records(body, 'channels').map((channel): ListRow => ({
      value: str(channel, 'surface', 'unknown'), label: str(channel, 'surface', 'unknown'),
      state: flag(channel, 'ready') ? 'ready' : flag(channel, 'enabled') ? 'not ready' : 'off',
    }));
  },
  operator: { method: 'channels.status', input: {}, rows: { from: 'channels', value: 'surface', label: 'surface', state: 'state' } },
});
const PROFILES = defineList<unknown>({
  name: 'channels.profiles',
  async read(ctx) {
    const { bindings } = await host().invoke(ctx, 'channels.profiles.list', {});
    return bindings.map((binding): ListRow => ({
      value: binding.surfaceKind, label: binding.channelId ? `${binding.surfaceKind}:${binding.channelId}` : binding.surfaceKind,
      detail: [binding.model, binding.permissionMode].filter(Boolean).join(', ') || undefined,
    }));
  },
  operator: { method: 'channels.profiles.list', input: {}, rows: { from: 'bindings', value: 'surfaceKind', label: 'surfaceKind', detail: 'model' } },
});

const SURFACE_OTHER = 'a channel kind the daemon does not report yet (slack, telegram, discord, ntfy, webhook, ...)';
const CHANNEL: InputDescription = listInput({ id: 'channel', label: 'Channel', help: 'One of the daemon\'s channels', list: CHANNELS_LIST, other: SURFACE_OTHER });
const PROFILE_CHANNEL: InputDescription = listInput({ id: 'channel', label: 'Channel', help: 'A channel kind; its sessions get the profile', list: PROFILES, other: SURFACE_OTHER });
const CHANNEL_ID: InputDescription = textInput({ id: 'id', label: 'One conversation', help: 'The id of one conversation in that channel; blank means the whole channel kind', why: 'a conversation id on that channel', typed: { position: 2 }, optional: { default: '', means: 'the whole channel kind' } });
const LIMIT = (help: string): InputDescription => ({ id: 'limit', label: 'How many', help, kind: 'number', required: { default: '10', defaultMeans: 'ten' }, typed: { flag: '--limit' } });

const ON_OFF: readonly FixedChoice[] = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];
const LOOSENING_ON: readonly FixedChoice[] = [{ value: 'on', label: 'On', risk: 'loosens-a-protection' }, { value: 'off', label: 'Off' }];
const CONVERSATION_POLICIES: readonly FixedChoice[] = [
  { value: 'allow', label: 'Allow', risk: 'loosens-a-protection' }, { value: 'deny', label: 'Refuse' }, { value: 'inherit', label: 'As the channel says' },
];
const UNCHANGED = { default: '', means: 'unchanged' };
const ruleSwitch = (id: string, label: string, help: string, choices: readonly FixedChoice[]): InputDescription =>
  ({ id, label, help, kind: 'choice', choices, required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: `--${id}` } });
const ruleList = (id: string, label: string, help: string): InputDescription =>
  textInput({ id, label, help: `${help}; a comma list, or none to clear it`, why: 'ids on that channel', typed: { flag: `--${id}` }, optional: UNCHANGED });

/** Each ingress-rule blank and the daemon field it writes. */
const RULE_SWITCHES = { enabled: 'enabled', 'require-mention': 'requireMention', 'allow-dms': 'allowDirectMessages', 'allow-groups': 'allowGroupMessages', 'allow-threads': 'allowThreadMessages', 'commands-without-mention': 'allowTextCommandsWithoutMention', open: 'open' } as const;
const RULE_CHOICES = { 'dm-policy': 'dmPolicy', 'group-policy': 'groupPolicy' } as const;
const RULE_LISTS = { 'allow-users': 'allowlistUserIds', 'allow-channels': 'allowlistChannelIds', 'allow-group-ids': 'allowlistGroupIds', 'allowed-commands': 'allowedCommands' } as const;

function ruleFields(values: ActionValues): PolicyUpdateFields {
  const fields: PolicyUpdateFields = {};
  for (const [id, field] of Object.entries(RULE_SWITCHES)) if (values[id]) fields[field] = values[id] === 'on';
  for (const [id, field] of Object.entries(RULE_CHOICES)) if (values[id]) fields[field] = values[id] as 'allow' | 'deny' | 'inherit';
  for (const [id, field] of Object.entries(RULE_LISTS)) {
    const value = values[id];
    if (value) fields[field] = value.trim().toLowerCase() === 'none' ? [] : value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return fields;
}

const PERMISSION_MODES: readonly FixedChoice[] = SESSION_GATE_PRESET_NAMES.map((name) => ({
  value: name, label: gatePresetLabel(name), ...(name === 'just-vibes' || name === 'yolo' ? { risk: 'loosens-a-protection' as const } : {}),
}));

function profileTarget(values: ActionValues): { surfaceKind: string; channelId?: string } {
  return { surfaceKind: values.channel!, ...(values.id ? { channelId: values.id } : {}) };
}

/** Register `/channels` with how this app reaches the daemon's channels and what it keeps itself. */
export function registerChannelsCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, channelsHost: ChannelsHost<Ctx>): void {
  hostOf = channelsHost as unknown as ChannelsHost<unknown>;
  const h = channelsHost;
  const actions: ActionDescription<Ctx>[] = [
    readAction<Ctx>({
      id: 'status', label: 'See your channels', word: 'status',
      sentence: 'Lists each channel the daemon has, whether it is on and whether it is ready.',
      operator: { method: 'channels.status', fields: {} },
      async run(_values, ctx) { return formatStatus(await h.invoke(ctx, 'channels.status', {})); },
    }),
    readAction<Ctx>({
      id: 'readiness', label: 'See which channels are set up', word: 'readiness',
      inputs: [{ id: 'show', label: 'Show', help: 'Every channel, only the ready ones, or only those that need something', kind: 'choice',
        choices: [{ value: 'all', label: 'Every channel' }, { value: 'ready', label: 'Ready ones' }, { value: 'attention', label: 'Ones that need something' }],
        required: { default: 'all', defaultMeans: 'every channel' }, typed: { flag: '--show' } }],
      sentence: 'Lists the channels this program can send to, what each is missing and where it sends.', example: { show: 'attention' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return h.readiness ? h.readiness(ctx, (values.show ?? 'all') as ChannelReadinessFilter) : missing('Channel readiness', AGENT_ONLY); },
    }),
    readAction<Ctx>({
      id: 'configured', label: 'See how one channel is configured', word: 'configured', inputs: [CHANNEL],
      sentence: 'Shows which settings {channel} has and lacks and what to do next; no secret value is shown.', example: { channel: 'slack' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return h.configured ? h.configured(ctx, values.channel!) : missing('A channel\'s configuration', AGENT_ONLY); },
    }),
    readAction<Ctx>({
      id: 'guide', label: 'Walk through setting up channels', word: 'guide',
      inputs: [{ ...CHANNEL, required: { default: '', defaultMeans: 'the next channel to set up' } }],
      sentence: 'Shows the setup steps, done and left, starting with the next channel to set up.', example: { channel: 'slack' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return h.guide ? h.guide(ctx, values.channel ?? '') : missing('The channel setup guide', AGENT_ONLY); },
    }),
    readAction<Ctx>({
      id: 'setup', label: 'See what a channel needs to be set up', word: 'setup', inputs: [CHANNEL],
      sentence: 'Lists the settings and secrets {channel} needs; no value is shown.', example: { channel: 'slack' },
      operator: { method: 'channels.setup.get', fields: { surface: 'channel' } },
      async run(values, ctx) { return formatSetup(values.channel!, await h.invoke(ctx, 'channels.setup.get', { surface: values.channel! } as OperatorMethodInput<'channels.setup.get'>)); },
    }),
    readAction<Ctx>({
      id: 'doctor', label: 'Check a channel that isn\'t working', word: 'doctor', inputs: [CHANNEL],
      sentence: 'Runs the daemon\'s checks on {channel} and lists the repairs it offers; nothing is repaired.', example: { channel: 'slack' },
      operator: { method: 'channels.doctor.get', fields: { surface: 'channel' } },
      async run(values, ctx) { return formatDoctor(values.channel!, await h.invoke(ctx, 'channels.doctor.get', { surface: values.channel! } as OperatorMethodInput<'channels.doctor.get'>)); },
    }),
    doAction<Ctx>({
      id: 'test', label: 'Send a test message through a channel', word: 'test', inputs: [CHANNEL],
      sentence: 'The daemon sends a real test message through {channel} and reports whether it was delivered.',
      touches: 'another-machine', risk: 'sends-out', example: { channel: 'slack' },
      operator: { method: 'channels.test.send', fields: { surface: 'channel' } },
      async run(values, ctx) {
        const result = await h.invoke(ctx, 'channels.test.send', { surface: values.channel! } as OperatorMethodInput<'channels.test.send'>);
        return result.delivered
          ? `Delivered${result.responseId ? ` (response ${result.responseId})` : ''}${result.address ? ` to ${result.address}` : ''}.`
          : `Not delivered: ${result.error ?? 'the daemon gave no reason'}.`;
      },
    }),
    readAction<Ctx>({
      id: 'accounts', label: 'See the accounts behind your channels', word: 'accounts',
      sentence: 'Lists each channel account, whether it is configured, linked and signed in; no secret is shown.',
      operator: { method: 'channels.accounts.list', fields: {} },
      async run(_values, ctx) { return formatAccounts(await h.invoke(ctx, 'channels.accounts.list', {})); },
    }),
    readAction<Ctx>({
      id: 'rules', label: 'See who may reach the assistant', word: 'rules',
      inputs: [{ ...CHANNEL, required: { default: '', defaultMeans: 'every channel' } }],
      sentence: 'Shows the daemon\'s rules for who may write to the assistant on each channel, or on {channel}.', example: { channel: 'slack' },
      operator: { method: 'channels.policies.list', fields: {} },
      async run(values, ctx) {
        const { policies } = await h.invoke(ctx, 'channels.policies.list', {});
        const shown = values.channel ? policies.filter((policy) => policy.surface === values.channel) : policies;
        if (shown.length === 0) return values.channel ? `No rules are kept for ${values.channel}; it uses the defaults.` : 'No rules are kept; every channel uses the defaults.';
        return ['Who may reach the assistant:', ...shown.map((policy) => renderPolicy(policy, h.enabledInSettings?.(ctx, policy.surface)))].join('\n');
      },
    }),
    {
      id: 'set-rules', label: 'Change who may reach the assistant', word: 'set-rules',
      stepTitles: ['Which channel?', 'What is accepted', 'Who may write'],
      inputs: [
        { ...CHANNEL, step: 1 },
        { ...ruleSwitch('enabled', 'Accept messages', 'Whether messages on this channel are accepted at all', ON_OFF), step: 2 },
        { ...ruleSwitch('require-mention', 'Only when mentioned', 'Answer only messages that mention the assistant', ON_OFF), step: 2 },
        { ...ruleSwitch('commands-without-mention', 'Commands without a mention', 'Accept typed commands that do not mention the assistant', LOOSENING_ON), step: 2 },
        { ...ruleSwitch('allow-dms', 'Direct messages', 'Accept direct messages', LOOSENING_ON), step: 2 },
        { ...ruleSwitch('allow-groups', 'Group messages', 'Accept messages in groups', LOOSENING_ON), step: 2 },
        { ...ruleSwitch('allow-threads', 'Thread messages', 'Accept messages in threads', LOOSENING_ON), step: 2 },
        { ...ruleSwitch('dm-policy', 'Direct messages from others', 'Whether people not on the lists may write directly', CONVERSATION_POLICIES), step: 2 },
        { ...ruleSwitch('group-policy', 'Groups not on the list', 'Whether groups not on the lists may write', CONVERSATION_POLICIES), step: 2 },
        { ...ruleSwitch('open', 'Open to anyone', 'With no list set, anyone may write and no owner claim is raised', LOOSENING_ON), step: 3 },
        { ...ruleList('allow-users', 'Users', 'The users who may write'), step: 3 },
        { ...ruleList('allow-channels', 'Conversations', 'The conversations the assistant answers in'), step: 3 },
        { ...ruleList('allow-group-ids', 'Groups', 'The groups the assistant answers in'), step: 3 },
        { ...ruleList('allowed-commands', 'Commands', 'The commands people may type there'), step: 3 },
      ],
      sentence: 'Who may write to the assistant on {channel} changes to what you gave, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'loosens-a-protection',
      ownerOnly: { reason: 'it decides who may reach the assistant', instead: '/channels rules shows the rules in force' },
      operator: { method: 'channels.policies.update', fields: { surface: 'channel' } },
      example: { channel: 'slack', 'require-mention': 'on' },
      async run(values, ctx) {
        const fields = ruleFields(values);
        if (Object.keys(fields).length === 0) throw commandRefusal(`Nothing to change for ${values.channel}: give at least one rule.`, `/channels rules ${values.channel} shows the rules in force`);
        const policy = await h.invoke(ctx, 'channels.policies.update', { surface: values.channel!, ...fields } as PolicyUpdateInput);
        return `Changed.\n${renderPolicy(policy, h.enabledInSettings?.(ctx, policy.surface))}`;
      },
    },
    readAction<Ctx>({
      id: 'profiles', label: 'See channel profiles', word: 'profiles',
      sentence: 'Lists the model and permission mode each channel\'s sessions are given.',
      operator: { method: 'channels.profiles.list', fields: {} },
      async run(_values, ctx) {
        const { bindings } = await h.invoke(ctx, 'channels.profiles.list', {});
        return bindings.length === 0 ? 'No channel has its own profile; sessions get the host\'s defaults.' : ['Channel profiles:', ...bindings.map(renderProfileBinding)].join('\n');
      },
    }),
    readAction<Ctx>({
      id: 'profile', label: 'See what one channel\'s sessions get', word: 'profile', inputs: [PROFILE_CHANNEL, CHANNEL_ID],
      sentence: 'Shows the profile of {channel} and the model and permission mode its sessions get, with where each comes from.', example: { channel: 'slack' },
      operator: { method: 'channels.profiles.get', fields: { surfaceKind: 'channel', channelId: 'id' } },
      async run(values, ctx) {
        const { binding, effective } = await h.invoke(ctx, 'channels.profiles.get', profileTarget(values));
        return `${renderProfileBinding(binding)}\n${renderEffectiveProfile(effective)}`;
      },
    }),
    {
      id: 'set-profile', label: 'Give a channel its own model or permission mode', word: 'set-profile',
      inputs: [
        PROFILE_CHANNEL, CHANNEL_ID,
        textInput({ id: 'model', label: 'Model', help: 'The model its sessions use', why: 'a model id the host knows', typed: { flag: '--model' }, optional: UNCHANGED }),
        textInput({ id: 'provider', label: 'Provider', help: 'The provider of that model', why: 'a provider id the host knows', typed: { flag: '--provider' }, optional: UNCHANGED }),
        { id: 'mode', label: 'Permission mode', help: 'How its sessions ask before acting', kind: 'choice', choices: PERMISSION_MODES, required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--permission-mode' } },
      ],
      sentence: 'Sessions from {channel} get the model and permission mode you gave, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-profile',
      operator: { method: 'channels.profiles.set', fields: { surfaceKind: 'channel', channelId: 'id', model: 'model', provider: 'provider', permissionMode: 'mode' } },
      example: { channel: 'slack', mode: 'ask-me' },
      async run(values, ctx) {
        if (!values.model && !values.provider && !values.mode) throw commandRefusal(`Nothing to give ${values.channel}: name a model, a provider or a permission mode.`);
        // A set replaces the whole binding, so a field left blank ("unchanged") carries the bound value over.
        const target = profileTarget(values);
        const { bindings } = await h.invoke(ctx, 'channels.profiles.list', {});
        const bound = bindings.find((b) => b.surfaceKind === target.surfaceKind.trim().toLowerCase()
          && (b.channelId ?? '') === (target.channelId?.trim() ?? ''));
        // A model and its provider are one choice: a new model does not keep the old model's provider.
        const model = values.model || bound?.model;
        const provider = values.provider || (values.model ? undefined : bound?.provider);
        // A stored mode this build cannot use is not carried over; the set clears it.
        const mode = values.mode || (bound?.invalid ? undefined : bound?.permissionMode);
        const result = await h.invoke(ctx, 'channels.profiles.set', {
          ...target,
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(mode ? { permissionMode: mode as (typeof SESSION_GATE_PRESET_NAMES)[number] } : {}),
          ...(bound?.metadata ? { metadata: bound.metadata } : {}),
        });
        // A looser mode from a credential that is not the owner's is put to the owner (202 OWNER_APPROVAL_PENDING).
        if ('approvalId' in result) return ownerPendingText(result);
        return `Set.\n${renderProfileBinding(result.binding)}`;
      },
    },
    {
      id: 'remove-profile', label: 'Remove a channel\'s profile', word: 'remove-profile', inputs: [PROFILE_CHANNEL, CHANNEL_ID],
      sentence: 'Sessions from {channel} get the host\'s defaults again, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'set-profile',
      operator: { method: 'channels.profiles.delete', fields: { surfaceKind: 'channel', channelId: 'id' } },
      example: { channel: 'slack' },
      async run(values, ctx) {
        const result = await h.invoke(ctx, 'channels.profiles.delete', profileTarget(values));
        if (!('deleted' in result) || typeof result.deleted !== 'boolean') return ownerPendingText(result);
        const scope = `${values.channel}${values.id ? `:${values.id}` : ''}`;
        return result.deleted ? `Removed the profile of ${scope}.` : `${scope} had no profile; nothing changed.`;
      },
    },
    readAction<Ctx>({
      id: 'triage', label: 'See what came in on your channels', word: 'triage', inputs: [LIMIT('How many messages to show')],
      sentence: 'Lists the newest messages on your channels and what each needs.', example: { limit: '20' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return h.triage ? await h.triage(ctx, values.limit ?? '10') : missing('The channel inbox', AGENT_ONLY); },
    }),
    {
      id: 'send', label: 'Send a message to a channel', word: 'send',
      inputs: [
        textInput({ id: 'message', label: 'Message', help: 'What to send', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
        textInput({ id: 'channel', label: 'To', help: 'surface, surface:route, or "surface | label"; blank uses the default target', why: 'a channel and route', typed: { flag: '--channel' }, optional: { default: '', means: 'the default target' } }),
        textInput({ id: 'title', label: 'Title', help: 'A title above the message', why: 'your own words', typed: { flag: '--title' }, optional: { default: '', means: 'no title' } }),
        textInput({ id: 'route', label: 'Route', help: 'A route on that channel', why: 'a route id', typed: { flag: '--route' }, optional: { default: '', means: 'the channel\'s default' } }),
        { id: 'webhook', label: 'Webhook address', help: 'An incoming webhook address; it carries its token, so it is never shown', kind: 'secret', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--webhook' } },
        textInput({ id: 'link', label: 'Link', help: 'A link to send with it', why: 'a web address', typed: { flag: '--link' }, optional: { default: '', means: 'no link' } }),
      ],
      sentence: '"{message}" is sent to the channel you named, or to the default target.', done: '',
      touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
      operator: { terminalOnly: AGENT_ONLY },
      example: { message: 'Build is green', channel: 'slack' },
      async run(values, ctx) {
        if (!h.send) return missing('Sending to a channel', AGENT_ONLY);
        return await h.send(ctx, {
          message: values.message!,
          ...(values.channel ? { channel: values.channel } : {}), ...(values.title ? { title: values.title } : {}),
          ...(values.route ? { route: values.route } : {}), ...(values.webhook ? { webhook: values.webhook } : {}), ...(values.link ? { link: values.link } : {}),
        });
      },
    },
    readAction<Ctx>({
      id: 'deliveries', label: 'See what was sent to channels', word: 'deliveries', inputs: [LIMIT('How many sends to show')],
      sentence: 'Lists the newest confirmed sends and whether each was delivered.', example: { limit: '20' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return h.receipts ? h.receipts(ctx, values.limit ?? '10') : missing('Delivery receipts', AGENT_ONLY); },
    }),
    readAction<Ctx>({
      id: 'overview', label: 'See what the channels carry', word: 'overview',
      sentence: 'Shows the active route families, sessions, tasks, waiting approvals and remote contracts.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) { return h.overview ? h.overview(ctx) : missing('The channel overview', TERMINAL_ONLY); },
    }),
    readAction<Ctx>({
      id: 'routes', label: 'See the active routes', word: 'routes',
      sentence: 'Lists each active route binding of the channels.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) { return h.routes ? h.routes(ctx) : missing('The route snapshot', TERMINAL_ONLY); },
    }),
    readAction<Ctx>({
      id: 'delivery', label: 'See how outbound messages are delivered', word: 'delivery',
      sentence: 'Shows the outbound delivery snapshot of each channel.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) { return h.delivery ? h.delivery(ctx) : missing('The delivery snapshot', TERMINAL_ONLY); },
    }),
    doAction<Ctx>({
      id: 'open', label: 'Open the routes view', word: 'open',
      sentence: 'Opens the view of channel routes and the agents behind them.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) { if (!h.openView) return missing('The routes view', TERMINAL_ONLY); h.openView(ctx); return undefined; },
    }),
    doAction<Ctx>({
      id: 'telegram-cursor', label: 'Pick up Telegram where it left off', word: 'telegram-cursor',
      sentence: 'Shows the saved Telegram reading positions to review and bind one.',
      operator: { terminalOnly: 'it opens a review in the terminal' },
      async run(_values, ctx) { await h.telegramCursor(ctx); return undefined; },
    }),
  ];
  registry.register({
    ...defineCommand<Ctx>({
    // --yes answers the question only right after the action word: the same word inside a message is text.
    leadingFlagsOnly: true,
    name: 'channels',
    title: 'Channels',
    summary: 'Your channels (Slack, Telegram, ntfy, ...): their state and setup, who may reach the assistant, and what each one\'s sessions get',
    group: 'Channels',
    report: 'status',
    firstScreenRows: [
      'status',
      { label: 'Set up a channel…', actions: ['readiness', 'configured', 'guide', 'setup', 'accounts', 'doctor', 'test', 'telegram-cursor'] },
      { label: 'Choose who may reach the assistant…', actions: ['rules', 'set-rules'] },
      { label: 'Choose what a channel\'s sessions get…', actions: ['profiles', 'profile', 'set-profile', 'remove-profile'] },
      { label: 'Messages in and out…', actions: ['triage', 'send', 'deliveries'] },
      { label: 'Routes and delivery…', actions: ['overview', 'routes', 'delivery', 'open'] },
    ],
    actions,
  }) });
}
