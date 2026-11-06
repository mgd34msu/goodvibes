import type { UtteranceAudioArtifact } from '@goodvibes-jev/engine/sdk/platform/voice';
/** A surface declares exactly the transcription options and diagnostics its selected route supports. */
export interface SpeechTranscriptionGateway<Options extends readonly unknown[] = []> {
  transcribe(audio: UtteranceAudioArtifact, ...options: Options): Promise<string>;
}
export type SpeechTranscriptionResolution<Gateway> =
  | { readonly available: true; readonly gateway: Gateway }
  | { readonly available: false; readonly reason: string };
