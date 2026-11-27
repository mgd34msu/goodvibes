import { capabilityBinding } from './capability-binding.ts';
import {
  daemonSetupSkips, setupPlaceHooks, setupTopicOf,
  type SetupCommandOptions, type SetupPlaceHooks, type SetupRun, type SetupTopicId, type WhoDecidesState,
} from '@goodvibes/engine/terminal-shell/setup-command';
import { firstRunDecisionModel, whoDecidesOnChecklist } from '@goodvibes/engine/terminal-shell/first-run';
import type { CommandContext } from '../command-registry.ts';
import type { OnboardingWizardTopic } from '../onboarding/onboarding-wizard-types.ts';
import { openOnboardingWizard, requireSecretsManager } from './runtime-services.ts';
import { readSetupState } from '@goodvibes/engine/platform/platform/capabilities';
// The System session through its slot: session-capabilities.ts imports this file (session-capability-slots.ts).
import { systemSessionOfSlot as systemSessionOf } from './session-capability-slots.ts';

/** The topics the terminal app opens as one form of its own (the former wizard pages). */
const FORM_TOPICS: readonly OnboardingWizardTopic[] = [
  'model', 'sign-in', 'store-key', 'connect-daemon', 'chat-apps', 'cloudflare',
  'how-it-works', 'safety', 'memory', 'telemetry', 'automation', 'devices-voice', 'provider-behaviour', 'advanced',
];

/**
 * Where this computer listens and who reaches it: one control in both programs, Devices and network's Addresses and
 * ports (each listener on or off, its address, port and encryption, changed through the daemon; `a` there makes the
 * account that signs in from a browser or another device). "Who can sign in here" is that account: the same control.
 */
const NETWORK_TOPICS: readonly SetupTopicId[] = ['local-only', 'browser', 'other-devices', 'webhooks', 'who-signs-in'];
const openAddresses: SetupRun<CommandContext> = async (_values, ctx) => {
  if (!ctx.openPlace) return 'Devices and network cannot be shown here.';
  ctx.openPlace('devices', { list: 'addresses' });
};

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
  program: 'tui',
  runs: {
    ...Object.fromEntries(FORM_TOPICS.map((topic) => [topic, openForm(topic)])) as Partial<Record<SetupTopicId, SetupRun<CommandContext>>>,
    ...Object.fromEntries(NETWORK_TOPICS.map((topic) => [topic, openAddresses])),
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
  elsewhere: (_id, label) => `"${label}" is done in the Agent: in goodvibes-agent, open the menu (Ctrl+G, then m), then System, Setup, and choose it there.`,
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

/** The System place's Setup list over this app's setup topics, its settings and its "Who decides" record. */
export function setupPlace(ctx: CommandContext): SetupPlaceHooks {
  return setupPlaceHooks(SETUP_OPTIONS, ctx, {
    // The row is the person coming to choose: "Who decides" opens whatever is in force.
    openWhoDecides: () => ctx.openWhoDecides?.({ always: true }) ?? Promise.resolve(false),
    onSettingsChange: (listener) => ctx.platform.configManager.onDidChangeIncarnation(listener),
  });
}
