import { createVoiceExperienceCommand, wakeServicesOf, type VoiceExperiencePolicy } from '@goodvibes/engine/terminal-shell/experience-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import {
  createVoiceProvisionGateway,
  renderVoiceProvision,
  runVoiceSetupWithProgress,
  VOICE_SETUP_ANNOUNCEMENT,
} from '../../core/voice-provision-gateway.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes/engine/platform/platform/voice/wake/runtime';
import { terminalWakeCapabilities, WAKE_SETUP_ANNOUNCEMENT } from '../../core/wake-provision-status.ts';
import { printWakeStatus } from '../../core/wake-provision-runner.ts';
import { wakeProvisionStatus } from '@goodvibes/engine/platform/platform/voice';
import type { VoiceSetupOutcome } from '@goodvibes/engine/platform/platform/runtime/voice-setup';
import { proposesSpeechToText, runWakeSetupPlan } from '../../core/wake-setup-plan.ts';
import { requireVoiceSetup } from './runtime-services.ts';
import { systemSessionOf } from './session-capabilities.ts';
import { capabilityBinding } from './capability-binding.ts';

export function registerExperienceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(voiceExperienceCommand);
}

/** The wake word on this app's microphone, as `voice.wake-status` and `voice.wake-setup` take it (session-capabilities.ts). */
export function voiceWakeOf(ctx: CommandContext): ReturnType<typeof wakeServicesOf> {
  return wakeServicesOf(voicePolicy, ctx);
}

const voicePolicy: VoiceExperiencePolicy<CommandContext> = {
  reportFailure: false,
  paths: requireShellPaths,
  async wake(args, ctx, shellPaths) {
    // The wake models are provisioned locally by the platform (checksum-pinned
    // download), not through a daemon verb, so this path needs no gateway.
    // Installation already provisions them and a daemon retries at boot.
    const wakeSub = (args[1] ?? 'status').toLowerCase();
    const managedRoot = shellPaths.resolveUserPath('voice');
    const runner = {
      managedRoot,
      settings: resolveWakeRuntimeSettings(
        (key: string) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
        'tui',
        // Read from disk, so `/voice wake-status` reports the speech gate as
        // available exactly when its artifact is there and verified.
        terminalWakeCapabilities(wakeProvisionStatus({ managedRoot })),
      ),
      print: (block: string) => ctx.print(block),
    };
    if (wakeSub === 'setup') {
      // The platform's one voice setup decides the plan from this host's facts:
      // this terminal listens (the feature and its row), missing wake models are
      // fetched, and speech-to-text, what makes a wake word useful, is proposed.
      if (!wakeProvisionStatus({ managedRoot }).ready) ctx.print(WAKE_SETUP_ANNOUNCEMENT);
      let outcome: VoiceSetupOutcome;
      try {
        outcome = await runWakeSetupPlan(requireVoiceSetup(ctx));
      } catch (error) {
        ctx.print(`Wake-Word Setup\n  setup failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const proposesStt = proposesSpeechToText(outcome);
      // Speech-to-text is installed by the daemon (voice.local.install), the one
      // installer of the managed voice runtime on this machine.
      const resolution = createVoiceProvisionGateway({
        configManager: ctx.platform.configManager,
        homeDirectory: () => requireShellPaths(ctx).homeDirectory,
      });
      if (proposesStt && args[2]?.toLowerCase() === 'yes' && resolution.available) {
        ctx.print(['Wake-Word Setup', outcome.rendered].join('\n'));
        ctx.print(VOICE_SETUP_ANNOUNCEMENT);
        await runVoiceSetupWithProgress(resolution, { print: (block) => ctx.print(block) });
        return;
      }
      ctx.print(['Wake-Word Setup', outcome.rendered, ...(proposesStt
        ? [resolution.available
          ? '(Set up the wake word again with "Install it too" in the System place, Voice, to install it now.)'
          : `(speech-to-text is installed through the daemon, which is not reachable here: ${resolution.reason})`]
        : [])].join('\n'));
      return;
    }
    if (wakeSub === 'status') {
      printWakeStatus(runner);
      return;
    }
    ctx.print('Use /voice wake-status or /voice wake-setup.');
    return;
  },
  async provision(sub, _args, ctx, _shellPaths) {
    // The one-act managed install returns a final receipt (no per-phase
    // streaming over the verb), so the announcement block prints first and
    // the receipt/failure block follows once the (possibly long,
    // multi-hundred-MB) install resolves.
    const resolution = createVoiceProvisionGateway({
      configManager: ctx.platform.configManager,
      // Lazy: the daemon-disabled / no-base-URL refusals resolve before shell paths.
      homeDirectory: () => requireShellPaths(ctx).homeDirectory,
    });
    if (sub === 'setup') {
      // Print the up-front announcement, then drive the install with live
      // per-component progress polled from voice.local.status.
      if (resolution.available) ctx.print(VOICE_SETUP_ANNOUNCEMENT);
      await runVoiceSetupWithProgress(resolution, { print: (block) => ctx.print(block) });
      return;
    }
    ctx.print(await renderVoiceProvision(sub, resolution));
    return;
  },
  // Speaking and listening run here, on this app's speaker and microphone (session-capabilities.ts).
  services: (ctx) => ({ systemSession: systemSessionOf(ctx) }),
  // The voice runtime is the daemon's (voice.status, voice.setup).
  capability: capabilityBinding,
};

const voiceExperienceCommand = createVoiceExperienceCommand<CommandContext>(voicePolicy);
