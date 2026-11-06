import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SelectionItem } from './selection-modal.js';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OpenSelection } from './selection-modal.js';
export interface TtsPickerContext {
  readonly platform: {
    readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'>;
    readonly voiceProviderRegistry?:
      | {
          list(): Array<{
            id: string;
            label: string;
            capabilities: readonly string[];
          }>;
        }
      | null
      | undefined;
    readonly voiceService?:
      | {
          listVoices(provider?: string | undefined): Promise<
            readonly {
              readonly id: string;
              readonly label?: string | undefined;
            }[]
          >;
        }
      | null
      | undefined;
  };
  readonly openSelection?: OpenSelection | undefined;
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
}
export function createTtsSettingsActions<Context extends TtsPickerContext>(presentation: {
  readonly describeError: (error: unknown) => string;
  readonly providerItem?:
    | ((
        context: Context,
        provider: {
          readonly id: string;
          readonly label: string;
        },
        current: string,
      ) => SelectionItem | undefined)
    | undefined;
}) {
  function getStreamingTtsProviders(ctx: Context): Array<{
    id: string;
    label: string;
    capabilities: readonly string[];
  }> {
    const registry = ctx.platform.voiceProviderRegistry;
    if (!registry) return [];
    return registry.list().filter((provider) => provider.capabilities.includes('tts-stream'));
  }
  function setTtsConfigValue(ctx: Context, key: ConfigKey, value: string): void {
    ctx.platform.configManager.setDynamic(key, value);
  }
  function openTtsProviderPicker(
    ctx: Context,
    ownership?:
      | {
          readonly assertCurrent?: (() => void) | undefined;
        }
      | undefined,
  ): boolean {
    ownership?.assertCurrent?.();
    if (!ctx.openSelection) return false;
    const registry = ctx.platform.voiceProviderRegistry;
    if (!registry) {
      ctx.print('Voice provider registry is not available in this runtime.');
      return true;
    }
    const providers = getStreamingTtsProviders(ctx);
    if (providers.length === 0) {
      ctx.print('No streaming TTS providers are registered.');
      return true;
    }
    const current = String(ctx.platform.configManager.get('tts.provider') ?? '').trim();
    const items: SelectionItem[] = providers.map(
      (provider) =>
        presentation.providerItem?.(ctx, provider, current) ?? {
          id: provider.id,
          label: provider.label,
          detail: provider.id === current ? `${provider.id}  (current)` : provider.id,
          category: 'streaming TTS providers',
          primaryAction: 'select',
          actions: '[Enter] set provider',
        },
    );
    ownership?.assertCurrent?.();
    ctx.openSelection('Choose TTS Provider', items, { preSelectId: current, allowSearch: true }, (result) => {
      if (!result) return;
      const previous = String(ctx.platform.configManager.get('tts.provider') ?? '').trim();
      setTtsConfigValue(ctx, 'tts.provider', result.item.id);
      if (previous && previous !== result.item.id) {
        setTtsConfigValue(ctx, 'tts.voice', '');
        ctx.print(`TTS provider set to ${result.item.id}. TTS voice was cleared because voices are provider-specific.`);
      } else {
        ctx.print(`TTS provider set to ${result.item.id}.`);
      }
      ctx.renderRequest();
    });
    return true;
  }
  async function openTtsVoicePicker(
    ctx: Context,
    providerArg?: string | undefined,
    ownership?:
      | {
          readonly assertCurrent?: (() => void) | undefined;
        }
      | undefined,
  ): Promise<boolean> {
    ownership?.assertCurrent?.();
    if (!ctx.openSelection) return false;
    const service = ctx.platform.voiceService;
    if (!service) {
      ctx.print('Voice service is not available in this runtime.');
      return true;
    }
    const providerId = (providerArg ?? String(ctx.platform.configManager.get('tts.provider') ?? '')).trim() || undefined;
    try {
      ownership?.assertCurrent?.();
      const voices = await service.listVoices(providerId);
      ownership?.assertCurrent?.();
      if (voices.length === 0) {
        ctx.print(providerId ? `No voices returned for ${providerId}.` : 'No TTS voices returned.');
        return true;
      }
      const current = String(ctx.platform.configManager.get('tts.voice') ?? '').trim();
      const items: SelectionItem[] = [
        {
          id: '__default__',
          label: 'Use provider default voice',
          detail: current ? 'clears tts.voice' : '(current)',
          category: 'voice',
          primaryAction: 'select',
        },
        ...voices.map((voice) => ({
          id: voice.id,
          label: voice.label || voice.id,
          detail: voice.id === current ? `${voice.id}  (current)` : voice.id,
          category: providerId ?? 'voices',
          primaryAction: 'select' as const,
          actions: '[Enter] set voice',
        })),
      ];
      ownership?.assertCurrent?.();
      ctx.openSelection(
        `Choose TTS Voice${providerId ? ` (${providerId})` : ''}`,
        items,
        { preSelectId: current || '__default__', allowSearch: true },
        (result) => {
          if (!result) return;
          const nextVoice = result.item.id === '__default__' ? '' : result.item.id;
          setTtsConfigValue(ctx, 'tts.voice', nextVoice);
          ctx.print(nextVoice ? `TTS voice set to ${nextVoice}.` : 'TTS voice cleared. The provider default voice will be used.');
          ctx.renderRequest();
        },
      );
      return true;
    } catch (error) {
      ownership?.assertCurrent?.();
      ctx.print(`Unable to list TTS voices: ${presentation.describeError(error)}`);
      return true;
    }
  }
  return { openTtsProviderPicker, openTtsVoicePicker };
}
