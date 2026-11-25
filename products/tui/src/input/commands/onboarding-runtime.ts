import { defineCommand, runDaemonCapability } from '@goodvibes/engine/terminal-shell/command-actions';
import { capabilityBinding } from './capability-binding.ts';
import {
  daemonSetupSkips, setupCommandDescription, setupPlaceHooks, setupTopicOf,
  type SetupCommandOptions, type SetupPlaceHooks, type SetupRun, type SetupTopicId, type WhoDecidesState,
} from '@goodvibes/engine/terminal-shell/setup-command';
import { firstRunDecisionModel, whoDecidesOnChecklist } from '@goodvibes/engine/terminal-shell/first-run';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { OnboardingWizardTopic } from '../onboarding/onboarding-wizard-types.ts';
import { openOnboardingWizard, requireSecretsManager } from './runtime-services.ts';
import { readSetupState } from '@goodvibes/engine/platform/platform/capabilities';
import { systemSessionOf } from './session-capabilities.ts';

/** The topics the terminal app opens as one form of its own (the former wizard pages). */
const FORM_TOPICS: readonly OnboardingWizardTopic[] = [
  'model', 'sign-in', 'store-key', 'local-only', 'browser', 'other-devices', 'connect-daemon', 'webhooks', 'chat-apps', 'cloudflare',
  'who-signs-in', 'how-it-works', 'safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced',
];

/**
 * The form opens on top of what is open (a place included); the run ends when it is submitted or left, and its
 * line says what was set up, so a place says nothing until then.
 */
const openForm = (topic: OnboardingWizardTopic): SetupRun<CommandContext> =>
  async (_values, ctx) => {
    const outcome = await openOnboardingWizard(ctx, { mode: 'edit', reset: true, topic });
    if (!outcome) return;
    if (!outcome.applied) return 'The form was left; nothing was set up.';
    return outcome.pages.length > 0 ? `Set up: ${outcome.pages.join(', ')}.` : 'The form was saved; nothing in it had changed.';
  };

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
    ...Object.fromEntries(FORM_TOPICS.map((topic) => [topic, openForm(topic)])) as Partial<Record<SetupTopicId, SetupRun<CommandContext>>>,
    // A provider of your own is the daemon's (capabilities/builtin/models.ts provider.add), run there as your request.
    'add-provider': async (values, ctx) => {
      const answer = await runDaemonCapability('provider.add', { name: values.name!, address: values.url! }, ctx, capabilityBinding);
      if (answer.detail ?? answer.text) ctx.print(answer.detail ?? answer.text ?? '');
    },
    'history': async (_values, ctx) => { ctx.openSettingsModal?.('behavior.saveHistory'); },
    // Safety and sandboxing is the Permissions and safety place (terminal-shell places/safety-place.ts), on its sandbox setting.
    'safety': async (_values, ctx) => {
      if (!ctx.openPlace) return 'Permissions and safety cannot be shown here.';
      ctx.openPlace('safety', { list: 'sandbox-setting' });
    },
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
  // Skipped for now: the daemon's one setup record, the same in both programs.
  skipped: daemonSetupSkips<CommandContext>((ctx) => ctx.workspace?.shellPaths?.homeDirectory, capabilityBinding),
  whoDecides,
  // Each topic is the capability setup.<topic>, run with this app's services (session-capabilities.ts `setupTopic`).
  services: (ctx) => ({ systemSession: systemSessionOf(ctx) }),
};

/** This app's setup forms, as the capabilities `setup.<topic>` open them. */
export function setupTopicsOf(ctx: CommandContext): (topic: string) => Promise<string | void> {
  return setupTopicOf(SETUP_OPTIONS, ctx);
}

/** `/setup` with its topics; the setup checks and transfers are the System place's (local-setup.ts). */
export const SETUP_COMMAND = defineCommand<CommandContext>(setupCommandDescription<CommandContext>(SETUP_OPTIONS));

/** The System place's Setup list over this app's `/setup`, its settings and its "Who decides" record. */
export function setupPlace(ctx: CommandContext): SetupPlaceHooks {
  return setupPlaceHooks(SETUP_OPTIONS, ctx, {
    // The row is the person coming to choose: "Who decides" opens whatever is in force.
    openWhoDecides: () => ctx.openWhoDecides?.({ always: true }) ?? Promise.resolve(false),
    onSettingsChange: (listener) => ctx.platform.configManager.onDidChangeIncarnation(listener),
  });
}

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register(SETUP_COMMAND);
  // `/startup` is gone: its checks and transfers are the System place's Health and Support and transfer tabs, the
  // remote runners Work and agents' Runners tab (local-setup.ts keeps the program's own start the checks read).
}
