import {
  daemonSetupSkips, setupPlaceHooks, setupTopicOf,
  type SetupCommandOptions, type SetupPlaceHooks, type SetupRun, type SetupTopicId, type WhoDecidesState,
} from '@goodvibes/engine/terminal-shell/setup-command';
import { firstRunDecisionModel, whoDecidesOnChecklist } from '@goodvibes/engine/terminal-shell/first-run';
import { readSetupState } from '@goodvibes/engine/platform/platform/capabilities';
import { systemSessionOf } from './session-capabilities.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { unpairAgentHost } from '../../runtime/agent-host-pairing.ts';
import { resolveConnectedHost } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-client';
import { inspectCliExternalRuntime } from '../../cli/external-runtime.ts';
import { formatSetupPairing } from '../../runtime/setup-pairing-presentation.ts';
import { isDirectOwnerCommandContext, type CommandContext } from '../command-registry.ts';
import { getFeatureSetting } from '@goodvibes/engine/terminal-shell';
import { runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { capabilityBinding } from './capability-binding.ts';

/**
 * Topics that are settings, each opened on the settings screen where they are (the one settings screen both programs
 * show): a setting by key, or a section by its namespace. The terminal app's forms for these write the same settings.
 */
const SETTINGS_TOPICS: Partial<Record<SetupTopicId, () => string>> = {
  'connect-daemon': () => 'daemon.connectedHost.url',
  'history': () => 'behavior.saveHistory',
  'how-it-works': () => 'behavior',
  'chat-apps': () => 'surfaces',
  'automation': () => 'automation',
  'telemetry': () => 'telemetry',
  // The switch of the topic's first feature (the terminal app's form for the topic starts with it; `memory.*` is the
  // process's memory budget, not this topic).
  'memory': () => getFeatureSetting('session-compaction')?.enablement.key ?? 'behavior.compactionStrategy',
  'provider-behaviour': () => getFeatureSetting('provider-optimizer')?.enablement.key ?? 'provider',
  'advanced': () => getFeatureSetting('unified-runtime-task')?.enablement.key ?? 'runtime',
};

/** Open the settings screen on a topic's settings. */
function openSettingsAt(where: () => string): SetupRun<CommandContext> {
  return async (_values, ctx) => {
    if (!ctx.openSettingsModal) return 'The settings screen cannot be shown here.';
    ctx.openSettingsModal(where());
  };
}

/** "Choose a model": the model picker `/model` opens (its other tabs choose the models for side jobs). */
const openModelPicker: SetupRun<CommandContext> = async (_values, ctx) => {
  if (!ctx.openModelPicker) return 'The model picker cannot be shown here.';
  ctx.openModelPicker();
};

/**
 * "Import settings": the row pressed is the request. The daemon's settings.copy-from-terminal-app (it holds both
 * programs' settings) copies what the terminal app has set and the Agent holds differently; the answer says what.
 */
const importTerminalSettings: SetupRun<CommandContext> = async (_values, ctx) => {
  const answer = await runDaemonCapability('settings.copy-from-terminal-app', {}, ctx, capabilityBinding);
  return answer.detail ?? answer.text ?? '';
};

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

/** Forget this Agent's device credential for its connected host: the Devices and network place (and the Setup list's row). */
export async function runAgentHostUnpair(ctx: CommandContext, command: string, owner?: boolean): Promise<string> {
  // Forgetting the credential cuts this Agent off from the host: the owner's own press only.
  if (!(owner ?? isDirectOwnerCommandContext(ctx, command))) {
    return 'Only you can unpair this Agent, from the Devices and network place in its own terminal. Nothing was forgotten.';
  }
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'Unpairing is not available without an Agent home. Nothing was forgotten.';
  return formatSetupPairing(await unpairAgentHost({ configManager: ctx.platform.configManager, homeDirectory }));
}

/**
 * Topics that are the daemon's settings, each opened on the tab whose rows change them through the daemon: the
 * addresses and switches of Devices and network (settings.set), its Cloudflare tab, and Permissions and safety's
 * Sign-in list (local-auth.add and the rest).
 */
const DAEMON_TOPIC_TABS: Partial<Record<SetupTopicId, { readonly place: string; readonly list: string }>> = {
  'cloudflare': { place: 'devices', list: 'cloudflare' },
  // A provider's key is stored on the Secrets tab (`n`), the secret store's one control.
  'store-key': { place: 'safety', list: 'secrets' },
  // What a paired phone may be asked to do, and speaking and listening: the daemon's settings for them.
  'devices-voice': { place: 'devices', list: 'phone-settings' },
};

/** Open a place on one tab, on top of what is open. */
function openTab(place: string, list: string): SetupRun<CommandContext> {
  return async (_values, ctx) => {
    if (!ctx.openPlace) return 'The menu\'s places cannot be shown here.';
    ctx.openPlace(place, { list });
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
  program: 'agent',
  runs: {
    ...Object.fromEntries((Object.entries(SETTINGS_TOPICS) as [SetupTopicId, () => string][]).map(([topic, where]) => [topic, openSettingsAt(where)])),
    'model': openModelPicker,
    'import-settings': importTerminalSettings,
    // Signing in and providers of your own are the daemon's (capabilities/builtin/models.ts): Models and providers holds their controls.
    'sign-in': async (_values, ctx) => {
      if (!ctx.openPlace) return 'Models and providers is not available here.';
      ctx.openPlace('models');
    },
    // The daemon's own settings, changed through the daemon (its settings.set and local-auth capabilities) on the tab
    // that holds them, as the terminal app's forms change them through it.
    ...Object.fromEntries((Object.entries(DAEMON_TOPIC_TABS) as [SetupTopicId, { place: string; list: string }][])
      .map(([topic, tab]) => [topic, openTab(tab.place, tab.list)])),
    'first-run': async (_values, ctx) => {
      if (!ctx.openFirstRun) return 'First run is not available here.';
      ctx.openFirstRun();
    },
  },
  // Pairing with the host and forgetting it are Devices and network's capabilities; the Setup list shows them too.
  pairsWithHost: true,
  // Every topic of the Setup list has a run above; a provider of your own is Models and providers' own control.
  elsewhere: (_id, label) => `"${label}" is in Models and providers: open the menu (Ctrl+G, then m), then Models and providers, and press n.`,
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

/** The System place's Setup list over the Agent's setup topics, its settings and its "Who decides" record. */
export function setupPlace(ctx: CommandContext): SetupPlaceHooks {
  return setupPlaceHooks(SETUP_OPTIONS, ctx, {
    // The row is the person coming to choose: "Who decides" opens whatever is in force.
    openWhoDecides: () => ctx.openWhoDecides?.({ always: true }) ?? Promise.resolve(false),
    openPlace: (place, list) => { if (!ctx.openPlace) return false; ctx.openPlace(place, { list }); return true; },
    onSettingsChange: (listener) => ctx.platform.configManager.onDidChangeIncarnation(listener),
  });
}
