/**
 * wake-setup-plan.ts, this app's wake-word setup through the platform's one
 * voice setup (VoiceSetupService.setup): the plan is decided from this host's
 * facts, the wake rows are set and missing wake models fetched, and
 * speech-to-text is proposed. `/voice wake-setup` and turning
 * `voice.wake.enabled` on anywhere (settings, /settings, a model's settings
 * call) both go through here, so they print the same plan.
 */
import type { VoiceSetupOutcome, VoiceSetupService } from '@goodvibes-jev/engine/platform/platform/runtime/voice-setup';

let running = 0;

/** Run the wake setup for this surface. `acceptProposals` installs what the plan proposes. */
export async function runWakeSetupPlan(
  voiceSetup: Pick<VoiceSetupService, 'setup'>,
  acceptProposals = false,
): Promise<VoiceSetupOutcome> {
  running += 1;
  try {
    return await voiceSetup.setup({ intent: 'wake', surface: 'agent', acceptProposals });
  } finally {
    running -= 1;
  }
}

/** True while a wake setup runs here: the switch it turns on must not start a second one. */
export function wakeSetupRunning(): boolean {
  return running > 0;
}

/** Whether the plan still proposes speech-to-text (the answer `yes` installs it). */
export function proposesSpeechToText(outcome: VoiceSetupOutcome): boolean {
  return outcome.plan.steps.some((step) => step.kind === 'propose' && step.subject === 'stt');
}
