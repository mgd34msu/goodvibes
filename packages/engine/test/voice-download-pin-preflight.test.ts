import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerifiedFile, fileMatches, fileMatchesCached } from '../platform/src/platform/voice/provisioning/download-verified.js';

const bytes = Buffer.from('original verified voice bytes');
// Independent fixed pin of the fixture bytes, not another setup computation.
const pin = '05f7b966da4390ab8c048758ee302c18b8582b612ed3c68ac872880a629b77f3';

test.each(['', 'not-a-pin', 'a'.repeat(63), 'f'.repeat(65)])('an impossible voice pin %j does no file hashing or download; a valid pin still verifies actual bytes', async invalid => {
  const root = mkdtempSync(join(tmpdir(), 'voice-pin-preflight-'));
  const existing = join(root, 'existing'), target = join(root, 'downloaded');
  writeFileSync(existing, bytes);
  let requests = 0;
  const fetchImpl: typeof fetch = Object.assign(async () => { requests++; return new Response(bytes); }, { preconnect() {} });
  const digest = spyOn(crypto, 'createHash');
  try {
    const spec = { url: 'https://example.test/voice', bytes: bytes.length, sha256: invalid };
    expect(fileMatches(existing, spec)).toBe(false);
    expect(fileMatchesCached(existing, spec)).toBe(false);
    expect(await downloadVerifiedFile({ spec, destPath: existing, fetchImpl })).toMatchObject({ ok: false, reason: 'checksum-mismatch' });
    expect(requests).toBe(0); expect(digest).toHaveBeenCalledTimes(0);
    expect(readFileSync(existing).equals(bytes)).toBe(true);
    expect(await downloadVerifiedFile({ spec: { ...spec, sha256: pin }, destPath: target, fetchImpl })).toMatchObject({ ok: true, skipped: false });
    expect(requests).toBe(1); expect(digest).toHaveBeenCalledTimes(1);
    expect(readFileSync(target).equals(bytes)).toBe(true);
  } finally { digest.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('a voice download verifies its original declared pin even when the caller changes the spec during fetch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-pin-owner-')), target = join(root, 'downloaded');
  const spec = { url: 'https://example.test/original-voice', bytes: bytes.length, sha256: '0'.repeat(64) };
  const requests: string[] = [];
  try {
    const result = await downloadVerifiedFile({ spec, destPath: target, fetchImpl: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input)); spec.sha256 = pin; return new Response(bytes);
    }, { preconnect() {} }) });
    expect(result).toMatchObject({ ok: false, reason: 'checksum-mismatch' });
    expect(requests).toEqual(['https://example.test/original-voice']);
    expect(existsSync(target)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cached voice status compares and retains the same originally observed pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-pin-status-')), path = join(root, 'existing');
  writeFileSync(path, bytes);
  let reads = 0;
  const spec = { url: 'https://example.test/voice', bytes: bytes.length,
    get sha256() { return ++reads === 1 ? '0'.repeat(64) : pin; } };
  try {
    expect(fileMatchesCached(path, spec)).toBe(false);
    expect(reads).toBe(1);
    expect(fileMatchesCached(path, { ...spec, sha256: '0'.repeat(64) })).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    fileMatchesCached(path, { url: spec.url, bytes: bytes.length, sha256: pin });
  }
});
