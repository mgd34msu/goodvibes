import { openTelegramCursorRecovery } from './telegram-cursor.ts';
import { isSettableGatePresetName, SESSION_GATE_PRESET_NAMES } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireIntegrationHelpers } from './runtime-services.ts';
import { PAIRABLE_SURFACES, runChannelPairing, surfaceEnabledInSettings } from './channel-pairing.ts';
import { parseDeclaredFlags, describeDeclaredFlags, type DeclaredFlags } from './declared-flags.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/platform';

type ChannelProfileBinding = OperatorMethodOutput<'channels.profiles.list'>['bindings'][number];
type ChannelPolicy = OperatorMethodOutput<'channels.policies.list'>['policies'][number];

const ON_OFF: Readonly<Record<string, boolean>> = { on: true, true: true, yes: true, off: false, false: false, no: false };
const CONVERSATION_POLICIES = ['allow', 'deny', 'inherit'] as const;
/** `/channel policy set` options and the daemon field each one writes. */
const POLICY_BOOLEAN_OPTIONS = {
  enabled: 'enabled',
  'require-mention': 'requireMention',
  'allow-dms': 'allowDirectMessages',
  'allow-groups': 'allowGroupMessages',
  'allow-threads': 'allowThreadMessages',
  'commands-without-mention': 'allowTextCommandsWithoutMention',
  open: 'open',
} as const;
const POLICY_CHOICE_OPTIONS = { 'dm-policy': 'dmPolicy', 'group-policy': 'groupPolicy' } as const;
const POLICY_LIST_OPTIONS = {
  'allow-users': 'allowlistUserIds',
  'allow-channels': 'allowlistChannelIds',
  'allow-group-ids': 'allowlistGroupIds',
  'allowed-commands': 'allowedCommands',
} as const;
const POLICY_SET_FLAGS: DeclaredFlags = {
  values: [...Object.keys(POLICY_BOOLEAN_OPTIONS), ...Object.keys(POLICY_CHOICE_OPTIONS), ...Object.keys(POLICY_LIST_OPTIONS)],
};
type PolicyUpdateInput = OperatorMethodInput<'channels.policies.update'>;
/** The rule fields one `/channel policy set` line writes, typed by the daemon method's own input. */
type PolicyUpdateFields = { -readonly [K in Exclude<keyof PolicyUpdateInput, 'surface'>]?: PolicyUpdateInput[K] };

/** Read `/channel policy set` options into daemon fields, refusing any value the daemon would not take. */
export function readPolicyUpdate(args: readonly string[]): { readonly ok: true; readonly fields: PolicyUpdateFields } | { readonly ok: false; readonly problem: string } {
  const parsed = parseDeclaredFlags(args, POLICY_SET_FLAGS);
  if (!parsed.ok) return parsed;
  if (parsed.positional.length > 0) return { ok: false, problem: `"${parsed.positional.join(' ')}" was not understood. Options: ${describeDeclaredFlags(POLICY_SET_FLAGS)}.` };
  const fields: PolicyUpdateFields = {};
  for (const [option, values] of parsed.flags) {
    const value = values[values.length - 1]!;
    if (option in POLICY_BOOLEAN_OPTIONS) {
      const on = ON_OFF[value.toLowerCase()];
      if (on === undefined) return { ok: false, problem: `--${option} takes on or off, not "${value}".` };
      fields[POLICY_BOOLEAN_OPTIONS[option as keyof typeof POLICY_BOOLEAN_OPTIONS]] = on;
    } else if (option in POLICY_CHOICE_OPTIONS) {
      if (!(CONVERSATION_POLICIES as readonly string[]).includes(value)) return { ok: false, problem: `--${option} takes ${CONVERSATION_POLICIES.join(', ')}, not "${value}".` };
      fields[POLICY_CHOICE_OPTIONS[option as keyof typeof POLICY_CHOICE_OPTIONS]] = value;
    } else {
      fields[POLICY_LIST_OPTIONS[option as keyof typeof POLICY_LIST_OPTIONS]] = value === 'none' ? [] : value.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return { ok: true, fields };
}

function describePolicyUpdate(fields: PolicyUpdateFields): string {
  return Object.entries(fields)
    .map(([field, value]) => `${field} → ${Array.isArray(value) ? (value.length > 0 ? value.join(', ') : '(empty)') : typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)}`)
    .join('; ');
}

function renderPolicy(policy: ChannelPolicy, enabledInSettings: boolean | undefined): string {
  const onOff = (value: boolean): string => (value ? 'on' : 'off');
  const list = (values: readonly string[]): string => (values.length > 0 ? values.join(', ') : 'anyone');
  const lines = [
    `  ${policy.surface}${enabledInSettings === undefined ? '' : `  (surface ${enabledInSettings ? 'enabled' : 'not enabled'} in settings)`}`,
    `    ingress: ${policy.enabled ? 'accepted' : 'refused'}; mention required: ${onOff(policy.requireMention)}; commands without mention: ${onOff(policy.allowTextCommandsWithoutMention)}`,
    `    direct messages: ${onOff(policy.allowDirectMessages)} (${policy.dmPolicy}); groups: ${onOff(policy.allowGroupMessages)} (${policy.groupPolicy}); threads: ${onOff(policy.allowThreadMessages)}`,
    `    users: ${list(policy.allowlistUserIds)}; channels: ${list(policy.allowlistChannelIds)}; groups: ${list(policy.allowlistGroupIds)}`,
    `    open (any sender admitted, no owner claim, while no list is set): ${onOff(policy.open === true)}`,
    `    commands: ${policy.allowedCommands.length > 0 ? policy.allowedCommands.join(', ') : 'all'}`,
  ];
  for (const group of policy.groupPolicies) {
    lines.push(`    group rule ${group.label ?? group.id}${group.groupId ? ` (group ${group.groupId})` : group.channelId ? ` (channel ${group.channelId})` : ''}`);
  }
  return lines.join('\n');
}

async function handleChannelPolicy(args: readonly string[], asJson: boolean, ctx: CommandContext): Promise<void> {
  const rpc = getOperatorRpc(ctx);
  if (args[0] === 'set') {
    const surface = args[1];
    const update = readPolicyUpdate(args.slice(2));
    if (!surface || (update.ok && Object.keys(update.fields).length === 0)) {
      ctx.print(`Usage: /channel policy set <surface> ${describeDeclaredFlags(POLICY_SET_FLAGS)}\n  on|off for switches, allow|deny|inherit for --dm-policy and --group-policy, a comma list or none for lists.`);
      return;
    }
    if (!update.ok) {
      ctx.print(`[channel policy set] ${update.problem} Nothing was changed.`);
      return;
    }
    if (!rpc.available) {
      ctx.print(`[channel policy set] Nothing was changed: ${rpc.reason}`);
      return;
    }
    try {
      const policy = await rpc.platformClient.operator.invoke('channels.policies.update', { surface, ...update.fields });
      ctx.print(asJson ? JSON.stringify(policy, null, 2) : `[channel policy set] ${surface} updated.\n${renderPolicy(policy, surfaceEnabledInSettings(ctx.platform.configManager, policy.surface))}`);
    } catch (error) {
      ctx.print(`[channel policy set] Nothing was changed: ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  const only = args[0];
  if (!rpc.available) {
    // The rules live in the daemon; without it only the surface switches from settings are known here.
    const enabled = PAIRABLE_SURFACES.filter((surface) => surfaceEnabledInSettings(ctx.platform.configManager, surface) === true);
    ctx.print(`[channel policy] The ingress rules come from the daemon, which is not reachable: ${rpc.reason}\n  Surfaces enabled in settings: ${enabled.length > 0 ? enabled.join(', ') : 'none'}.`);
    return;
  }
  try {
    const { policies } = await rpc.platformClient.operator.invoke('channels.policies.list', {});
    const shown = only ? policies.filter((policy) => policy.surface === only) : policies;
    if (asJson) {
      ctx.print(JSON.stringify(shown.map((policy) => ({ ...policy, enabledInSettings: surfaceEnabledInSettings(ctx.platform.configManager, policy.surface) ?? null })), null, 2));
      return;
    }
    if (shown.length === 0) {
      ctx.print(only
        ? `[channel policy] No ingress rules are stored for ${only}; it uses the defaults. Set them with /channel policy set ${only} ...`
        : '[channel policy] No ingress rules are stored; every surface uses the defaults. Set them with /channel policy set <surface> ...');
      return;
    }
    ctx.print(['Channel ingress rules:', ...shown.map((policy) => renderPolicy(policy, surfaceEnabledInSettings(ctx.platform.configManager, policy.surface)))].join('\n'));
  } catch (error) {
    ctx.print(`[channel policy] ${describeOperatorRpcError(error)}`);
  }
}

function renderProfileBinding(binding: ChannelProfileBinding): string {
  const scope = binding.channelId ? `${binding.surfaceKind}:${binding.channelId}` : `${binding.surfaceKind} (surface-wide default)`;
  const lines = [`  ${scope}`];
  if (binding.model) lines.push(`    model: ${binding.model}${binding.provider ? ` (${binding.provider})` : ''}`);
  if (binding.permissionMode) lines.push(`    permission mode: ${binding.permissionMode}`);
  if (binding.invalid) lines.push(`    needs attention: ${binding.invalid.reason}`);
  return lines.join('\n');
}

/** What a channel's sessions get, and which binding supplied each field. */
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

const PROFILE_FLAGS: readonly string[] = ['model', 'provider', 'permission-mode'];
const CHANNEL_PROFILES_SUBCOMMANDS = ['list', 'get', 'set', 'delete'] as const;

async function handleChannelProfilesSubcommand(args: string[], ctx: CommandContext): Promise<void> {
  const sub = args[0] ?? 'list';
  if (!(CHANNEL_PROFILES_SUBCOMMANDS as readonly string[]).includes(sub)) {
    ctx.print(
      'Usage: /channel profiles <subcommand>\n'
      + '  list                                    — every per-channel profile binding\n'
      + '  get <surfaceKind> [channelId]           — one binding\n'
      + '  set <surfaceKind> [channelId] [--model x] [--provider x] [--permission-mode x]  — bind (upsert)\n'
      + '  delete <surfaceKind> [channelId]        — remove a binding'
    );
    return;
  }

  if (sub === 'list') {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const { bindings } = await rpc.platformClient.operator.invoke('channels.profiles.list', {});
      if (bindings.length === 0) {
        ctx.print('[channel profiles] no profile bindings configured.');
        return;
      }
      ctx.print(['Channel profile bindings:', ...bindings.map(renderProfileBinding)].join('\n'));
    } catch (error) {
      ctx.print(`[channel profiles list] ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  if (sub === 'get') {
    const surfaceKind = args[1];
    const channelId = args[2];
    if (!surfaceKind) {
      ctx.print('Usage: /channel profiles get <surfaceKind> [channelId]');
      return;
    }
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const { binding, effective } = await rpc.platformClient.operator.invoke('channels.profiles.get', { surfaceKind, ...(channelId ? { channelId } : {}) });
      ctx.print(`${renderProfileBinding(binding)}\n${renderEffectiveProfile(effective)}`);
    } catch (error) {
      ctx.print(`[channel profiles get] ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  if (sub === 'set') {
    const rest = args.slice(1);
    const flagStart = rest.findIndex((token) => token.startsWith('--'));
    const positional = flagStart === -1 ? rest : rest.slice(0, flagStart);
    const flagTokens = flagStart === -1 ? [] : rest.slice(flagStart);
    const surfaceKind = positional[0];
    const channelId = positional[1];
    if (!surfaceKind) {
      ctx.print(`Usage: /channel profiles set <surfaceKind> [channelId] [--model x] [--provider x] [--permission-mode ${SESSION_GATE_PRESET_NAMES.join('|')}]`);
      return;
    }
    // An unknown option or one without a value would bind the wrong thing (`--model --provider x` as a model name).
    const parsedFlags = parseDeclaredFlags(flagTokens, { values: PROFILE_FLAGS });
    if (!parsedFlags.ok) {
      ctx.print(`[channel profiles set] ${parsedFlags.problem} Nothing was bound.`);
      return;
    }
    if (parsedFlags.positional.length > 0) {
      ctx.print(`[channel profiles set] "${parsedFlags.positional.join(' ')}" after the options was not understood; nothing was bound. Put <surfaceKind> [channelId] first.`);
      return;
    }
    const flags = new Map([...parsedFlags.flags].map(([name, values]) => [name, values[values.length - 1]!]));
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const permissionMode = flags.get('permission-mode');
      if (permissionMode !== undefined && !isSettableGatePresetName(permissionMode)) {
        throw new Error(`Permission mode must be one of: ${SESSION_GATE_PRESET_NAMES.join(', ')}`);
      }
      const { binding } = await rpc.platformClient.operator.invoke('channels.profiles.set', {
        surfaceKind,
        ...(channelId ? { channelId } : {}),
        ...(flags.has('model') ? { model: flags.get('model')! } : {}),
        ...(flags.has('provider') ? { provider: flags.get('provider')! } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
      ctx.print(`[channel profiles set] bound ${binding.id}\n${renderProfileBinding(binding)}`);
    } catch (error) {
      ctx.print(`[channel profiles set] ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  if (sub === 'delete') {
    const surfaceKind = args[1];
    const channelId = args[2];
    if (!surfaceKind) {
      ctx.print('Usage: /channel profiles delete <surfaceKind> [channelId]');
      return;
    }
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const result = await rpc.platformClient.operator.invoke('channels.profiles.delete', { surfaceKind, ...(channelId ? { channelId } : {}) });
      ctx.print(result.deleted
        ? `[channel profiles delete] removed binding for ${surfaceKind}${channelId ? `:${channelId}` : ''}.`
        : `[channel profiles delete] no binding found for ${surfaceKind}${channelId ? `:${channelId}` : ''}.`);
    } catch (error) {
      ctx.print(`[channel profiles delete] ${describeOperatorRpcError(error)}`);
    }
    return;
  }
}

export function registerChannelRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'channel',
    aliases: ['channels'],
    description: 'Pair channels and inspect routes, delivery strategies, ingress policies, and per-channel profile bindings',
    usage: '[pair [surface]|telegram-cursor|status|routes|delivery|policy [surface]|policy set <surface> [flags]|profiles [list|get|set|delete]] [--json]',
    argsHint: 'pair | telegram-cursor | status | routes | delivery | policy | profiles',
    subcommands: {
      pair: '[surface] [verify]', 'telegram-cursor': '', status: '[--json]', routes: '[--json]', delivery: '[--json]',
      policy: '[surface] | set <surface> [flags]', profiles: '[list|get|set|delete]',
    },
    confirm(args) {
      if (args[0] !== 'policy' || args[1] !== 'set' || !args[2]) return undefined;
      const update = readPolicyUpdate(args.slice(3).filter((arg) => arg !== '--json'));
      if (!update.ok || Object.keys(update.fields).length === 0) return undefined; // The handler refuses; nothing changes.
      return {
        title: `Change who may reach the assistant on ${args[2]}?`,
        detail: `The ${args[2]} ingress rules change: ${describePolicyUpdate(update.fields)}. /channel policy ${args[2]} shows the rules now in force.`,
        confirmLabel: 'Change',
      };
    },
    async handler(args, ctx) {
      const sub = args[0];
      const asJson = args.includes('--json');

      if (!sub || sub === 'open' || sub === 'panel') {
        ctx.openView?.('routes');
        return;
      }

      if (sub === 'telegram-cursor') { await openTelegramCursorRecovery(ctx); return; }

      if (sub === 'pair') {
        await runChannelPairing(args.slice(1), ctx);
        return;
      }

      if (sub === 'profiles') {
        await handleChannelProfilesSubcommand(args.slice(1), ctx);
        return;
      }

      const helpers = requireIntegrationHelpers(ctx);

      if (sub === 'status') {
        const review = helpers.buildReview();
        if (asJson) {
          ctx.print(JSON.stringify(review, null, 2));
          return;
        }
        const lines: string[] = [
          'Channel Status',
          `  routes:            ${review.routes.length}`,
          `  api families:      ${review.apiFamilies.join(', ') || '(none)'}`,
          `  sessions:          ${review.sessions}`,
          `  tasks:             ${review.tasks}`,
          `  pending approvals: ${review.pendingApprovals}`,
          `  remote contracts:  ${review.remoteContracts}`,
          '',
          `Active route families: ${review.routes.join(', ') || '(none)'}`,
          '',
          'Use /channel routes for delivery binding details.',
          'Use /channel delivery for outbound delivery snapshot.',
          'Use /channel policy for ingress policy snapshot.',
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'routes') {
        const snapshot = helpers.getRouteSnapshot();
        if (asJson) {
          ctx.print(JSON.stringify(snapshot, null, 2));
          return;
        }
        const entries = Object.entries(snapshot);
        if (entries.length === 0) {
          ctx.print('No route bindings active.\n\nRoutes become active when channel surfaces (slack, discord, ntfy, webhook, etc.) are configured and the daemon is running.');
          return;
        }
        const lines: string[] = ['Channel Routes'];
        for (const [key, value] of entries) {
          lines.push(`  ${String(key).padEnd(28)} ${JSON.stringify(value)}`);
        }
        lines.push('');
        lines.push('Route bindings reflect active daemon surface registrations.');
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'delivery') {
        const snapshot = helpers.getDeliverySnapshot();
        if (asJson) {
          ctx.print(JSON.stringify(snapshot, null, 2));
          return;
        }
        const entries = Object.entries(snapshot);
        if (entries.length === 0) {
          ctx.print('No delivery snapshot available.\n\nDelivery state is populated when the daemon handles outbound channel messages.');
          return;
        }
        const lines: string[] = ['Channel Delivery Snapshot'];
        for (const [key, value] of entries) {
          lines.push(`  ${String(key).padEnd(28)} ${JSON.stringify(value)}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'policy') {
        await handleChannelPolicy(args.slice(1).filter((arg) => arg !== '--json'), asJson, ctx);
        return;
      }

      ctx.print(
        'Usage: /channel <subcommand>\n'
        + '  (no args)  — open Agents (where routes live now)\n'
        + '  telegram-cursor — review and bind a previous saved Telegram cursor\n'
        + '  pair [surface] — guided channel pairing: list adapters, enter declared credentials, verify\n'
        + '  status     — channel overview: routes, sessions, tasks, pending approvals\n'
        + '  routes     — active route binding snapshot\n'
        + '  delivery   — outbound delivery snapshot\n'
        + '  policy [surface]  — who may reach the assistant on each surface (the daemon\'s ingress rules)\n'
        + '  policy set <surface> [--enabled on|off] [--require-mention on|off] [--dm-policy allow|deny|inherit] [--open on|off] ...  — change them (asks first)\n'
        + '             --open on makes a shared channel: with no list set, anyone may write and no owner claim is raised\n'
        + '  profiles [list|get|set|delete]  — per-channel model/permission profile bindings\n'
        + '\n'
        + 'Options:\n'
        + '  --json  Output raw JSON for scripting'
      );
    },
  });
}
