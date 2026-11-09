import type { SpeechTranscriptionGateway, SpeechTranscriptionResolution } from '@goodvibes-jev/engine/terminal-shell/voice-stt-contract';
/**
 * voice-stt-gateway.ts, speech-to-text for captured audio.
 *
 * Both voice consumers end here: push-to-talk hands over what the user just
 * said, and a confirmed wake hands over the utterance that followed it. The
 * transcription itself is the daemon's, not this process's, `voice.stt`
 * (POST /api/voice/stt) transcribes an audio artifact through whichever voice
 * provider is registered, including the managed local whisper that
 * `/voice setup` provisions.
 *
 * The verb has no named facade on the in-process OperatorClient, so it goes over
 * the generic operator invoke path exactly like the voice PROVISIONING verbs do
 * (see core/voice-provision-gateway.ts), same daemon, same resolution, same
 * honest refusal reasons up front rather than a throw mid-capture.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GoodVibesError } from '@goodvibes-jev/engine/platform';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';

import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';

/** voice.stt output, the recognised text plus the provider that produced it. */
export type VoiceTranscriptionResult = OperatorMethodOutput<'voice.stt'>;

/** The narrow verb surface a capture consumer needs. */
export type VoiceSttGateway = SpeechTranscriptionGateway<[options?: { readonly signal?: AbortSignal }]>;

/**
 * Why transcription is unavailable, surfaced verbatim so a capture path prints
 * the daemon's reason instead of inventing one.
 */
export type VoiceSttGatewayResolution = SpeechTranscriptionResolution<VoiceSttGateway>;

export interface VoiceSttGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/** Build the live speech-to-text gateway, or say why there is none. */
export function createVoiceSttGateway(deps: VoiceSttGatewayDeps): VoiceSttGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { platformClient } = rpc;
  return {
    available: true,
    gateway: {
      transcribe: async (audio, options) => {
        // Keep the daemon contract's output type at the generic invoke boundary.
        const result = await platformClient.operator.invoke<VoiceTranscriptionResult>('voice.stt', { audio }, options);
        return result.text;
      },
    },
  };
}

/**
 * Render a `voice.stt` rejection honestly. A 501 (the verb is cataloged but this
 * daemon has no voice provider wired behind it) and a 404 (an older daemon
 * without the route) are both "no transcription here", distinct from a request
 * that reached a provider and failed, which the user can act on differently.
 */
export function describeTranscriptionFailure(error: unknown): string {
  if (error instanceof GoodVibesError && (error.status === 501 || error.status === 404)) {
    return 'this daemon has no speech-to-text provider wired up; run /voice setup to provision the managed local runtime.';
  }
  return describeOperatorRpcError(error);
}
