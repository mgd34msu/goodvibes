/**
 * What the OpenAI, Google and Vydra voice providers send, how they fail on an
 * empty answer, and that a caller's cancel reaches every request they make; plus
 * the engine swap and the install progress tracker.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAIProvider } from '../platform/src/platform/voice/providers/openai.js';
import { createGoogleProvider } from '../platform/src/platform/voice/providers/google.js';
import { createVydraProvider } from '../platform/src/platform/voice/providers/vydra.js';
import { extractEngineAtomically } from '../platform/src/platform/voice/provisioning/provisioner.js';
import { createVoiceInstallProgressTracker } from '../platform/src/platform/voice/provisioning/install-progress.js';

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const roots: string[] = [];
const KEYS = ['OPENAI_API_KEY', 'OPENAI_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_API_KEY', 'GEMINI_API_BASE_URL', 'GOOGLE_API_BASE_URL', 'VYDRA_API_KEY', 'VYDRA_BASE_URL'];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-voice-requests-'));
  roots.push(dir);
  return dir;
}
function clearKeys(): void {
  for (const key of KEYS) delete process.env[key];
}

interface Seen { readonly url: string; readonly init: RequestInit }
/** Answers each call from `answers` in order and records what was sent. */
function fakeFetch(answers: Array<(seen: Seen) => Response | Promise<Response>>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(url), init: init ?? {} };
    seen.push(entry);
    const answer = answers[seen.length - 1];
    if (!answer) throw new Error(`unexpected request ${seen.length}: ${entry.url}`);
    return await answer(entry);
  }) as unknown as typeof fetch;
  return seen;
}
const json = (body: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(body), { status: 200, ...init });
/** A request that only ends when the caller's signal aborts, like a server that never answers. */
const hangs = ({ init }: Seen): Promise<Response> => new Promise<Response>((_resolve, reject) => {
  if (init.signal?.aborted) { reject(init.signal.reason); return; }
  init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
});
const wav = { mimeType: 'audio/wav', format: 'wav', dataBase64: 'AAAA', metadata: {} } as never;

describe('OpenAI provider requests', () => {
  test('transcribe posts a multipart form with the bearer key and returns the transcript', async () => {
    clearKeys();
    process.env['OPENAI_API_KEY'] = 'sk-test';
    const seen = fakeFetch([() => json({ text: ' hello there ', language: 'en' })]);
    const result = await createOpenAIProvider().transcribe!({ audio: wav, language: 'en', prompt: 'names' });
    expect(result.text).toBe('hello there');
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((seen[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    const form = seen[0]!.init.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('names');
  });

  test('an empty transcript is an error, not an empty success', async () => {
    clearKeys();
    process.env['OPENAI_API_KEY'] = 'sk-test';
    fakeFetch([() => json({ text: '   ' })]);
    await expect(createOpenAIProvider().transcribe!({ audio: wav })).rejects.toThrow('missing transcript');
  });

  test('transcribe and synthesize reject when the caller cancels', async () => {
    clearKeys();
    process.env['OPENAI_API_KEY'] = 'sk-test';
    for (const run of [
      (signal: AbortSignal) => createOpenAIProvider().transcribe!({ audio: wav, signal }),
      (signal: AbortSignal) => createOpenAIProvider().synthesize!({ text: 'hi', signal }),
    ]) {
      fakeFetch([hangs]);
      const controller = new AbortController();
      const pending = run(controller.signal);
      controller.abort(new Error('user cancelled'));
      await expect(pending).rejects.toThrow('user cancelled');
    }
  });

  test('synthesize sends the text, voice and format and returns base64 audio', async () => {
    clearKeys();
    process.env['OPENAI_API_KEY'] = 'sk-test';
    const seen = fakeFetch([() => new Response(new Uint8Array([1, 2, 3]))]);
    const result = await createOpenAIProvider().synthesize!({ text: 'hi', voiceId: 'nova', format: 'wav' });
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ input: 'hi', voice: 'nova', response_format: 'wav' });
    expect(result.audio.dataBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });
});

describe('Google provider requests', () => {
  const reply = { candidates: [{ content: { parts: [{ text: 'turn left' }] } }] };

  test('small audio goes inline with the key header', async () => {
    clearKeys();
    process.env['GEMINI_API_KEY'] = 'g-key';
    const seen = fakeFetch([() => json(reply)]);
    const result = await createGoogleProvider().transcribe!({ audio: wav });
    expect(result.text).toBe('turn left');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain(':generateContent');
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    expect(JSON.parse(String(seen[0]!.init.body)).contents[0].parts[1].inline_data.mime_type).toBe('audio/wav');
  });

  test('an answer without a transcript is an error', async () => {
    clearKeys();
    process.env['GEMINI_API_KEY'] = 'g-key';
    fakeFetch([() => json({ candidates: [] })]);
    await expect(createGoogleProvider().transcribe!({ audio: wav })).rejects.toThrow('missing transcript');
  });

  test('the Files API path uploads, transcribes from the file, then deletes it', async () => {
    clearKeys();
    process.env['GEMINI_API_KEY'] = 'g-key';
    const seen = fakeFetch([
      () => new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example.com/u1' } }),
      () => json({ file: { name: 'files/abc', uri: 'https://files.example.com/abc', mimeType: 'audio/wav' } }),
      () => json(reply),
      () => json({}),
    ]);
    const result = await createGoogleProvider().transcribe!({ audio: wav, metadata: { preferFilesApi: true } });
    expect(result.metadata['uploadMode']).toBe('file');
    expect(seen.map((entry) => entry.init.method)).toEqual(['POST', 'POST', 'POST', 'DELETE']);
    expect(JSON.parse(String(seen[2]!.init.body)).contents[0].parts[0].file_data.file_uri).toBe('https://files.example.com/abc');
    expect(seen[3]!.url).toContain('files/abc');
  });

  test('cancelling during the Files API upload start rejects at once', async () => {
    clearKeys();
    process.env['GEMINI_API_KEY'] = 'g-key';
    const seen = fakeFetch([hangs]);
    const controller = new AbortController();
    const pending = createGoogleProvider().transcribe!({ audio: wav, metadata: { preferFilesApi: true }, signal: controller.signal });
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(seen[0]!.init.signal).toBeDefined();
  });

  test('cancelling during the Files API finalize rejects at once', async () => {
    clearKeys();
    process.env['GEMINI_API_KEY'] = 'g-key';
    fakeFetch([
      () => new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example.com/u1' } }),
      hangs,
    ]);
    const controller = new AbortController();
    const pending = createGoogleProvider().transcribe!({ audio: wav, metadata: { preferFilesApi: true }, signal: controller.signal });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });
});

describe('Vydra provider requests', () => {
  test('synthesize posts the text, then downloads the audio it names', async () => {
    clearKeys();
    process.env['VYDRA_API_KEY'] = 'v-key';
    const seen = fakeFetch([
      () => json({ audio_url: 'https://cdn.example.com/a.wav' }),
      () => new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'audio/wav' } }),
    ]);
    const result = await createVydraProvider().synthesize!({ text: 'hello' });
    expect(seen[0]!.url).toBe('https://www.vydra.ai/api/v1/models/elevenlabs/tts');
    expect(JSON.parse(String(seen[0]!.init.body)).text).toBe('hello');
    expect(seen[1]!.url).toBe('https://cdn.example.com/a.wav');
    expect(result.audio.format).toBe('wav');
  });

  test('a reply naming no audio is an error', async () => {
    clearKeys();
    process.env['VYDRA_API_KEY'] = 'v-key';
    fakeFetch([() => json({})]);
    await expect(createVydraProvider().synthesize!({ text: 'hello' })).rejects.toThrow('missing audio URL');
  });

  test('cancelling during the audio download rejects at once', async () => {
    clearKeys();
    process.env['VYDRA_API_KEY'] = 'v-key';
    fakeFetch([() => json({ audio_url: 'https://cdn.example.com/a.wav' }), hangs]);
    const controller = new AbortController();
    const pending = createVydraProvider().synthesize!({ text: 'hello', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });
});

describe('engine extraction swap', () => {
  function writeTree(root: string, topDir: string, content: string, executable = true): void {
    mkdirSync(join(root, topDir), { recursive: true });
    const binary = join(root, topDir, 'bin');
    writeFileSync(binary, content);
    chmodSync(binary, executable ? 0o755 : 0o644);
  }

  test('a fresh extract lands at the final path with nothing left beside it', async () => {
    const engines = scratch();
    await extractEngineAtomically(engines, join(engines, 'a.tar.gz'), 'piper/bin', async (_archive, dest) => writeTree(dest, 'piper', 'new'));
    expect(readFileSync(join(engines, 'piper', 'bin'), 'utf8')).toBe('new');
    expect(readdirSync(engines)).toEqual(['piper']);
  });

  test('an existing tree is replaced and the old one removed', async () => {
    const engines = scratch();
    writeTree(engines, 'piper', 'old');
    writeFileSync(join(engines, 'piper', 'stale.txt'), 'x');
    await extractEngineAtomically(engines, join(engines, 'a.tar.gz'), 'piper/bin', async (_archive, dest) => writeTree(dest, 'piper', 'new'));
    expect(readFileSync(join(engines, 'piper', 'bin'), 'utf8')).toBe('new');
    expect(existsSync(join(engines, 'piper', 'stale.txt'))).toBe(false);
    expect(readdirSync(engines)).toEqual(['piper']);
  });

  test('a failed or unusable extract leaves the installed tree untouched and no temp directory', async () => {
    const engines = scratch();
    writeTree(engines, 'piper', 'old');
    await expect(extractEngineAtomically(engines, 'x', 'piper/bin', async () => { throw new Error('tar died'); })).rejects.toThrow('tar died');
    await expect(extractEngineAtomically(engines, 'x', 'piper/bin', async (_archive, dest) => writeTree(dest, 'piper', 'new', false)))
      .rejects.toThrow('missing a usable binary');
    await expect(extractEngineAtomically(engines, 'x', 'piper/bin', async (_archive, dest) => writeTree(dest, 'piper', '')))
      .rejects.toThrow('missing a usable binary');
    expect(readFileSync(join(engines, 'piper', 'bin'), 'utf8')).toBe('old');
    expect(readdirSync(engines)).toEqual(['piper']);
  });
});

describe('install progress tracker', () => {
  test('progress outside an active install is dropped and the snapshot is null', () => {
    const tracker = createVoiceInstallProgressTracker(() => 5);
    tracker.onProgress({ component: 'piper', phase: 'download' });
    expect(tracker.snapshot()).toBeNull();
    tracker.begin();
    expect(tracker.snapshot()).toEqual({ startedAt: 5, components: [] });
    tracker.end();
    expect(tracker.snapshot()).toBeNull();
  });

  test('the latest phase wins and byte totals survive a later event without them', () => {
    const tracker = createVoiceInstallProgressTracker(() => 7);
    tracker.begin();
    tracker.onProgress({ component: 'piper', phase: 'download', bytesTotal: 100 });
    tracker.onProgress({ component: 'voice', phase: 'skip' });
    tracker.onProgress({ component: 'piper', phase: 'extract', message: 'unpacking', bytesDone: 100 });
    expect(tracker.snapshot()!.components).toEqual([
      { component: 'piper', phase: 'extract', message: 'unpacking', bytesTotal: 100, bytesDone: 100 },
      { component: 'voice', phase: 'skip' },
    ]);
  });

  test('a new install starts from nothing', () => {
    const tracker = createVoiceInstallProgressTracker(() => 1);
    tracker.begin();
    tracker.onProgress({ component: 'piper', phase: 'done' });
    tracker.begin();
    expect(tracker.snapshot()!.components).toEqual([]);
  });
});
