import {
  createApprovalCommand,
  createVoiceExperienceCommand,
} from '@goodvibes/engine/terminal-shell/experience-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes/engine/terminal-shell/command-service-access';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
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

export function registerExperienceRuntimeCommands(registry: CommandRegistry): void {
  registry.register(approvalMatrixCommand);


  registry.register(voiceExperienceCommand);
}

const approvalMatrixCommand = createApprovalCommand<CommandContext>({
  openWaiting(ctx) {
    // Approvals waiting on you are rows in the Agents view (b jumps to them).
    if (!ctx.openView?.('approval')) throw commandRefusal('The Agents view is not available in this session.', '/questions lists what waits on you.');
  },
});
const voiceExperienceCommand = createVoiceExperienceCommand<CommandContext>({
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
          ? '(/voice wake-setup --with-speech-to-text installs it now)'
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
  review: (enabled) => [
    'Voice Review',
    `  always-speak: ${enabled ? 'on' : 'off'}`,
    '  setting: ui.voiceEnabled (/voice on and /voice off)',
    '  posture: optional local TTS output; disabled by default',
    '  note: voice remains an optional operator convenience, not a required SaaS dependency',
  ],
});
