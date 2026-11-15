import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerifiedFile } from '../platform/src/platform/voice/provisioning/download-verified.js';
import { VOICE_RUNTIMES_ORIGINS, voiceRuntimesAsset } from '../platform/src/platform/voice/provisioning/runtime-origins.js';
import { WHISPER_ENGINES } from '../platform/src/platform/voice/provisioning/manifest.js';
import { WAKE_WORD_FRONT_END } from '../platform/src/platform/voice/provisioning/wake-word-manifest.js';
import { checkVoiceRuntimeUrls, pinnedVoiceUrls } from '../scripts/check-voice-runtime-urls.ts';

const good = Buffer.from('pinned voice asset bytes');
const sha256 = createHash('sha256').update(good).digest('hex');
const asFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(impl, { preconnect() {} }) as typeof fetch;

function withRoot<T>(run: (dest: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'voice-mirror-'));
  return run(join(root, 'asset')).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('a download whose first origin is gone installs from the next origin and still verifies the pin', () =>
  withRoot(async (dest) => {
    const requested: string[] = [];
    const spec = { url: 'https://a.test/x', fallbackUrls: ['https://b.test/x'], bytes: good.length, sha256 };
    const result = await downloadVerifiedFile({
      spec, destPath: dest,
      fetchImpl: asFetch(async (url) => { requested.push(url); return url.startsWith('https://a.test') ? new Response('gone', { status: 404 }) : new Response(good); }),
    });
    expect(result).toMatchObject({ ok: true, skipped: false });
    expect(requested).toEqual(['https://a.test/x', 'https://b.test/x']);
    expect(readFileSync(dest).equals(good)).toBe(true);
  }));

test('a mirror serving the wrong bytes is refused and nothing is installed', () =>
  withRoot(async (dest) => {
    const spec = { url: 'https://a.test/x', fallbackUrls: ['https://b.test/x'], bytes: good.length, sha256 };
    const tampered = Buffer.from('x'.repeat(good.length));
    expect(tampered.length).toBe(good.length);
    const result = await downloadVerifiedFile({
      spec, destPath: dest,
      fetchImpl: asFetch(async (url) => url.startsWith('https://a.test') ? new Response('', { status: 503 }) : new Response(tampered)),
    });
    expect(result).toMatchObject({ ok: false, reason: 'download-failed' });
    expect(result.ok === false && result.error).toContain('sha256 mismatch');
    expect(existsSync(dest)).toBe(false);
  }));

test('the first origin is not contacted again once it succeeds', () =>
  withRoot(async (dest) => {
    const requested: string[] = [];
    const spec = { url: 'https://a.test/x', fallbackUrls: ['https://b.test/x'], bytes: good.length, sha256 };
    await downloadVerifiedFile({ spec, destPath: dest, fetchImpl: asFetch(async (url) => { requested.push(url); return new Response(good); }) });
    expect(requested).toEqual(['https://a.test/x']);
  }));

test('the pinned whisper bundle and wake-word assets list every voice runtime origin, canonical first', () => {
  const bundle = WHISPER_ENGINES['linux-x64']!.bundle;
  const expected = VOICE_RUNTIMES_ORIGINS.map((o) => `${o}/goodvibes-whisper-cpp-1.8.2-linux-x64.tar.gz`);
  expect([bundle.url, ...(bundle.fallbackUrls ?? [])]).toEqual(expected);
  expect(VOICE_RUNTIMES_ORIGINS.length).toBeGreaterThan(1);
  expect(WAKE_WORD_FRONT_END.embedding.download.fallbackUrls).toEqual(voiceRuntimesAsset('goodvibes-speech-embedding-1.0.0.onnx').fallbackUrls);
});

test('the release check fails an asset no origin serves and only warns about a missing mirror', async () => {
  const pinned = [{ asset: 'a.bin', origins: ['https://a.test/a', 'https://b.test/a'] }, { asset: 'b.bin', origins: ['https://a.test/b', 'https://b.test/b'] }];
  const methods: string[] = [];
  const report = await checkVoiceRuntimeUrls(pinned, asFetch(async (url, init) => {
    methods.push(init?.method ?? 'GET');
    if (url === 'https://a.test/a') return new Response('', { status: 404 });
    if (url.endsWith('/b')) throw new Error('offline');
    return new Response('');
  }));
  expect(report.missingFromOrigin).toEqual(['a.bin @ https://a.test/a']);
  expect(report.unavailable).toEqual(['b.bin']);
  expect(new Set(methods)).toEqual(new Set(['HEAD']));
  expect(pinnedVoiceUrls().length).toBeGreaterThan(5);
});
