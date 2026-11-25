import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { CommandActionContext } from './command-actions/types.js';
import { printedText } from './health-command.js';

/**
 * Voice has no slash command: speaking and listening are this program's capabilities (capabilities/builtin/
 * system-session.ts, system-program.ts), the voice runtime and the voice settings file the daemon's (system.ts,
 * system-settings.ts), each a control in the System place (This session, Voice). What a program supplies is its
 * wake word on its own microphone, below.
 */
export interface VoiceContext extends CommandActionContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic' | 'setMany' | 'getSchema'>; readonly voiceService?: unknown };
  /** Returns whether anything was playing; a port that returns nothing is treated as having stopped playback. */
  readonly stopSpokenOutput?: (() => boolean | void) | undefined;
  readonly submitSpokenInput?: ((prompt: string) => void) | undefined;
  readonly listenForWakeAgain?: (() => Promise<string>) | undefined;
  readonly renderRequest: () => void;
}

/** What one program supplies for its wake word: where its files are, and its own wake work (status, setup). */
export interface VoiceWakePolicy<Context extends VoiceContext> {
  readonly paths: (context: Context) => ShellPathService;
  readonly wake: (args: string[], ctx: Context, shellPaths: ShellPathService) => void | Promise<void>;
}

/**
 * The wake word on this program's microphone, as the capabilities `voice.wake-status` and `voice.wake-setup` take it
 * (system-session.ts `speech.wake`): the program's own wake work, its printed lines returned as words.
 */
export function wakeServicesOf<Context extends VoiceContext>(
  policy: VoiceWakePolicy<Context>,
  ctx: Context,
): { status(): Promise<string>; setup(withSpeechToText: boolean): Promise<string> } {
  return {
    status: () => printedText(ctx, (collecting) => policy.wake(['wake', 'status'], collecting, policy.paths(collecting))),
    setup: (withSpeechToText) => printedText(ctx, (collecting) => policy.wake(['wake', 'setup', ...(withSpeechToText ? ['yes'] : [])], collecting, policy.paths(collecting))),
  };
}
