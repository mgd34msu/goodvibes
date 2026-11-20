import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { setupCommandDescription, type SetupTopicId } from '@goodvibes-jev/engine/terminal-shell/setup-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { OnboardingWizardTopic } from '../onboarding/onboarding-wizard-types.ts';
import { openOnboardingWizard } from './runtime-services.ts';
import { STARTUP_TOOL_ACTIONS, STARTUP_TOOL_ROWS } from './local-setup.ts';

/** The topics the terminal app opens as one form of its own (the former wizard pages). */
const FORM_TOPICS: readonly OnboardingWizardTopic[] = [
  'model', 'sign-in', 'store-key', 'local-only', 'browser', 'other-devices', 'webhooks', 'chat-apps', 'cloudflare',
  'who-signs-in', 'how-it-works', 'safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced',
];

function openForm(topic: OnboardingWizardTopic): (ctx: CommandContext) => Promise<void> {
  return async (ctx) => { openOnboardingWizard(ctx, { mode: 'edit', reset: true, topic }); };
}

/** `/setup` with its topics, plus the setup checks and transfers (local-setup.ts). */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>({
  topics: {
    ...Object.fromEntries(FORM_TOPICS.map((topic) => [topic, openForm(topic)])) as Partial<Record<SetupTopicId, (ctx: CommandContext) => Promise<void>>>,
    'add-provider': {
      inputs: [
        textInput({ id: 'name', label: 'Name', help: 'A short name for the provider: letters, numbers, - and _', why: 'A name you choose.', typed: { position: 1 } }),
        textInput({ id: 'url', label: 'Address', help: 'Its OpenAI-compatible address, ending in /v1', why: 'The address of a server you run or use.', typed: { position: 2 } }),
      ],
      sentence: 'The provider {name} at {url} is added, until you remove it with /provider remove {name}.',
      example: { name: 'my-server', url: 'http://192.168.0.85:8001/v1' },
      run: async (values, ctx) => { await ctx.executeCommand?.('provider', ['add', values.name!, values.url!]); },
    },
    'history': async (ctx) => { ctx.openSettingsModal?.('behavior.saveHistory'); },
    'import-settings': async () => 'Only the Agent keeps its own settings; the terminal app already uses these.',
    'first-run': async (ctx) => {
      if (!ctx.openFirstRun) return 'First run is not available here.';
      ctx.openFirstRun();
    },
  },
  topicNotes: { 'import-settings': 'Agent only' },
  extraActions: STARTUP_TOOL_ACTIONS,
  extraRows: STARTUP_TOOL_ROWS,
}));

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
}
