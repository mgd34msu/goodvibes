import { createTtsSettingsActions } from '@goodvibes-jev/engine/terminal-shell/tts-settings-actions';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { localVoiceSetupOffer } from './voice-local-settings.ts';
import type { CommandContext } from './command-registry.ts';
export const { openTtsProviderPicker, openTtsVoicePicker } = createTtsSettingsActions<CommandContext>({
  describeError: summarizeError,
  providerItem(ctx, provider, current) {
    if (provider.id !== 'local') return undefined;
    const offer = localVoiceSetupOffer((key) =>
      ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
    );
    if (offer.provisioned) return undefined;
    return {
      id: provider.id,
      label: provider.label,
      detail: provider.id === current ? `${offer.detail}  (current)` : offer.detail,
      category: 'streaming TTS providers',
      primaryAction: 'select',
      actions: offer.actions,
    };
  },
});
