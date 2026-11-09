/** Native persisted v2 capture regressions. Source only; execution deferred. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { DeviceCaptureArtifactStore } from '../platform/src/platform/devices/device-capture-artifacts.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const UUID = '12345678-1234-4234-9234-123456789abc';
const originalInput = { nodeId: 'phone-1', capabilityId: 'device.screen.capture' as const, kind: 'image' as const, mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'device-native-capture-')), directory = join(root, 'captures'); mkdirSync(directory, { mode: 0o700 });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, index: join(directory, 'capture-index.json') };
}

test('fresh device captures publish private v2 observations without a synthetic checksum', async () => {
  const f = fixture(), store = new DeviceCaptureArtifactStore(f.directory), capture = await store.retain(originalInput);
  expect(Object.hasOwn(capture, 'sha256')).toBe(false); expect(Object.hasOwn(capture, 'sourceObservation')).toBe(false);
  const saved = JSON.parse(readFileSync(f.index, 'utf8')) as { version: number; artifacts: Record<string, unknown>[] };
  expect(saved.version).toBe(2); expect(typeof saved.artifacts[0]?.['sourceObservation']).toBe('string'); expect(saved.artifacts[0]?.['sha256']).toBeUndefined();
  expect(statSync(store.pathFor(capture)).mode & 0o777).toBe(0o600);
  const reopened = new DeviceCaptureArtifactStore(f.directory), read = await reopened.read(capture.id);
  expect(read.ok).toBe(true); if (read.ok) expect([...read.bytes]).toEqual([1, 2, 3]);
});

test('same-byte physical replacement is unavailable and preserved through later sweeps and restart', async () => {
  const f = fixture(), store = new DeviceCaptureArtifactStore(f.directory), capture = await store.retain(originalInput), path = store.pathFor(capture);
  unlinkSync(path); writeFileSync(path, originalInput.bytes, { mode: 0o600 });
  expect(await store.read(capture.id)).toEqual({ ok: false, reason: 'content-mismatch' }); expect(await store.list()).toEqual([]);
  expect((await store.sweep()).bytesReclaimed).toBe(0);
  const reopened = new DeviceCaptureArtifactStore(f.directory); expect((await reopened.sweep()).bytesReclaimed).toBe(0);
  expect([...readFileSync(path)]).toEqual([1, 2, 3]);
  expect(JSON.parse(readFileSync(f.index, 'utf8')).preservedFiles).toContain(capture.fileName);
});

test.each(['matching', 'damaged'] as const)('saved v1 capture pin migration verifies only its actual earlier bytes (%s)', async kind => {
  const f = fixture(), fileName = `${UUID}.png`, checksum = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  writeFileSync(join(f.directory, fileName), kind === 'matching' ? 'abc' : 'xyz');
  writeFileSync(f.index, JSON.stringify({ version: 1, artifacts: [{ ...originalInput, bytes: undefined, id: UUID, fileName, sha256: checksum,
    byteLength: 3, capturedAt: 1, expiresAt: Date.now() + 60_000 }] }), { mode: 0o600 });
  let declared = 0; const store = new DeviceCaptureArtifactStore(f.directory, { beforeObservationWrite() { declared++; } });
  const read = await store.read(UUID); expect(declared).toBeGreaterThan(0);
  const saved = JSON.parse(readFileSync(f.index, 'utf8')); expect(saved.version).toBe(2);
  if (kind === 'matching') {
    expect(read.ok).toBe(true); expect(saved.artifacts[0].sha256).toBe(checksum); expect(typeof saved.artifacts[0].sourceObservation).toBe('string');
    expect((await new DeviceCaptureArtifactStore(f.directory).read(UUID)).ok).toBe(true);
  } else { expect(read).toEqual({ ok: false, reason: 'content-mismatch' }); expect(saved.preservedFiles).toEqual([fileName]); }
  expect(readFileSync(join(f.directory, fileName), 'utf8')).toBe(kind === 'matching' ? 'abc' : 'xyz');
});

test('a real native writer floor precedes fresh capture bytes and blocks an older same-version reader profile', async () => {
  const f = fixture(), execPath = join(f.root, 'goodvibes-daemon'), native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  let first = true; const store = new DeviceCaptureArtifactStore(f.directory, { beforeObservationWrite() {
    if (first) expect(readdirSync(f.directory).filter(name => name.endsWith('.png'))).toEqual([]); first = false;
    native.declare('device-capture-observations-v2');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
      { ...nativeReaderCapabilities('3.1.2'), formats: nativeReaderCapabilities('3.1.2').formats.filter(name => name !== 'device-capture-observations-v2') })).toThrow();
  } });
  const captured = await store.retain(originalInput); expect(existsSync(store.pathFor(captured))).toBe(true);
});

test('a live capture holds the real index lease so another sweeper cannot delete its unindexed bytes', async () => {
  const f = fixture(), competing = new DeviceCaptureArtifactStore(f.directory); let sweep: Promise<unknown> | undefined;
  const store = new DeviceCaptureArtifactStore(f.directory, { beforeObservationWrite() { sweep ??= competing.sweep(); void sweep.catch(() => {}); } });
  const capture = await store.retain(originalInput); await expect(sweep).rejects.toThrow('writer'); expect((await store.read(capture.id)).ok).toBe(true);
});

test('sweep preserves unproven UUID names and unrelated/index temporary files', async () => {
  const f = fixture(), store = new DeviceCaptureArtifactStore(f.directory); await store.retain(originalInput);
  const orphan = `${UUID}.png`; writeFileSync(join(f.directory, orphan), 'orphan', { mode: 0o600 });
  writeFileSync(join(f.directory, 'notes.txt'), 'keep'); writeFileSync(join(f.directory, 'capture-index.json.tmp.other'), 'keep');
  const report = await store.sweep(); expect(report.bytesReclaimed).toBe(0); expect(readFileSync(join(f.directory, orphan), 'utf8')).toBe('orphan');
  expect(readFileSync(join(f.directory, 'notes.txt'), 'utf8')).toBe('keep'); expect(readFileSync(join(f.directory, 'capture-index.json.tmp.other'), 'utf8')).toBe('keep');
});

test('a failed exclusive capture open preserves the other owner’s same-name file', async () => {
  const f = fixture(), mocked = spyOn(crypto, 'randomUUID').mockReturnValue(UUID); cleanup.push(() => mocked.mockRestore());
  const path = join(f.directory, `${opaqueUuid(UUID)}.png`); writeFileSync(path, 'foreign bytes', { mode: 0o600 });
  const store = new DeviceCaptureArtifactStore(f.directory);
  await expect(store.retain(originalInput)).rejects.toThrow(); expect(readFileSync(path, 'utf8')).toBe('foreign bytes');
  await store.sweep(); expect(readFileSync(path, 'utf8')).toBe('foreign bytes');
});

test('failed format publication cleans only the completed unindexed capture after actual write drainage', async () => {
  const f = fixture(); let declared = 0;
  const store = new DeviceCaptureArtifactStore(f.directory, { beforeObservationWrite() { if (++declared > 2) throw new Error('publisher retired'); } });
  await expect(store.retain(originalInput)).rejects.toThrow('publisher retired'); expect(readdirSync(f.directory)).toEqual([]);
});

test('unsupported index formats remain intact rather than becoming an empty capture namespace', async () => {
  const f = fixture(), bytes = JSON.stringify({ version: 77, artifacts: [] }); writeFileSync(f.index, bytes, { mode: 0o600 });
  await expect(new DeviceCaptureArtifactStore(f.directory).sweep()).rejects.toThrow('format'); expect(readFileSync(f.index, 'utf8')).toBe(bytes);
});


test.each([0, 0o777])('capture and index remain private and readable with umask %i', async mask => {
  const f = fixture(), previous = process.umask(mask); cleanup.push(() => { process.umask(previous); });
  const store = new DeviceCaptureArtifactStore(f.directory), captured = await store.retain(originalInput);
  expect(statSync(store.pathFor(captured)).mode & 0o777).toBe(0o600); expect(statSync(f.index).mode & 0o777).toBe(0o600);
  expect((await new DeviceCaptureArtifactStore(f.directory).read(captured.id)).ok).toBe(true);
});


test('a failed capture replacement stays protected even if the first quarantine publication also fails', async () => {
  const f = fixture(), mocked = spyOn(crypto, 'randomUUID').mockReturnValue(UUID); cleanup.push(() => mocked.mockRestore());
  const path = join(f.directory, `${opaqueUuid(UUID)}.png`); let replaced = false;
  const store = new DeviceCaptureArtifactStore(f.directory);
  await expect(store.retain({ ...originalInput, assertCurrent() {
    if (replaced || !existsSync(path) || statSync(path).size !== 3) return;
    unlinkSync(path); writeFileSync(path, 'foreign replacement', { mode: 0o600 }); replaced = true;
  } })).rejects.toThrow(); expect(replaced).toBe(true);
  const originalPending = JSON.parse(readFileSync(f.index, 'utf8')).pending; expect(originalPending).toHaveLength(1);
  const refusing = new DeviceCaptureArtifactStore(f.directory, { beforeObservationWrite() { throw new Error('quarantine publisher unavailable'); } });
  await expect(refusing.sweep()).rejects.toThrow('quarantine publisher unavailable');
  expect(JSON.parse(readFileSync(f.index, 'utf8')).pending).toEqual(originalPending);
  expect(readFileSync(path, 'utf8')).toBe('foreign replacement');
  await new DeviceCaptureArtifactStore(f.directory).sweep(); expect(readFileSync(path, 'utf8')).toBe('foreign replacement');
  expect(JSON.parse(readFileSync(f.index, 'utf8')).preservedFiles).toContain(`${opaqueUuid(UUID)}.png`);
});

test.each([2, 3])('a real killed writer preserves unproved empties and reclaims only its durable original crash spool (stage %i)', async stopAt => {
  const f = fixture(), module = new URL('../platform/src/platform/devices/device-capture-artifacts.ts', import.meta.url).href;
  const script = `import { DeviceCaptureArtifactStore } from ${JSON.stringify(module)};
let calls = 0;
const store = new DeviceCaptureArtifactStore(${JSON.stringify(f.directory)}, { beforeObservationWrite() { if (++calls === ${stopAt}) process.kill(process.pid, 'SIGKILL'); } });
await store.retain({ nodeId: 'phone', capabilityId: 'device.screen.capture', kind: 'image', mediaType: 'image/png', bytes: new Uint8Array([1,2,3]) });`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  await child.exited; expect(child.exitCode).not.toBe(0);
  const leaves = readdirSync(f.directory).filter(name => name.endsWith('.png')); expect(leaves).toHaveLength(1);
  const leaf = leaves[0]; if (!leaf) throw new Error('Missing interrupted file');
  const report = await new DeviceCaptureArtifactStore(f.directory).sweep();
  if (stopAt === 2) { expect(statSync(join(f.directory, leaf)).size).toBe(0); expect(report.bytesReclaimed).toBe(0); }
  else { expect(report.removed.some(entry => entry.reason === 'orphan-file')).toBe(true); expect(report.bytesReclaimed).toBe(3); expect(existsSync(join(f.directory, leaf))).toBe(false); }
});

 test('retiring the physical capture parent cannot release a replacement writer lease', async () => {
  const f = fixture(); let swapped = false; const retired = join(f.root, 'retired');
  const store = new DeviceCaptureArtifactStore(f.directory, { beforeObservationWrite() {
    if (swapped) return; swapped = true;
    const lock = readdirSync(f.directory).find(name => name.endsWith('.lock'))!;
    const lease = readFileSync(join(f.directory, lock));
    renameSync(f.directory, retired); mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(join(f.directory, lock), lease, { mode: 0o600 });
  } });
  await expect(store.retain(originalInput)).rejects.toThrow();
  expect(swapped).toBe(true);
  expect(readdirSync(f.directory).some(name => name.endsWith('.lock'))).toBe(true);
  expect(existsSync(join(f.directory, 'capture-index.json'))).toBe(false);
});
