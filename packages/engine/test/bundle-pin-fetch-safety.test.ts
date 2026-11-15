import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeBundleSource,
  computeSha256,
  fetchAndVerifyBundle,
  type PinnedBundleSource,
} from '../platform/src/platform/runtime/ecosystem/bundle-pin.ts';

const PIN = 'a'.repeat(64);

test('a git ref or remote that a fetching program would read as an option is refused before any archive runs', async () => {
  let archived = 0;
  const gitArchive = () => { archived += 1; return new Uint8Array(); };
  for (const source of [
    { kind: 'git', location: 'git@host:repo.git', ref: '--exec=touch /tmp/x', sha256: PIN },
    { kind: 'git', location: '--upload-pack=touch /tmp/x', ref: 'v1', sha256: PIN },
    { kind: 'git', location: 'ext::sh -c touch% /tmp/x', ref: 'v1', sha256: PIN },
  ] satisfies PinnedBundleSource[]) {
    await expect(fetchAndVerifyBundle(source, { gitArchive })).rejects.toThrow('refused');
  }
  expect(archived).toBe(0);
});

test('a plain git remote and tag still reach the archive step', async () => {
  const bytes = new TextEncoder().encode('bundle');
  const source: PinnedBundleSource = { kind: 'git', location: 'git@host:repo.git', ref: 'v1.0.0', sha256: computeSha256(bytes) };
  const result = await fetchAndVerifyBundle(source, { gitArchive: () => bytes });
  expect(result.sha256).toBe(source.sha256);
});

test('a URL source must be https and must not name this machine or an internal address', () => {
  for (const location of [
    'http://example.test/b.json',
    'file:///etc/passwd',
    'https://localhost/b.json',
    'https://127.0.0.1/b.json',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3/b.json',
    'https://[::1]/b.json',
  ]) {
    expect(() => assertSafeBundleSource({ kind: 'url', location, sha256: PIN })).toThrow('refused');
  }
  expect(() => assertSafeBundleSource({ kind: 'url', location: 'https://example.test/b.json', sha256: PIN })).not.toThrow();
});

test('a redirect to an internal address is refused instead of followed', async () => {
  const requested: string[] = [];
  const fetchImpl = (async (url: string) => {
    requested.push(url);
    return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } });
  }) as unknown as typeof fetch;
  await expect(fetchAndVerifyBundle({ kind: 'url', location: 'https://example.test/b.json', sha256: PIN }, { fetchImpl }))
    .rejects.toThrow('internal network');
  expect(requested).toEqual(['https://example.test/b.json']);
});

test('a URL body past the byte cap is refused without being read to the end', async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
      if (pulled > 10_000) controller.close();
    },
  });
  const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
  await expect(fetchAndVerifyBundle({ kind: 'url', location: 'https://example.test/b.json', sha256: PIN }, { fetchImpl, maxBytes: 4096 }))
    .rejects.toThrow('limit');
  expect(pulled).toBeLessThan(20);
});

test('a URL body within the cap is verified against the pin', async () => {
  const bytes = new TextEncoder().encode('{"id":"x"}');
  const fetchImpl = (async () => new Response(bytes)) as unknown as typeof fetch;
  const result = await fetchAndVerifyBundle({ kind: 'url', location: 'https://example.test/b.json', sha256: computeSha256(bytes) }, { fetchImpl });
  expect(result.bytes).toEqual(bytes);
});

test('a file past the byte cap is refused before it is read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-pin-'));
  try {
    const path = join(dir, 'big.json');
    writeFileSync(path, 'x'.repeat(100));
    await expect(fetchAndVerifyBundle({ kind: 'file', location: path, sha256: PIN }, { maxBytes: 10 })).rejects.toThrow('limit');
    await expect(fetchAndVerifyBundle({ kind: 'file', location: dir, sha256: PIN })).rejects.toThrow('regular file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
