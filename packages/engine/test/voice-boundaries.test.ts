/**
 * Voice platform boundaries: provider listing and status isolation, which
 * audio URIs a cloud provider may fetch, which providers an unnamed request may
 * pick, request cancellation, STT host fallback, wake cooldown under a clock
 * step, install-config ownership, local STT results, recorder shutdown and the
 * cross-process diagnostics file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { VoiceProviderRegistry } from '../platform/src/platform/voice/provider-registry.js';
import { VoiceService } from '../platform/src/platform/voice/service.js';
import type { VoiceProvider } from '../platform/src/platform/voice/types.js';
import { resolveAudioInput, voiceFetch } from '../platform/src/platform/voice/providers/shared.js';
import { createMicrosoftProvider } from '../platform/src/platform/voice/providers/microsoft.js';
import { createDeepgramProvider } from '../platform/src/platform/voice/providers/deepgram.js';
import { createLocalVoiceProvider } from '../platform/src/platform/voice/providers/local.js';
import { transcribeThroughBestRoute, SttRoutesExhaustedError, type SttRouteCandidate } from '../platform/src/platform/voice/stt-routing.js';
import { WakeDetector } from '../platform/src/platform/voice/wake/detector.js';
import { preconfigureLocalVoiceKeys } from '../platform/src/platform/voice/provisioning/config-preconfigure.js';
import { provisionLocalVoiceRuntime } from '../platform/src/platform/voice/provisioning/provisioner.js';
import { createRecorderCaptureOpener } from '../platform/src/platform/voice/capture/recorder-source.js';
import type { AudioCaptureRequest, CaptureChildProcess } from '../platform/src/platform/voice/capture/index.js';
import { attachSpokenTurnModelRouting } from '../platform/src/platform/voice/spoken-turn-model-routing.js';
import { readVoiceDiagnostics } from '../platform/src/platform/voice/diagnostics.js';
import { TtsTextChunker } from '../platform/src/platform/voice/spoken-turn/text-chunker.js';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-voice-boundaries-'));
  roots.push(dir);
  return dir;
}
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ['DEEPGRAM_API_KEY']) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function working(id: string): VoiceProvider {
  return {
    id,
    label: id,
    capabilities: ['tts', 'voice-list'],
    status: () => ({ id, label: id, state: 'healthy', capabilities: ['tts', 'voice-list'], configured: true, metadata: {} }),
    listVoices: () => [{ id: `${id}-voice`, label: `${id} voice`, metadata: {} }],
  };
}
function broken(id: string): VoiceProvider {
  return {
    id,
    label: id,
    capabilities: ['tts', 'voice-list'],
    status: () => { throw new Error('config revision race'); },
    listVoices: () => { throw new Error('bad key'); },
  };
}

describe('one failing provider does not hide the others', () => {
  test('listVoices without a provider id returns the working providers voices', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(broken('elevenlabs'));
    registry.register(working('openai'));
    const voices = await new VoiceService(registry).listVoices();
    expect(voices.map((voice) => voice.id)).toEqual(['openai-voice']);
  });

  test('listVoices for a named provider still rejects with that provider failure', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(broken('elevenlabs'));
    await expect(new VoiceService(registry).listVoices('elevenlabs')).rejects.toThrow('bad key');
  });

  test('status reports a throwing provider as degraded and keeps the rest', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(broken('local'));
    registry.register(working('openai'));
    const statuses = await registry.status();
    expect(statuses.find((status) => status.id === 'openai')?.state).toBe('healthy');
    const failed = statuses.find((status) => status.id === 'local');
    expect(failed?.state).toBe('degraded');
    expect(failed?.detail).toContain('config revision race');
  });
});

describe('audio uri a cloud provider may fetch', () => {
  for (const uri of [
    'file:///etc/hostname',
    'http://example.com/a.wav',
    'https://127.0.0.1:8080/a.wav',
    'https://localhost/a.wav',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3/a.wav',
    'https://192.168.0.5/a.wav',
    'https://[::1]/a.wav',
    'https://[fd00::1]/a.wav',
    'https://2130706433/a.wav',
    'not a url',
  ]) {
    test(`refuses ${uri} before any request is made`, async () => {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response('x'); }) as unknown as typeof fetch;
      await expect(resolveAudioInput({ mimeType: 'audio/wav', format: 'wav', uri, metadata: {} } as never)).rejects.toThrow();
      expect(calls).toBe(0);
    });
  }

  test('fetches a public https uri without following redirects', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      init = options;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } });
    }) as unknown as typeof fetch;
    const result = await resolveAudioInput({ mimeType: 'audio/mpeg', format: 'mp3', uri: 'https://example.com/a.wav', metadata: {} } as never);
    expect([...result.buffer]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe('audio/wav');
    expect(init?.redirect).toBe('error');
  });
});

describe('a keyless provider is never an unnamed default', () => {
  test('microsoft alone does not resolve for an unnamed tts request but does by name', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(createMicrosoftProvider());
    expect(await registry.resolveProvider('tts')).toBeNull();
    expect(registry.findProvider('tts')).toBeNull();
    expect((await registry.resolveProvider('tts', 'microsoft'))?.id).toBe('microsoft');
  });

  test('an unconfigured keyed provider is still chosen over microsoft', async () => {
    const registry = new VoiceProviderRegistry();
    registry.register(createMicrosoftProvider());
    registry.register({
      id: 'openai',
      label: 'openai',
      capabilities: ['tts'],
      status: () => ({ id: 'openai', label: 'openai', state: 'unconfigured', capabilities: ['tts'], configured: false, metadata: {} }),
    });
    expect((await registry.resolveProvider('tts'))?.id).toBe('openai');
  });
});

describe('a cloud request ends when the caller cancels or the timeout passes', () => {
  function neverAnswers(): typeof fetch {
    return ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      // Like the real fetch: a signal that already aborted rejects at once.
      if (init?.signal?.aborted) { reject(init.signal.reason); return; }
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
  }

  test('transcribe rejects when request.signal aborts', async () => {
    process.env['DEEPGRAM_API_KEY'] = 'test-key';
    globalThis.fetch = neverAnswers();
    const controller = new AbortController();
    const pending = createDeepgramProvider().transcribe!({
      signal: controller.signal,
      audio: { mimeType: 'audio/wav', format: 'wav', dataBase64: 'AAAA', metadata: {} } as never,
    });
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });

  test('voiceFetch rejects with a timeout when the server never answers', async () => {
    globalThis.fetch = neverAnswers();
    await expect(voiceFetch('https://example.com/', {}, 1)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('speech-to-text fallback after the connected host', () => {
  function candidate(route: SttRouteCandidate['route'], transcribe: SttRouteCandidate['transcribe']): SttRouteCandidate {
    return { route, provider: 'p', configSource: 'test', transcribe };
  }
  const audio = { mimeType: 'audio/wav', format: 'wav' } as const;

  test('a host timeout does not transcribe the same audio again in process', async () => {
    let inProcessCalls = 0;
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const error = await transcribeThroughBestRoute(audio, {
      connectedHost: candidate('connected-host', async () => { throw timeout; }),
      inProcess: candidate('in-process', async () => { inProcessCalls++; return 'again'; }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SttRoutesExhaustedError);
    expect(inProcessCalls).toBe(0);
    expect((error as SttRoutesExhaustedError).message).toContain('may already have transcribed');
  });

  test('a host 5xx does not fall back either', async () => {
    let inProcessCalls = 0;
    await expect(transcribeThroughBestRoute(audio, {
      connectedHost: candidate('connected-host', async () => { throw Object.assign(new Error('bad gateway'), { status: 502 }); }),
      inProcess: candidate('in-process', async () => { inProcessCalls++; return 'again'; }),
    })).rejects.toBeInstanceOf(SttRoutesExhaustedError);
    expect(inProcessCalls).toBe(0);
  });

  test('a host that never started (404) still falls back and says so', async () => {
    const result = await transcribeThroughBestRoute(audio, {
      connectedHost: candidate('connected-host', async () => { throw Object.assign(new Error('unknown method'), { status: 404 }); }),
      inProcess: candidate('in-process', async () => 'hello'),
    });
    expect(result.text).toBe('hello');
    expect(result.explanation).toContain('connected host was tried first');
  });
});

describe('wake cooldown', () => {
  const tuning = { threshold: 0.5, patienceFrames: 1, cooldownMs: 2000 };

  test('a clock stepped backwards by an hour does not keep the detector deaf', () => {
    const detector = new WakeDetector(tuning);
    expect(detector.push(0.9, 1_000_000).kind).toBe('fired');
    const stepped = 1_000_000 - 3_600_000;
    expect(detector.push(0.9, stepped).kind).toBe('fired');
    // The new timeline then gets an ordinary cooldown.
    expect(detector.push(0.9, stepped + 500).kind).toBe('cooldown');
    expect(detector.push(0.9, stepped + 2500).kind).toBe('fired');
  });

  test('the ordinary cooldown still suppresses and reports what is left', () => {
    const detector = new WakeDetector(tuning);
    detector.push(0.9, 1_000_000);
    expect(detector.cooldownRemaining(1_000_500)).toBe(1500);
    expect(detector.push(0.9, 1_000_500).kind).toBe('cooldown');
    expect(detector.cooldownRemaining(1_002_000)).toBe(0);
  });
});

describe('install config ownership', () => {
  test('an engine chosen by the user keeps its family: empty binary and model are not filled from another engine', () => {
    const config = new Map<string, string>([['voice.local.sttEngine', 'faster-whisper']]);
    const writes: string[] = [];
    const receipt = preconfigureLocalVoiceKeys({
      getConfig: (key) => config.get(key) ?? '',
      setConfig: (key, value) => { writes.push(key); config.set(key, value); },
      ttsEngine: 'piper',
      ttsBinary: '/m/engines/piper/piper',
      ttsModelPath: '/m/models/v.onnx',
      sttEngine: 'whisper-cpp',
      sttBinary: '/m/engines/whisper/whisper-cli',
      sttModelPath: '/m/models/w.bin',
      managedRoot: '/m',
    });
    expect(writes.filter((key) => key.includes('stt'))).toEqual([]);
    expect(config.get('voice.local.sttEngine')).toBe('faster-whisper');
    expect(config.get('voice.local.sttBinary')).toBeUndefined();
    expect(writes).toContain('voice.local.ttsBinary');
    expect(receipt.skipped.map((entry) => entry.key).sort()).toEqual([
      'voice.local.sttBinary', 'voice.local.sttEngine', 'voice.local.sttModelPath',
    ]);
  });
});

describe('local speech-to-text results', () => {
  function provider(stdout: string, seen: string[] = []) {
    const values: Record<string, string> = {
      'voice.local.sttEngine': 'whisper-cpp',
      'voice.local.sttBinary': '~/bin/whisper-cli',
      'voice.local.sttModelPath': '~/models/w.bin',
    };
    return createLocalVoiceProvider({
      readConfig: (key) => values[key] ?? '',
      fileExists: () => true,
      runner: async (input) => { seen.push(input.binary, ...input.args); return { stdout }; },
    });
  }
  const request = { audio: { mimeType: 'audio/wav', format: 'wav', dataBase64: 'AAAA', metadata: {} } } as never;

  test('an empty transcript is an error, as it is for every cloud provider', async () => {
    await expect(provider('  \n').transcribe!(request)).rejects.toThrow('missing transcript');
  });

  test('a leading ~/ in a configured path is expanded for the spawn', async () => {
    // The test runner pins the home directory, so compare against what the platform reports.
    const home = homedir();
    const seen: string[] = [];
    const result = await provider('hello\n', seen).transcribe!(request);
    expect(result.text).toBe('hello');
    expect(seen[0]).toBe(join(home, 'bin/whisper-cli'));
    expect(seen).toContain(join(home, 'models/w.bin'));
  });
});

describe('recorder shutdown', () => {
  test('a recorder that survives SIGKILL is reported, not silently released', async () => {
    const signals: string[] = [];
    const child: CaptureChildProcess = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill(signal) { signals.push(signal ?? 'SIGTERM'); },
    };
    const warnings: string[] = [];
    const request: AudioCaptureRequest = { backend: 'parecord', device: '', noiseSuppression: 'none', frameSamples: 4 };
    const stream = await createRecorderCaptureOpener({
      spawn: () => child,
      isInstalled: () => true,
      platform: 'linux',
      termGraceMs: 0,
      killGraceMs: 0,
      warn: (message) => { warnings.push(message); },
    })(request, { onFrame() {}, onStopped() {} });
    await stream.stop();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(warnings.some((message) => message.includes('may still hold the audio device'))).toBe(true);
  });
});

describe('managed install', () => {
  test('leftovers of a killed install are removed before the next one', async () => {
    const root = scratch();
    const engines = join(root, 'engines');
    mkdirSync(join(engines, '.extract-abc'), { recursive: true });
    mkdirSync(join(engines, 'piper.old'), { recursive: true });
    writeFileSync(join(engines, '.deadbeef.part'), 'x');
    writeFileSync(join(engines, 'keep.txt'), 'x');
    await provisionLocalVoiceRuntime({ managedRoot: root, platform: null });
    expect(readdirSync(engines)).toEqual(['keep.txt']);
    expect(existsSync(join(root, '.provision.lock'))).toBe(false);
  });
});

describe('spoken-turn model routing attachment', () => {
  const routing = () => ({ providerRegistry: {} as never, configManager: new ConfigManager({ configDir: scratch() }) });

  test('attaching to an orchestrator without runTurn fails loudly', () => {
    expect(() => attachSpokenTurnModelRouting({ ...routing(), orchestrator: { setCoreServices() {} } as never }))
      .toThrow('no runTurn');
  });

  test('detaching leaves a wrapper added after it in place and a second attach is refused', async () => {
    const orchestrator = { runTurn: async () => {}, setCoreServices() {} } as unknown as { runTurn: () => Promise<void> };
    const detach = attachSpokenTurnModelRouting({ ...routing(), orchestrator: orchestrator as never });
    expect(() => attachSpokenTurnModelRouting({ ...routing(), orchestrator: orchestrator as never })).toThrow('already attached');
    const later = async (): Promise<void> => {};
    orchestrator.runTurn = later;
    detach();
    expect(orchestrator.runTurn).toBe(later);
  });
});

describe('diagnostics written by two processes', () => {
  test('both processes entries survive', async () => {
    const root = scratch();
    const module = new URL('../platform/src/platform/voice/diagnostics.ts', import.meta.url).pathname;
    const script = `
      import { recordVoiceDiagnostic } from ${JSON.stringify(module)};
      for (let i = 0; i < 10; i++) recordVoiceDiagnostic(process.argv[1], {
        at: new Date().toISOString(), operation: 'stt', route: 'in-process', ok: false,
        provider: process.argv[2] + '-' + i, configSource: 'test', error: 'x',
      });
    `;
    const run = (tag: string) => Bun.spawn([process.execPath, '-e', script, root, tag], { stdout: 'ignore', stderr: 'pipe' });
    const [a, b] = [run('a'), run('b')];
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    const providers = readVoiceDiagnostics(root).map((entry) => entry.provider).sort();
    expect(providers).toHaveLength(20);
  });
});

describe('spoken text screening', () => {
  test('a credential declaration split across deltas is still refused', () => {
    const chunker = new TtsTextChunker();
    chunker.push('The setting is api_');
    expect(() => chunker.push('key=sk-live-abcdefghijklmnop12345')).toThrow(expect.objectContaining({ problem: 'credential-material' }));
  });
});
