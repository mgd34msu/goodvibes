import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, textInput, choiceInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { setupCommandDescription, type SetupTopicId } from '@goodvibes-jev/engine/terminal-shell/setup-command';
import { previewAgentHostPairing, unpairAgentHost } from '../../runtime/agent-host-pairing.ts';
import { formatSetupPairing } from '../../runtime/setup-pairing-presentation.ts';
import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { AGENT_SETUP_TOPIC_ROWS } from '../agent-workspace-categories.ts';

/** A topic opens the Agent's own forms for it: the setup rows of that topic, and nothing else. */
function openRows(topic: SetupTopicId): (ctx: CommandContext) => Promise<string | void> {
  return async (ctx) => {
    const rows = AGENT_SETUP_TOPIC_ROWS[topic];
    if (!rows || !ctx.openAgentSetupRows) return 'The Agent workspace is not available here.';
    ctx.openAgentSetupRows(rows);
  };
}

const OWNER_TYPED = { reason: 'It gives or takes this Agent\'s access to your GoodVibes host.', instead: 'The owner types it in the live Agent terminal.' };

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

/** `/setup` in the Agent: the topics its Start rows lived under, then pairing with a GoodVibes host. */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>({
  topics: {
    ...Object.fromEntries((Object.keys(AGENT_SETUP_TOPIC_ROWS) as SetupTopicId[]).map((topic) => [topic, openRows(topic)])),
    'chat-apps': async (ctx) => {
      if (!ctx.openAgentWorkspace) return 'The Agent workspace is not available here.';
      ctx.openAgentWorkspace('onboarding-channels');
    },
    'first-run': async (ctx) => {
      if (!ctx.openFirstRun) return 'First run is not available here.';
      ctx.openFirstRun();
    },
  },
  extraActions: [
    doAction<CommandContext>({
      id: 'pair', label: 'Pair with a GoodVibes host', word: 'pair', touches: 'another-machine',
      inputs: [
        textInput({ id: 'name', label: 'Name', help: 'What the host calls this Agent', why: 'A name you choose.', typed: { flag: '--name' }, optional: { default: 'GoodVibes Agent', means: 'GoodVibes Agent' } }),
        choiceInput({
          id: 'apply', label: 'Pair now', help: 'Pair now, or only see what pairing would do',
          choices: [{ value: 'preview', label: 'Only show what it would do' }, { value: 'apply', label: 'Pair now', risk: 'loosens-a-protection' }],
          typed: { flag: '--apply', switchOn: 'apply' }, optional: { default: 'preview', means: 'only show what it would do' },
        }),
      ],
      sentence: 'This Agent pairs with your GoodVibes host as {name}, after you confirm in this terminal.',
      example: {},
      ownerOnly: OWNER_TYPED,
      run: async (values, ctx) => { await pair(values, ctx); },
    }),
    doAction<CommandContext>({
      id: 'unpair', label: 'Unpair from the GoodVibes host', word: 'unpair', touches: 'credential',
      sentence: 'This Agent forgets its GoodVibes host credential and stops reaching that host.',
      ownerOnly: OWNER_TYPED,
      run: async (values, ctx) => { await unpair(values, ctx); },
    }),
  ],
  extraRows: [{ label: 'Pair with a GoodVibes host…', actions: ['pair', 'unpair'] }],
}));

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
}
