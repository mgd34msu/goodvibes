import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { setupCommandDescription, setupSkipFile, type SetupRun, type SetupTopicId } from '@goodvibes/engine/terminal-shell/setup-command';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { previewAgentHostPairing, unpairAgentHost } from '../../runtime/agent-host-pairing.ts';
import { formatSetupPairing } from '../../runtime/setup-pairing-presentation.ts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { AGENT_SETUP_TOPIC_ROWS } from '../agent-workspace-categories.ts';

/** A topic opens the Agent's own forms for it: the setup rows of that topic, and nothing else. */
function openRows(topic: SetupTopicId): SetupRun<CommandContext> {
  return async (_values, ctx) => {
    const rows = (AGENT_SETUP_TOPIC_ROWS as Readonly<Partial<Record<SetupTopicId, readonly string[]>>>)[topic];
    if (!rows || !ctx.openAgentSetupRows) return 'The Agent workspace is not available here.';
    ctx.openAgentSetupRows(rows);
  };
}

/**
 * Pair this Agent with its connected host: `/setup pair` and `/devices pair host`.
 * Typed by the owner in the live terminal, it is one step: what pairing allows
 * is shown, then the confirmation is asked for right there (`--apply` is
 * accepted and changes nothing here; it is what a script passes to the CLI).
 * Anything else (a model, a nested command) gets only the summary as text.
 */
export async function runAgentHostPair(ctx: CommandContext, request: { readonly apply: boolean; readonly name: string }, command: string): Promise<string | void> {
  const name = request.name || 'GoodVibes Agent';
  const typed = command === 'devices' ? '/devices pair host' : '/setup pair';
  if (isDirectOwnerCommandContext(ctx, command) && ctx.beginSetupPairing) {
    await ctx.beginSetupPairing({ apply: true, name });
    return;
  }
  if (request.apply) {
    return `Only you can pair this Agent: type ${typed} in the Agent's own terminal. A model or another command cannot give lasting administrator access to the host.`;
  }
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'Pairing is not available without an Agent home.';
  const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory }, name);
  return `${formatSetupPairing(preview.result)}\n  Nothing was created. To pair, type ${typed} in the Agent's own terminal and confirm there.`;
}

/** How this Agent reaches its connected host: the pairing preview, read-only. */
export async function readAgentHostPairingStatus(ctx: CommandContext): Promise<string> {
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) return 'Host pairing is not available without an Agent home.';
  const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory });
  return formatSetupPairing(preview.result);
}

/** Forget this Agent's device credential for its connected host: `/setup unpair` and `/devices unpair-host`. */
export async function runAgentHostUnpair(ctx: CommandContext, command: string): Promise<string> {
  // Forgetting the credential cuts this Agent off from the host: the owner's own keystrokes only.
  if (!isDirectOwnerCommandContext(ctx, command)) {
    return `Only you can unpair this Agent: type /${command} in the Agent's own terminal. Nothing was forgotten.`;
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

/** `/setup` in the Agent: the same topics as the terminal app, each opening the Agent's own rows for it. */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>({
  runs: {
    ...Object.fromEntries((Object.keys(AGENT_SETUP_TOPIC_ROWS) as SetupTopicId[]).map((topic) => [topic, openRows(topic)])),
    ...Object.fromEntries(Object.entries(AGENT_TOPIC_AREAS).map(([topic, area]) => [topic, openArea(area!)])),
    'add-provider': async (values, ctx) => { await ctx.executeCommand?.('provider', ['add', values.name!, values.url!]); },
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
}));

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
}
