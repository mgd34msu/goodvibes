import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import {
  daemonSetupSkips, setupCommandDescription, setupPlaceHooks, setupTopicOf,
  type SetupCommandOptions, type SetupPlaceHooks, type SetupRun, type SetupTopicId, type WhoDecidesState,
} from '@goodvibes/engine/terminal-shell/setup-command';
import { firstRunDecisionModel, whoDecidesOnChecklist } from '@goodvibes/engine/terminal-shell/first-run';
import { readSetupState } from '@goodvibes/engine/platform/platform/capabilities';
import { systemSessionOf } from './session-capabilities.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { previewAgentHostPairing, unpairAgentHost } from '../../runtime/agent-host-pairing.ts';
import { resolveConnectedHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { inspectCliExternalRuntime } from '../../cli/external-runtime.ts';
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

/**
 * How this Agent reaches its daemon, as it stands now: the address it dials, the credential it presents (a key of its
 * own from pairing, the host's operator token, or one from the environment) and whether the daemon answers. Read only:
 * nothing is sent but one status read, and nothing is created.
 */
export async function readAgentHostPairingStatus(ctx: CommandContext): Promise<string> {
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'This Agent has no home folder here, so how it connects cannot be read.';
  const configManager = ctx.platform.configManager;
  const connection = resolveConnectedHost({ configManager, homeDirectory });
  if (connection.unavailable && connection.token === null && !connection.source) {
    return `This Agent does not reach a daemon: ${connection.unavailable.reason}. ${connection.unavailable.next[0] ?? ''}`.trim();
  }
  const lines = [`This Agent reaches its daemon at ${connection.baseUrl}.`];
  const where = displayPath(connection.credential, homeDirectory);
  if (connection.token) {
    lines.push(connection.source === 'pairing'
      ? 'It signs in with a key of its own, made when it was paired with this host.'
      : connection.source === 'environment'
        ? `It signs in with the token in ${where.replace(/^env:/, '')}; it holds no key of its own.`
        : `It signs in with the host's operator token (${where}); it holds no key of its own.`);
  } else {
    lines.push(`It has no credential it can use: ${connection.unavailable?.reason ?? 'none was found'}.`);
  }
  const runtime = await inspectCliExternalRuntime({ configManager, homeDirectory, timeoutMs: STATUS_READ_MS });
  lines.push(runtime.reachable
    ? `The daemon answered just now${runtime.compatible ? '' : ', but some of the routes this Agent uses are missing there (an older GoodVibes)'}.`
    : `The daemon did not answer: ${runtime.error ?? `nothing at ${runtime.baseUrl}`}.`);
  return lines.join('\n');
}

/** How long the one status read may take before the daemon counts as not answering (as the host status read). */
const STATUS_READ_MS = 1500;

/** A path under the home folder as `~/...`. */
function displayPath(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
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
  'memory': 'onboarding-context',
  'devices-voice': 'onboarding-voice-media',
  // The Schedules area holds the automation settings (agent-workspace-categories.ts `automation`).
  'automation': 'automation',
};

/** The channels set up, by their settings (`surfaces.<channel>.enabled`), to say what a form set up. */
function enabledChannels(ctx: CommandContext): ReadonlyMap<string, string> {
  let surfaces: unknown;
  try { surfaces = (ctx.platform.configManager as { getCategory(category: string): unknown }).getCategory('surfaces'); } catch { surfaces = undefined; }
  const out = new Map<string, string>();
  if (surfaces === null || typeof surfaces !== 'object') return out;
  for (const [name, value] of Object.entries(surfaces as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') out.set(name, JSON.stringify(value));
  }
  return out;
}

/**
 * A workspace area opens on top of what is open (a place included); the run ends when it closes, and its line says
 * what was set up, so a place says nothing until then.
 */
function openArea(categoryId: string): SetupRun<CommandContext> {
  return async (_values, ctx) => {
    if (!ctx.openAgentWorkspace) return 'The Agent workspace is not available here.';
    const config = ctx.platform.configManager as { getConfigurationIncarnation?(): number };
    const before = config.getConfigurationIncarnation?.();
    const channelsBefore = enabledChannels(ctx);
    await ctx.openAgentWorkspace(categoryId);
    if (categoryId === 'onboarding-channels') {
      const after = enabledChannels(ctx);
      const changed = [...after.keys()].filter((name) => after.get(name) !== channelsBefore.get(name));
      return changed.length > 0 ? `Set up: ${changed.join(', ')}.` : 'The form was left; no channel was set up.';
    }
    return config.getConfigurationIncarnation?.() !== before ? 'Your changes were saved.' : 'The form was left; nothing was set up.';
  };
}

/**
 * First run's "Who decides" on the checklist: not done until the person chooses (first run never asks
 * it); its note names the mode in force (terminal-shell first-run whoDecidesOnChecklist). The record is
 * the daemon's one setup record (capabilities/builtin/system-setup.ts), the same in either program.
 */
async function whoDecides(ctx: CommandContext): Promise<WhoDecidesState> {
  const config = ctx.platform.configManager;
  const shellPaths = ctx.workspace?.shellPaths;
  const record = shellPaths ? readSetupState(shellPaths.homeDirectory).whoDecides : null;
  return whoDecidesOnChecklist(firstRunDecisionModel(config, requireSecretsManager(ctx)), config, record);
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
    // Safety and sandboxing is the Permissions and safety place (terminal-shell places/safety-place.ts), on its sandbox setting.
    'safety': async (_values, ctx) => {
      if (!ctx.openPlace) return 'Permissions and safety is not available here.';
      ctx.openPlace('safety', { list: 'sandbox-setting' });
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
  // Skipped for now: the daemon's one setup record, the same in both programs.
  skipped: daemonSetupSkips<CommandContext>((ctx) => ctx.workspace?.shellPaths?.homeDirectory, capabilityBinding),
  whoDecides,
  // Each topic is the capability setup.<topic>, run with the Agent's services (session-capabilities.ts `setupTopic`).
  services: (ctx) => ({ systemSession: systemSessionOf(ctx) }),
};

/** The Agent's setup rows, as the capabilities `setup.<topic>` open them. */
export function setupTopicsOf(ctx: CommandContext): (topic: string) => Promise<string | void> {
  return setupTopicOf(SETUP_OPTIONS, ctx);
}

/** `/setup` in the Agent: the same topics as the terminal app, each opening the Agent's own rows for it. */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>(SETUP_OPTIONS));

/** The System place's Setup list over the Agent's `/setup`, its settings and its "Who decides" record. */
export function setupPlace(ctx: CommandContext): SetupPlaceHooks {
  return setupPlaceHooks(SETUP_OPTIONS, ctx, {
    // The row is the person coming to choose: "Who decides" opens whatever is in force.
    openWhoDecides: () => ctx.openWhoDecides?.({ always: true }) ?? Promise.resolve(false),
    onSettingsChange: (listener) => ctx.platform.configManager.onDidChangeIncarnation(listener),
  });
}

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
}
