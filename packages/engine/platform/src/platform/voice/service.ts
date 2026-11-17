import { VoiceProviderRegistry, captureVoiceProviderReadSource } from './provider-registry.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { DaemonErrorCategory, GoodVibesError } from '@goodvibes-jev/engine/errors';
import type {
  VoiceDescriptor,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceSynthesisStreamResult,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from './types.js';

export interface VoiceServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: Awaited<ReturnType<VoiceProviderRegistry['status']>>;
  readonly note: string;
}

/** One billable voice call (metered providers only; local emits nothing). */
export interface VoiceBillableUsage {
  readonly providerId: string;
  readonly modelId: string | undefined;
  readonly kind: 'tts' | 'stt';
  /** The provider's billable unit count: characters submitted for TTS, seconds of audio for STT. */
  readonly billableUnits: number;
  readonly unit: 'characters' | 'seconds';
}

/** A check that the voice providers did not change while a voice list was read. */
export function captureVoiceListReadSource(service: VoiceService): () => void {
  return service.captureListReadSource();
}

export class VoiceService {
  constructor(
    private readonly registry: VoiceProviderRegistry,
    /** Cost-attribution sink for METERED providers (wired by the runtime root). */
    private readonly onBillableUsage?: ((usage: VoiceBillableUsage) => void) | undefined,
  ) {
  }

  captureListReadSource(): () => void {
    return captureVoiceProviderReadSource(this.registry);
  }

  /** Record a metered call; a provider with billing 'none' emits nothing (honest no-dimension). */
  private recordUsage(provider: { id: string; billing?: 'metered' | 'none' | undefined }, usage: Omit<VoiceBillableUsage, 'providerId'>): void {
    if (provider.billing === 'none') return;
    if (usage.billableUnits <= 0) return;
    try {
      this.onBillableUsage?.({ providerId: provider.id, ...usage });
    } catch {
      // A cost sink failure must never fail the voice call.
    }
  }

  async getStatus(enabled: boolean): Promise<VoiceServiceStatus> {
    const providers = await this.registry.status();
    return {
      enabled,
      providerCount: providers.length,
      providers,
      note: 'Voice capture runs in a recorder child of the process that hosts the wake-word listener (the daemon, or a terminal product); terminal, web, or companion clients can also stream audio into these provider-backed APIs.',
    };
  }

  async listVoices(providerId?: string): Promise<readonly VoiceDescriptor[]> {
    const providers = providerId
      ? [this.registry.get(providerId)].filter((provider): provider is NonNullable<typeof provider> => provider !== null)
      : this.registry.list().map((entry) => this.registry.get(entry.id)).filter((provider): provider is NonNullable<typeof provider> => provider !== null);
    const voices: VoiceDescriptor[] = [];
    for (const provider of providers) {
      if (!provider.listVoices) continue;
      // Asked for all, a provider with no credentials has no voices to list and nothing went wrong.
      if (!providerId && provider.status) {
        try { if (!(await provider.status()).configured) continue; } catch { /* its listVoices below says what is wrong */ }
      }
      try {
        voices.push(...await provider.listVoices());
      } catch (error) {
        // Asked for one provider, its failure is the answer. Asked for all, one
        // failing provider must not hide the voices the others can list.
        if (providerId) throw error;
        logger.warn('voice provider listVoices failed; its voices are omitted', { providerId: provider.id, error: summarizeError(error) });
      }
    }
    return voices.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async synthesize(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const provider = await this.registry.resolveProvider('tts', providerId);
    if (!provider?.synthesize) {
      throw providerNotConfiguredError(providerId, 'Voice TTS provider');
    }
    const result = await provider.synthesize(request);
    this.recordUsage(provider, { modelId: request.modelId, kind: 'tts', billableUnits: request.text.length, unit: 'characters' });
    return result;
  }

  async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
    const provider = await this.registry.resolveProvider('tts-stream', providerId);
    if (!provider?.synthesizeStream) {
      throw providerNotConfiguredError(providerId, 'Voice streaming TTS provider');
    }
    const result = await provider.synthesizeStream(request);
    // Streaming TTS bills on the submitted characters (the provider's own
    // billing unit), recorded at accept time, not per chunk.
    this.recordUsage(provider, { modelId: request.modelId, kind: 'tts', billableUnits: request.text.length, unit: 'characters' });
    return result;
  }

  async transcribe(providerId: string | undefined, request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const provider = await this.registry.resolveProvider('stt', providerId);
    if (!provider?.transcribe) {
      throw providerNotConfiguredError(providerId, 'Voice STT provider');
    }
    const result = await provider.transcribe(request);
    // STT bills on audio seconds where known; a provider that reported no
    // duration falls back to 1 second minimum so metered usage is never lost.
    const seconds = request.audio.durationMs !== undefined ? Math.max(1, Math.round(request.audio.durationMs / 1000)) : 1;
    this.recordUsage(provider, { modelId: request.modelId, kind: 'stt', billableUnits: seconds, unit: 'seconds' });
    return result;
  }

  async openRealtimeSession(providerId: string | undefined, request: VoiceRealtimeSessionRequest): Promise<VoiceRealtimeSession> {
    const provider = await this.registry.resolveProvider('realtime', providerId);
    if (!provider?.openRealtimeSession) {
      throw providerNotConfiguredError(providerId, 'Voice realtime provider');
    }
    return provider.openRealtimeSession(request);
  }
}

function providerNotConfiguredError(providerId: string | undefined, label: string): GoodVibesError {
  return new GoodVibesError(
    providerId ? `${label} is unavailable: ${providerId}` : `${label} is not registered`,
    {
      code: 'PROVIDER_NOT_CONFIGURED',
      category: DaemonErrorCategory.CONFIG,
      source: 'provider',
      recoverable: false,
      ...(providerId ? { provider: providerId } : {}),
    },
  );
}
