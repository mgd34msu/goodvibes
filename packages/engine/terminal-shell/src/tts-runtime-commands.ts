import { commandRefusal } from './command-confirmation.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
export interface AlwaysSpeakContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'setDynamic'>; readonly voiceService?: unknown };
}
/**
 * The one switch for speaking every answer (`ui.voiceEnabled`), behind the
 * capabilities voice.on and voice.off (`/voice on`, `/voice off`, the System
 * place's `a`): turning it on needs a voice service in this runtime, and the
 * single-key write is the whole persistence.
 */
export function switchAlwaysSpeak(context: AlwaysSpeakContext, enabled: boolean): string {
  if (enabled && !context.platform.voiceService) throw commandRefusal('Speech output is not available in this session, so answers stay unspoken.', 'The System place\'s Voice tab says what the local voice runtime needs.', 'UNAVAILABLE');
  context.platform.configManager.setDynamic('ui.voiceEnabled', enabled);
  return enabled
    ? 'Every answer will be played aloud.'
    : 'Answers are no longer played aloud; "Ask and hear the answer spoken" still plays one.';
}
