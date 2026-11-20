import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { setupCommandDescription, type SetupRun, type SetupTopicId } from '@goodvibes/engine/terminal-shell/setup-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { OnboardingWizardTopic } from '../onboarding/onboarding-wizard-types.ts';
import { openOnboardingWizard } from './runtime-services.ts';
import { STARTUP_COMMAND } from './local-setup.ts';

/** The topics the terminal app opens as one form of its own (the former wizard pages). */
const FORM_TOPICS: readonly OnboardingWizardTopic[] = [
  'model', 'sign-in', 'store-key', 'local-only', 'browser', 'other-devices', 'webhooks', 'chat-apps', 'cloudflare',
  'who-signs-in', 'how-it-works', 'safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced',
];

const openForm = (topic: OnboardingWizardTopic): SetupRun<CommandContext> =>
  async (_values, ctx) => { openOnboardingWizard(ctx, { mode: 'edit', reset: true, topic }); };

/** `/setup` with its topics; the setup checks and transfers are `/startup` (local-setup.ts). */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>({
  runs: {
    ...Object.fromEntries(FORM_TOPICS.map((topic) => [topic, openForm(topic)])) as Partial<Record<SetupTopicId, SetupRun<CommandContext>>>,
    'add-provider': async (values, ctx) => { await ctx.executeCommand?.('provider', ['add', values.name!, values.url!]); },
    'history': async (_values, ctx) => { ctx.openSettingsModal?.('behavior.saveHistory'); },
    'first-run': async (_values, ctx) => {
      if (!ctx.openFirstRun) return 'First run is not available here.';
      ctx.openFirstRun();
    },
  },
  elsewhere: (id) => id === 'import-settings'
    ? 'Only the Agent keeps its own settings; the terminal app already uses these.'
    : `This is done in the Agent: run goodvibes-agent and type /setup ${id}.`,
  notes: { 'import-settings': 'Agent only', 'pair': 'Agent only', 'unpair': 'Agent only' },
}));

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
  registry.register(STARTUP_COMMAND);
}
