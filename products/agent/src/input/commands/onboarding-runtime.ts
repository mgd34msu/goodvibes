import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { setupCommandDescription, type SetupRun, type SetupTopicId } from '@goodvibes-jev/engine/terminal-shell/setup-command';
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

async function pair(values: Readonly<Record<string, string>>, ctx: CommandContext): Promise<void> {
  const apply = values.apply === 'apply';
  const name = values.name || 'GoodVibes Agent';
  if (apply && (!isDirectOwnerCommandContext(ctx, 'setup') || !ctx.beginSetupPairing)) {
    ctx.print('Pairing --apply requires the owner to type /setup pair --apply in the live Agent terminal. Model, harness and nested commands cannot grant persistent administrative access.');
    return;
  }
  if (isDirectOwnerCommandContext(ctx, 'setup') && ctx.beginSetupPairing) {
    await ctx.beginSetupPairing({ apply, name });
    return;
  }
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) { ctx.print('Pairing preview is unavailable without an Agent home.'); return; }
  const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory }, name);
  ctx.print(`${formatSetupPairing(preview.result)}\n  Preview only. The owner can type /setup pair --apply in the live Agent terminal to review and confirm.`);
}

async function unpair(_values: Readonly<Record<string, string>>, ctx: CommandContext): Promise<void> {
  // Forgetting the credential cuts this Agent off from the host: the owner's own keystrokes only.
  if (!isDirectOwnerCommandContext(ctx, 'setup')) {
    ctx.print('Unpairing requires the owner to type /setup unpair in the live Agent terminal. Nothing was forgotten.');
    return;
  }
  const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
  if (!homeDirectory) { ctx.print('Unpairing is unavailable without an Agent home. Nothing was forgotten.'); return; }
  ctx.print(formatSetupPairing(await unpairAgentHost({ configManager: ctx.platform.configManager, homeDirectory })));
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
    'pair': async (values, ctx) => { await pair(values, ctx); },
    'unpair': async (values, ctx) => { await unpair(values, ctx); },
  },
  // Network access, sign-in accounts and the runtime switches belong to the daemon the Agent connects to.
  elsewhere: (id, label) => `${label} is set where the daemon runs: run goodvibes setup there and choose it (/setup ${id}).`,
  notes: { 'local-only': 'on the daemon', 'browser': 'on the daemon', 'other-devices': 'on the daemon', 'webhooks': 'on the daemon',
    'cloudflare': 'on the daemon', 'who-signs-in': 'on the daemon', 'telemetry': 'on the daemon', 'provider-behaviour': 'on the daemon', 'advanced': 'on the daemon' },
}));

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
}
