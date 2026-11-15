/** Dictation and wake send an utterance to the same speech-to-text provider. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { UtteranceAudioArtifact } from '@goodvibes-jev/engine/platform/platform/voice/capture';
import { transcribeArtifact } from './useVoice';
import { setWakeSttProviderId, transcribeWakeArtifact } from './useWake';

const ARTIFACT: UtteranceAudioArtifact = {
  mimeType: 'audio/wav',
  format: 'wav',
  dataBase64: 'AAAA',
  sampleRateHz: 16000,
  durationMs: 500,
} as UtteranceAudioArtifact;

let originalFetch: typeof fetch;
let bodies: unknown[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  bodies = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
    return new Response(JSON.stringify({ text: ' hello ' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setWakeSttProviderId(undefined);
});

describe('speech-to-text provider choice', () => {
  test('a wake utterance carries the default provider the same way dictation does', async () => {
    setWakeSttProviderId('stt-main');
    expect(await transcribeWakeArtifact(ARTIFACT)).toBe('hello');
    expect(await transcribeArtifact(ARTIFACT, 'stt-main')).toBe('hello');
    expect(bodies[0]).toEqual(bodies[1]);
    expect((bodies[0] as { providerId?: string }).providerId).toBe('stt-main');
  });

  test('with no default provider neither path names one', async () => {
    await transcribeWakeArtifact(ARTIFACT);
    expect(bodies[0]).not.toHaveProperty('providerId');
  });
});
