/**
 * artifact-upload-http-wire.test.ts
 *
 * Real bootDaemon proof that binary/multipart artifact uploads work over the
 * live wire (isolated home, ephemeral port, token auth, the boot-daemon-factory
 * pattern), not just against a directly-invoked handler:
 *
 *   - a raw binary upload (non-UTF-8 bytes, e.g. a PNG-shaped buffer) round-trips
 *     byte-identical through GET .../content, with the content-type preserved.
 *   - a multipart/form-data upload round-trips the same way.
 *   - an upload past the configured artifact-size cap gets an honest 413 that
 *     states the byte limit, never a silent truncation.
 *   - ordinary small JSON artifact-create bodies are unaffected by the upload
 *     hardening, and an oversized JSON body still gets an honest 413 that states
 *     the JSON body's own byte limit.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../platform/src/platform/daemon/boot.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { useArtifactKindReadings } from './helpers/artifact-kind-readings.ts';
import { waitFor } from './_helpers/test-timeout.ts';

// beforeEach runs after bootDaemon's beforeAll composition installed its live
// port, and afterEach restores that port before the daemon is stopped.
const readings = useArtifactKindReadings();

const TOKEN = 'artifact-wire-token';

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/** A deterministic, non-UTF-8-safe binary buffer (every byte value 0-255, repeated). */
function binaryFixture(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) bytes[i] = i % 256;
  return bytes;
}

/**
 * What an in-flight upload holds on disk: the store's content file before its metadata exists (a finished
 * artifact has both files, a failed write neither), and the multipart parser's temporary directory.
 */
function spoolFiles(home: string): string[] {
  try {
    const entries = readdirSync(home, { recursive: true, encoding: 'utf8' });
    const present = new Set(entries);
    const content = entries.filter((entry) => /(^|\/)artifact-[A-Za-z0-9-]+\.data$/.test(entry) && !present.has(`${entry.slice(0, -'.data'.length)}.json`));
    const parsing = readdirSync(tmpdir()).filter((entry) => entry.startsWith('goodvibes-upload-'));
    return [...content, ...parsing];
  } catch {
    return [];
  }
}

describe('raw and multipart artifact uploads round-trip over a real daemon', () => {
  let home: string;
  let work: string;
  let daemon: BootedDaemon;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'artifact-wire-home-'));
    work = mkdtempSync(join(tmpdir(), 'artifact-wire-work-'));
    seedBenchmarkCache(home, 'goodvibes');
    daemon = await bootDaemon({
      homeDirectory: home,
      workingDir: work,
      daemonHomeDir: join(home, 'daemon'),
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('a raw binary upload above the old ~1 MiB JSON cap is retrievable byte-identical with content-type intact', async () => {
    // 2 MiB, comfortably past the JSON body's 1 MiB cap, proving this path
    // does not go through the JSON parser at all.
    const bytes = binaryFixture(2 * 1024 * 1024);

    const createRes = await fetch(`${daemon.url}/api/artifacts?filename=fixture.bin`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: bytes,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { artifact: { id: string; mimeType: string; sizeBytes: number; filename: string } };
    expect(created.artifact.sizeBytes).toBe(bytes.byteLength);
    expect(created.artifact.mimeType).toBe('application/octet-stream');
    expect(created.artifact.filename).toBe('fixture.bin');
    const kindRequests = readings.requests.filter((request) => request.context?.battery === 'engine.artifacts.kind');
    expect(kindRequests).toHaveLength(0);
    expect(Object.hasOwn(created.artifact, 'sha256')).toBe(false);

    const contentRes = await fetch(`${daemon.url}/api/artifacts/${created.artifact.id}/content`, {
      headers: authHeaders(),
    });
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get('content-type')).toBe('application/octet-stream');
    expect(contentRes.headers.get('content-length')).toBe(String(bytes.byteLength));
    const roundTripped = new Uint8Array(await contentRes.arrayBuffer());
    expect(roundTripped.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(roundTripped).equals(Buffer.from(bytes))).toBe(true);
  });

  test('a multipart/form-data upload round-trips byte-identical with content-type intact', async () => {
    const bytes = binaryFixture(1_500_000);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'photo.png');

    const createRes = await fetch(`${daemon.url}/api/artifacts`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { artifact: { id: string; mimeType: string; sizeBytes: number; filename: string } };
    expect(created.artifact.sizeBytes).toBe(bytes.byteLength);
    expect(created.artifact.mimeType).toBe('image/png');
    expect(created.artifact.filename).toBe('photo.png');
    expect(Object.hasOwn(created.artifact, 'sha256')).toBe(false);

    const contentRes = await fetch(`${daemon.url}/api/artifacts/${created.artifact.id}/content`, {
      headers: authHeaders(),
    });
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get('content-type')).toBe('image/png');
    expect(contentRes.headers.get('content-length')).toBe(String(bytes.byteLength));
    const roundTripped = new Uint8Array(await contentRes.arrayBuffer());
    expect(roundTripped.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(roundTripped).equals(Buffer.from(bytes))).toBe(true);
  });

  test('ordinary small JSON artifact-create bodies are unaffected by the upload hardening', async () => {
    const res = await fetch(`${daemon.url}/api/artifacts`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'text', mimeType: 'text/plain', filename: 'note.txt', text: 'a small inline note' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { artifact: { id: string; mimeType: string } };
    expect(body.artifact.mimeType).toBe('text/plain');
  });

  test.each(['raw', 'multipart'] as const)('a %s upload whose client disconnects mid-body admits no artifact and leaves no spool behind', async (mode) => {
    const beforeResponse = await fetch(`${daemon.url}/api/artifacts`, { headers: authHeaders() });
    expect(beforeResponse.status).toBe(200);
    const before: unknown = await beforeResponse.json();

    // The declared length is far past what is sent, so the server is still reading when the client goes away.
    const declaredBytes = 4 * 1024 * 1024;
    const sentBytes = Buffer.from(binaryFixture(64 * 1024));
    const boundary = 'goodvibes-abort-boundary';
    const multipartHead = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="aborted.bin"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    );
    const head = [
      `POST /api/artifacts${mode === 'raw' ? '?filename=aborted.bin' : ''} HTTP/1.1`,
      `host: 127.0.0.1:${daemon.port}`,
      `authorization: Bearer ${TOKEN}`,
      `content-type: ${mode === 'raw' ? 'application/octet-stream' : `multipart/form-data; boundary=${boundary}`}`,
      `content-length: ${declaredBytes + (mode === 'multipart' ? multipartHead.byteLength : 0)}`,
      'connection: close',
      '',
      '',
    ].join('\r\n');

    const socket = connect({ host: '127.0.0.1', port: daemon.port });
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(Buffer.concat([Buffer.from(head), ...(mode === 'multipart' ? [multipartHead] : []), sentBytes]));

    // The server has begun reading once it has opened a spool for the body.
    await waitFor(() => spoolFiles(home).length > 0);
    socket.destroy();

    await waitFor(() => spoolFiles(home).length === 0);
    const afterResponse = await fetch(`${daemon.url}/api/artifacts`, { headers: authHeaders() });
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toEqual(before);
    expect(readings.requests.filter((request) => request.context?.battery === 'engine.artifacts.kind')).toHaveLength(0);
  });
});

describe('over-cap uploads get an honest 413 that states the limit, never a silent truncation', () => {
  let home: string;
  let work: string;
  let daemon: BootedDaemon;
  // The config schema enforces a 1 MiB floor on storage.artifacts.maxBytes
  // (see schema-domain-core.ts intRange(1 MiB, 10 GiB)), this test uses that
  // floor as the configured cap and uploads comfortably past it.
  const ARTIFACT_MAX_BYTES = 1 * 1024 * 1024;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'artifact-wire-cap-home-'));
    work = mkdtempSync(join(tmpdir(), 'artifact-wire-cap-work-'));
    const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes' });
    configManager.set('storage.artifacts.maxBytes', ARTIFACT_MAX_BYTES);
    seedBenchmarkCache(home, 'goodvibes');
    daemon = await bootDaemon({
      homeDirectory: home,
      workingDir: work,
      daemonHomeDir: join(home, 'daemon'),
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      configManager,
    });
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('a raw binary upload past the configured artifact cap is refused with the limit stated, and nothing is stored', async () => {
    const bytes = binaryFixture(ARTIFACT_MAX_BYTES + 2 * 1024 * 1024);

    const res = await fetch(`${daemon.url}/api/artifacts?filename=too-big.bin`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: bytes,
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toContain(`${ARTIFACT_MAX_BYTES}-byte limit`);

    const listRes = await fetch(`${daemon.url}/api/artifacts`, { headers: authHeaders() });
    const list = await listRes.json() as { artifacts: unknown[] };
    expect(list.artifacts).toHaveLength(0);
  });

  test('a multipart upload past the configured artifact cap is refused with the limit stated, and nothing is stored', async () => {
    const bytes = binaryFixture(ARTIFACT_MAX_BYTES * 4);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'too-big.pdf');

    const res = await fetch(`${daemon.url}/api/artifacts`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toContain(`${ARTIFACT_MAX_BYTES}-byte limit`);

    const listRes = await fetch(`${daemon.url}/api/artifacts`, { headers: authHeaders() });
    const list = await listRes.json() as { artifacts: unknown[] };
    expect(list.artifacts).toHaveLength(0);
  });

  test('an oversized JSON body on the same route is refused 413 with its own byte limit stated (the JSON path is unaffected by the artifact cap)', async () => {
    // dataBase64 padding pushes the JSON body well past the 1 MiB JSON cap,
    // this must fail on the JSON body-size guard, NOT the (much smaller, here)
    // artifact-store cap, proving the two limits are independent.
    const oversizedJson = JSON.stringify({
      kind: 'file',
      mimeType: 'text/plain',
      filename: 'oversized.txt',
      dataBase64: Buffer.alloc(1_200_000, 'a').toString('base64'),
    });

    const res = await fetch(`${daemon.url}/api/artifacts`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: oversizedJson,
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('1048576-byte limit');
  });
});
