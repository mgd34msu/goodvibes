import { wakeServicesOf, type VoiceWakePolicy } from '@goodvibes/engine/terminal-shell/experience-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import { classifyVoiceProvisionError, createVoiceProvisionGateway } from '../../core/voice-provision-gateway.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes/engine/platform/platform/voice/wake/runtime';
import { terminalWakeCapabilities, WAKE_SETUP_ANNOUNCEMENT } from '../../core/wake-provision-status.ts';
import { printWakeStatus } from '../../core/wake-provision-runner.ts';
import { wakeProvisionStatus } from '@goodvibes/engine/platform/platform/voice';
import type { VoiceSetupOutcome } from '@goodvibes/engine/platform/platform/runtime/voice-setup';
import { proposesSpeechToText, runWakeSetupPlan } from '../../core/wake-setup-plan.ts';
import { requireVoiceSetup } from './runtime-services.ts';

/** The wake word on this app's microphone, as `voice.wake-status` and `voice.wake-setup` take it (session-capabilities.ts). */
export function voiceWakeOf(ctx: CommandContext): ReturnType<typeof wakeServicesOf> {
  return wakeServicesOf(voicePolicy, ctx);
}

const voicePolicy: VoiceWakePolicy<CommandContext> = {
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
        // Read from disk, so the wake word's status reports the speech gate as
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
      // installer of the managed voice runtime on this machine; the install goes
      // on there, and the System place's Voice tab follows it to its result.
      const resolution = createVoiceProvisionGateway({
        configManager: ctx.platform.configManager,
        homeDirectory: () => requireShellPaths(ctx).homeDirectory,
      });
      if (proposesStt && args[2]?.toLowerCase() === 'yes' && resolution.available) {
        let started: string;
        try {
          const answer = await resolution.gateway.startInstall();
          started = answer.kind === 'started'
            ? `Speech-to-text is being installed${answer.joined ? ' (an install was already running)' : ''}; the Voice tab of the System place shows each step and the result.`
            : 'Speech-to-text was installed; the Voice tab of the System place shows the result.';
        } catch (error) {
          const failure = classifyVoiceProvisionError(error);
          started = `Speech-to-text was not installed: ${failure.kind === 'unavailable' ? failure.reason : failure.message}`;
        }
        ctx.print(['Wake-Word Setup', outcome.rendered, started].join('\n'));
        return;
      }
      ctx.print(['Wake-Word Setup', outcome.rendered, ...(proposesStt
        ? [resolution.available
          ? '(Set up the wake word again with "Install it too" in the System place, Voice, to install it now.)'
          : `(speech-to-text is installed through the daemon, which is not reachable here: ${resolution.reason})`]
        : [])].join('\n'));
      return;
    }
    printWakeStatus(runner);
  },
};
