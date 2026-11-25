import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import {
  setupCommandDescription, setupPlaceHooks, setupSkipFile,
  type SetupCommandOptions, type SetupPlaceHooks, type SetupRun, type SetupTopicId, type WhoDecidesState,
} from '@goodvibes/engine/terminal-shell/setup-command';
import { firstRunDecisionModel } from '@goodvibes/engine/terminal-shell/first-run';
import { gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { readWhoDecidesAsked } from '../../runtime/onboarding/markers.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { previewAgentHostPairing, unpairAgentHost } from '../../runtime/agent-host-pairing.ts';
import { formatSetupPairing } from '../../runtime/setup-pairing-presentation.ts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { AGENT_SETUP_TOPIC_ROWS } from '../agent-workspace-categories.ts';
import { runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { capabilityBinding } from './capability-binding.ts';

/** A topic opens the Agent's own forms for it: the setup rows of that topic, and nothing else. */
function openRows(topic: SetupTopicId): SetupRun<CommandContext> {
  return async (_values, ctx) => {
    const rows = (AGENT_SETUP_TOPIC_ROWS as Readonly<Partial<Record<SetupTopicId, readonly string[]>>>)[topic];
    if (!rows || !ctx.openAgentSetupRows) return 'The Agent workspace is not available here.';
    ctx.openAgentSetupRows(rows);
  };
}

/**
 * Pair this Agent with its connected host: `/setup pair` and the Devices and
 * network place's Pair something (`command` 'devices', `owner` the place's
 * press, which is the owner's own). Asked by the owner, it is one step: what
 * pairing allows is shown, then the confirmation is asked for right there
 * (`--apply` is accepted and changes nothing here; it is what a script passes
 * to the CLI). Anything else (a model, a nested command) gets only the summary.
 */
export async function runAgentHostPair(ctx: CommandContext, request: { readonly apply: boolean; readonly name: string }, command: string, owner?: boolean): Promise<string | void> {
  const name = request.name || 'GoodVibes Agent';
  const typed = command === 'devices' ? 'Pair something in the Devices and network place' : 'type /setup pair';
  if ((owner ?? isDirectOwnerCommandContext(ctx, command)) && ctx.beginSetupPairing) {
    await ctx.beginSetupPairing({ apply: true, name });
    return;
  }
  if (request.apply) {
    return `Only you can pair this Agent: ${typed} in the Agent's own terminal. A model or another command cannot give lasting administrator access to the host.`;
  }
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'Pairing is not available without an Agent home.';
  const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory }, name);
  return `${formatSetupPairing(preview.result)}\n  Nothing was created. To pair, ${typed} in the Agent's own terminal and confirm there.`;
}

/** How this Agent reaches its connected host: the pairing preview, read-only. */
export async function readAgentHostPairingStatus(ctx: CommandContext): Promise<string> {
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'Host pairing is not available without an Agent home.';
  const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory });
  return formatSetupPairing(preview.result);
}

/** Forget this Agent's device credential for its connected host: `/setup unpair` and the Devices and network place. */
export async function runAgentHostUnpair(ctx: CommandContext, command: string, owner?: boolean): Promise<string> {
  // Forgetting the credential cuts this Agent off from the host: the owner's own keystrokes or press only.
  if (!(owner ?? isDirectOwnerCommandContext(ctx, command))) {
    return command === 'devices'
      ? 'Only you can unpair this Agent, from the Devices and network place in its own terminal. Nothing was forgotten.'
      : `Only you can unpair this Agent: type /${command} in the Agent's own terminal. Nothing was forgotten.`;
  }
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'Unpairing is not available without an Agent home. Nothing was forgotten.';
  return formatSetupPairing(await unpairAgentHost({ configManager: ctx.platform.configManager, homeDirectory }));
}

/** Topics the Agent sets up in one of its workspace areas. */
const AGENT_TOPIC_AREAS: Partial<Record<SetupTopicId, string>> = {
  'chat-apps': 'onboarding-channels',
  'how-it-works': 'assistant-behavior',
  'safety': 'tools-permissions',
  'memory': 'onboarding-context',
  'devices-voice': 'onboarding-voice-media',
  'automation': 'onboarding-automation',
};

function openArea(categoryId: string): SetupRun<CommandContext> {
  return async (_values, ctx) => {
    if (!ctx.openAgentWorkspace) return 'The Agent workspace is not available here.';
    ctx.openAgentWorkspace(categoryId);
  };
}

/**
 * First run's "Who decides" on the checklist: not done while the mode lets a
 * decision model decide and none can be asked (put off at first run, or never
 * answered); done once Ask me is chosen or a decision model answers.
 */
async function whoDecides(ctx: CommandContext): Promise<WhoDecidesState> {
  const config = ctx.platform.configManager;
  const needed = await firstRunDecisionModel(config, requireSecretsManager(ctx)).needsChoice();
  const mode = String(config.get('permissions.mode') ?? '');
  if (!needed) return { done: true, note: mode === 'jev-decides' || mode === 'just-vibes' ? `${gatePresetLabel(mode)}: a decision model answers` : `${gatePresetLabel(mode)}: GoodVibes asks you` };
  const shellPaths = ctx.workspace?.shellPaths;
  const putOff = shellPaths ? readWhoDecidesAsked(shellPaths) : false;
  return { done: false, note: putOff ? 'put off at first run: no decision model can be asked yet' : 'not chosen yet: no decision model can be asked' };
}

const SETUP_OPTIONS: SetupCommandOptions<CommandContext> = {
  runs: {
    ...Object.fromEntries((Object.keys(AGENT_SETUP_TOPIC_ROWS) as SetupTopicId[]).map((topic) => [topic, openRows(topic)])),
    ...Object.fromEntries(Object.entries(AGENT_TOPIC_AREAS).map(([topic, area]) => [topic, openArea(area!)])),
    // Signing in and providers of your own are the daemon's (capabilities/builtin/models.ts): Models and providers holds their controls.
    'sign-in': async (_values, ctx) => {
      if (!ctx.openPlace) return 'Models and providers is not available here.';
      ctx.openPlace('models');
    },
    'add-provider': async (values, ctx) => {
      const answer = await runDaemonCapability('provider.add', { name: values.name!, address: values.url! }, ctx, capabilityBinding);
      if (answer.detail ?? answer.text) ctx.print(answer.detail ?? answer.text ?? '');
    },
    'first-run': async (_values, ctx) => {
      if (!ctx.openFirstRun) return 'First run is not available here.';
      ctx.openFirstRun();
    },
    'pair': async (values, ctx) => {
      const text = await runAgentHostPair(ctx, { apply: values.apply === 'apply', name: values.name ?? '' }, 'setup');
      if (text) ctx.print(text);
    },
    'unpair': async (_values, ctx) => { ctx.print(await runAgentHostUnpair(ctx, 'setup')); },
  },
  // Network access, sign-in accounts and the runtime switches belong to the daemon the Agent connects to.
  elsewhere: (id, label) => `${label} is set where the daemon runs: run goodvibes setup there and choose it (/setup ${id}).`,
  notes: { 'local-only': 'on the daemon', 'browser': 'on the daemon', 'other-devices': 'on the daemon', 'webhooks': 'on the daemon',
    'cloudflare': 'on the daemon', 'who-signs-in': 'on the daemon', 'telemetry': 'on the daemon', 'provider-behaviour': 'on the daemon', 'advanced': 'on the daemon' },
  // The same checklist as the terminal app: done marks, `N of M set up` first, and Skip for now.
  settings: (ctx) => ctx.platform.configManager,
  skipped: setupSkipFile<CommandContext>((ctx) => ctx.workspace?.shellPaths?.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'setup-skipped.json')),
  whoDecides,
};

/** `/setup` in the Agent: the same topics as the terminal app, each opening the Agent's own rows for it. */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>(SETUP_OPTIONS));

/** The System place's Setup list over the Agent's `/setup`, its settings and its "Who decides" record. */
export function setupPlace(ctx: CommandContext): SetupPlaceHooks {
  return setupPlaceHooks(SETUP_OPTIONS, ctx, {
    openWhoDecides: () => ctx.openWhoDecides?.() ?? Promise.resolve(false),
    onSettingsChange: (listener) => ctx.platform.configManager.onDidChangeIncarnation(listener),
  });
}

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
}
