import { wakeServicesOf, type VoiceWakePolicy } from '@goodvibes/engine/terminal-shell/experience-commands';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths, requireVoiceSetup } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes/engine/platform/platform/voice/wake/runtime';
import {
  agentWakeCapabilities,
  wakeStatusLines,
  WAKE_SETUP_ANNOUNCEMENT,
} from '../../core/wake-provision-status.ts';
import { proposesSpeechToText, runWakeSetupPlan } from '../../core/wake-setup-plan.ts';
import { readRefusal } from '@goodvibes/engine/errors';

/** The wake word on this Agent's microphone, as `voice.wake-status` and `voice.wake-setup` take it (session-capabilities.ts). */
export function voiceWakeOf(ctx: CommandContext): ReturnType<typeof wakeServicesOf> {
  return wakeServicesOf(voicePolicy, ctx);
}

const voicePolicy: VoiceWakePolicy<CommandContext> = {
  paths: requireShellPaths,
  async wake(args, ctx, _shellPaths) {
    // Wake artifacts live under the same managed voice root as the local
    // runtime, in its `wake` subdirectory, and are served by the same
    // voiceSetup service, so this reads and provisions through the platform's
    // own wake service rather than a second provisioning path. Nothing
    // downloads until the wake word is set up.
    const voiceSetup = requireVoiceSetup(ctx);
    const wakeSub = (args[1] ?? 'status').toLowerCase();
    // Read the artifact state BEFORE resolving: whether the speech gate is on
    // disk decides whether voice.wake.vadThreshold above 0 is honoured or
    // refused, so resolving first would report a blocker that does not match
    // what the wake word's setup has already downloaded.
    const status = voiceSetup.wakeStatus();
    const settings = resolveWakeRuntimeSettings(
      (key: string) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
      'agent',
      agentWakeCapabilities({ vadReady: status.vadReady }),
    );
    if (wakeSub === 'setup') {
      // The platform's voice setup: this surface listens for the wake word,
      // the models are fetched, and speech-to-text (what makes a wake word
      // useful) is proposed, or installed when the answer `yes` was given.
      // The work ends when it is done, so whoever ran it (the owner or the
      // model) gets the outcome.
      ctx.print(WAKE_SETUP_ANNOUNCEMENT);
      try {
        const outcome = await runWakeSetupPlan(voiceSetup, args[2]?.toLowerCase() === 'yes');
        const proposesStt = proposesSpeechToText(outcome);
        ctx.print(['Wake-Word Setup', outcome.rendered, ...(proposesStt ? ['(Set up the wake word again with "Install it too" in the System place, Voice, to install it now.)'] : [])].join('\n'));
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(`Wake-Word Setup\n  setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    ctx.print(['Wake-Word Detection', ...wakeStatusLines(status, settings)].join('\n'));
  },
};
