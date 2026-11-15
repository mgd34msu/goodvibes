/**
 * voice-download-and-breaker.test.ts
 *
 * When the local TTS engine hard-fails (the piper SIGABRT / onnxruntime
 * "Unsupported model IR version" abort on this host), the provider trips a
 * circuit breaker, one honest engine-unavailable state, no per-chunk crash
 * storm, and a transient timeout does NOT trip it.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { createLocalVoiceProvider } from '../platform/src/platform/voice/providers/local.ts';
import type { VoiceSynthesisRequest } from '../platform/src/platform/voice/types.ts';

function ttsConfig(): (key: string) => string {
  const values: Record<string, string> = {
    'voice.local.ttsEngine': 'piper',
    'voice.local.ttsBinary': '/opt/piper/piper',
    'voice.local.ttsModelPath': '/models/en_US-glados-high.onnx',
  };
  return (key) => values[key] ?? '';
}
const req: VoiceSynthesisRequest = { text: 'hello', metadata: {} } as VoiceSynthesisRequest;

function abortError(message: string, signal: string | undefined = 'SIGABRT'): Error {
  const e = new Error(message) as Error & { signal?: string };
  if (signal) e.signal = signal;
  return e;
}

describe('local TTS hard-failure circuit breaker', () => {
  test('a piper onnxruntime abort trips the breaker: one honest state, no re-invocation', async () => {
    let calls = 0;
    const provider = createLocalVoiceProvider({
      readConfig: ttsConfig(),
      fileExists: () => true,
      runner: async () => {
        calls += 1;
        throw abortError('terminate called after throwing an instance of \'Ort::Exception\'\n  what():  ... Unsupported model IR version: 9, max supported IR version: 8');
      },
    });
    await expect(provider.synthesize!(req)).rejects.toThrow(/unavailable on this host/i);
    expect(calls).toBe(1);
    // Second call must NOT invoke the crashing binary again.
    await expect(provider.synthesize!(req)).rejects.toThrow(/unavailable on this host/i);
    expect(calls).toBe(1);
    // The honest message names the cause (onnxruntime IR version) and what to check.
    await provider.synthesize!(req).catch((e: unknown) => {
      expect(String(e)).toMatch(/onnxruntime|IR version/i);
    });
    // Status surfaces exactly the one engine-unavailable line.
    const status = await provider.status!();
    expect(status.state).toBe('degraded');
    expect(status.detail).toMatch(/unavailable on this host/i);
  });

  test('an engine that keeps failing with wording nothing recognises stops being spawned after three runs', async () => {
    let calls = 0;
    const provider = createLocalVoiceProvider({
      readConfig: ttsConfig(),
      fileExists: () => true,
      runner: async () => {
        calls += 1;
        throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'something nobody has seen before' });
      },
    });
    for (let chunk = 0; chunk < 10; chunk++) await provider.synthesize!(req).catch(() => {});
    expect(calls).toBe(3);
    await expect(provider.synthesize!(req)).rejects.toThrow(/failed 3 times in a row/);
  });

  test('a transient timeout does NOT trip the breaker', async () => {
    let calls = 0;
    const provider = createLocalVoiceProvider({
      readConfig: ttsConfig(),
      fileExists: () => true,
      runner: async () => {
        calls += 1;
        const e = new Error('spawn timed out') as Error & { killed?: boolean; signal?: string };
        e.killed = true;
        e.signal = 'SIGTERM';
        throw e;
      },
    });
    await expect(provider.synthesize!(req)).rejects.toThrow(/timed out/i);
    await expect(provider.synthesize!(req)).rejects.toThrow(/timed out/i);
    expect(calls).toBe(2); // breaker NOT tripped by a transient failure
  });

  test('reconfiguring the engine clears the breaker', async () => {
    let calls = 0;
    let modelPath = '/models/bad.onnx';
    const values = (): Record<string, string> => ({
      'voice.local.ttsEngine': 'piper',
      'voice.local.ttsBinary': '/opt/piper/piper',
      'voice.local.ttsModelPath': modelPath,
    });
    const provider = createLocalVoiceProvider({
      readConfig: (key) => values()[key] ?? '',
      fileExists: () => true,
      runner: async (input) => {
        calls += 1;
        if (modelPath.includes('bad')) throw abortError('Ort::Exception Unsupported model IR version: 9');
        const outIdx = input.args.indexOf('--output_file');
        if (outIdx >= 0) writeFileSync(String(input.args[outIdx + 1]), 'RIFF-fake-wav');
        return { stdout: '' };
      },
    });
    await expect(provider.synthesize!(req)).rejects.toThrow(/unavailable on this host/i);
    expect(calls).toBe(1);
    // Point at a new (good) model, the breaker for the old config is cleared.
    modelPath = '/models/good.onnx';
    await provider.synthesize!(req);
    expect(calls).toBe(2);
  });
});
