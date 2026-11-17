import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { TerminalCommandRegistry } from './command-registry.js';
interface TtsContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic' | 'save'>; readonly voiceService?: unknown };
  /** Returns whether anything was playing; a port that returns nothing is treated as having stopped playback. */
  readonly stopSpokenOutput?: (() => boolean | void) | undefined;
  readonly submitSpokenInput?: ((prompt: string) => void) | undefined;
  print(message: string): void;
  renderRequest(): void;
}
export function createTtsRuntimeCommands<Context extends TtsContext>(policy: {
  readonly hidden: boolean;
  readonly alwaysSpeakControls: boolean;
  readonly description: string;
}) {
  function registerTtsRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'tts',
      description: policy.description,
      hidden: policy.hidden,
      usage: policy.alwaysSpeakControls ? '<prompt>|stop|on|off' : '<prompt>|stop',
      handler(args, context) {
        // A control word counts only on its own; `/tts stop the timer` is a prompt that starts with "stop".
        const first = args.length === 1 ? args[0]!.toLowerCase() : '';
        if (first === 'stop' || first === 'cancel') {
          if (!context.stopSpokenOutput) {
            context.print('Live TTS is not available in this runtime.');
            return;
          }
          context.print(context.stopSpokenOutput() === false ? 'Nothing is playing.' : 'Live TTS playback stopped.');
          return;
        }
        if (policy.alwaysSpeakControls && (first === 'on' || first === 'off')) {
          if (first === 'on' && !context.platform.voiceService) {
            context.print('Live TTS is not available in this runtime.');
            return;
          }
          context.platform.configManager.setDynamic('ui.voiceEnabled', first === 'on');
          context.platform.configManager.save();
          context.print(
            first === 'on'
              ? 'Always-speak mode enabled. Every submitted turn will be played through live TTS.'
              : 'Always-speak mode disabled. Use /tts <prompt> to speak individual turns.',
          );
          context.renderRequest();
          return;
        }
        const prompt = args.join(' ').trim();
        if (!prompt) {
          context.print(
            policy.alwaysSpeakControls
              ? 'Usage: /tts <prompt>, /tts stop, /tts on, /tts off\nAlways-speak mode is currently ' +
                  (context.platform.configManager.get('ui.voiceEnabled') ? 'on' : 'off') +
                  '.'
              : 'Usage: /tts <prompt> or /tts stop',
          );
          return;
        }
        if (!context.submitSpokenInput) {
          context.print('Live TTS is not available in this runtime.');
          return;
        }
        context.submitSpokenInput(prompt);
      },
    });
  }
  return { registerTtsRuntimeCommands };
}
