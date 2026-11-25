import { defineCommand, runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { capabilityBinding } from './capability-binding.ts';
import {
  setupCommandDescription, setupPlaceHooks, setupSkipFile,
  type SetupCommandOptions, type SetupPlaceHooks, type SetupRun, type SetupTopicId, type WhoDecidesState,
} from '@goodvibes/engine/terminal-shell/setup-command';
import { firstRunDecisionModel } from '@goodvibes/engine/terminal-shell/first-run';
import { gatePresetLabel } from '@goodvibes/engine/platform/platform/gate/presets';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { OnboardingWizardTopic } from '../onboarding/onboarding-wizard-types.ts';
import { openOnboardingWizard, requireSecretsManager } from './runtime-services.ts';
import { STARTUP_COMMAND } from './local-setup.ts';
import { readWhoDecidesAsked } from '../../runtime/onboarding/index.ts';

/** The topics the terminal app opens as one form of its own (the former wizard pages). */
const FORM_TOPICS: readonly OnboardingWizardTopic[] = [
  'model', 'sign-in', 'store-key', 'local-only', 'browser', 'other-devices', 'connect-daemon', 'webhooks', 'chat-apps', 'cloudflare',
  'who-signs-in', 'how-it-works', 'safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced',
];

const openForm = (topic: OnboardingWizardTopic): SetupRun<CommandContext> =>
  async (_values, ctx) => { openOnboardingWizard(ctx, { mode: 'edit', reset: true, topic }); };

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
    ...Object.fromEntries(FORM_TOPICS.map((topic) => [topic, openForm(topic)])) as Partial<Record<SetupTopicId, SetupRun<CommandContext>>>,
    // A provider of your own is the daemon's (capabilities/builtin/models.ts provider.add), run there as your request.
    'add-provider': async (values, ctx) => {
      const answer = await runDaemonCapability('provider.add', { name: values.name!, address: values.url! }, ctx, capabilityBinding);
      if (answer.detail ?? answer.text) ctx.print(answer.detail ?? answer.text ?? '');
    },
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
  // The checklist: done marks beside each recommended topic, `N of M set up` first, and Skip for now.
  settings: (ctx) => ctx.platform.configManager,
  skipped: setupSkipFile<CommandContext>((ctx) => ctx.workspace?.shellPaths?.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'setup-skipped.json')),
  whoDecides,
};

/** `/setup` with its topics; the setup checks and transfers are `/startup` (local-setup.ts). */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>(SETUP_OPTIONS));

/** The System place's Setup list over this app's `/setup`, its settings and its "Who decides" record. */
export function setupPlace(ctx: CommandContext): SetupPlaceHooks {
  return setupPlaceHooks(SETUP_OPTIONS, ctx, {
    openWhoDecides: () => ctx.openWhoDecides?.() ?? Promise.resolve(false),
    onSettingsChange: (listener) => ctx.platform.configManager.onDidChangeIncarnation(listener),
  });
}

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
  registry.register(STARTUP_COMMAND);
}
