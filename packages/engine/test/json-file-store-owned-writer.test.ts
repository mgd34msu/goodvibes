/** UNRUN: real asynchronous FD writes and original publication ownership. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { JsonFileStore } from '../sdk/src/platform/state/json-file-store.ts';
import { writeJsonFileAtomic } from '../sdk/src/platform/utils/atomic-json-store.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'json-owned-write-')); roots.push(root); const path = join(root, 'state.json'); writeFileSync(path, '{"old":true}'); return { root, path }; }
test('a colliding temporary is neither truncated nor deleted when exclusive native open fails', async () => {
  const f = fixture(), nativeOpen = fs.openSync; let foreign: string | undefined;
  const open = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { if (typeof path === 'string' && path.startsWith(`${f.path}.tmp-`)) { foreign = path; writeFileSync(path, 'foreign'); } return nativeOpen(path, flags, mode); });
  try { await expect(new JsonFileStore(f.path).save({ next: true })).rejects.toThrow(); }
  finally { open.mockRestore(); }
  if (!foreign) throw Error('Missing actual temporary collision'); expect(readFileSync(foreign, 'utf8')).toBe('foreign'); expect(readFileSync(f.path, 'utf8')).toBe('{"old":true}');
});
test('a temporary pathname replaced while the actual async write completes is preserved as foreign', async () => {
  const f = fixture(), nativeWrite = fs.writeFile; let foreign: string | undefined;
  const replacement = ((path: fs.PathOrFileDescriptor, data: string, encoding: BufferEncoding, callback: (error: NodeJS.ErrnoException | null) => void) => {
    nativeWrite(path, data, encoding, error => { const stage = readdirSync(f.root).find(name => name.startsWith(`${basename(f.path)}.tmp-`)); if (!stage) throw Error('Missing actual native stage'); foreign = join(f.root, stage); renameSync(foreign, `${foreign}.retained`); writeFileSync(foreign, 'foreign'); callback(error); });
  }) as typeof fs.writeFile;
  const write = spyOn(fs, 'writeFile').mockImplementation(replacement);
  try { await expect(new JsonFileStore(f.path).save({ next: true })).rejects.toThrow(); }
  finally { write.mockRestore(); }
  if (!foreign) throw Error('Missing actual replaced temporary'); expect(readFileSync(foreign, 'utf8')).toBe('foreign'); expect(readFileSync(f.path, 'utf8')).toBe('{"old":true}');
});
test('retiring the original parent during async write withholds foreign publication/cleanup and closes the original FD', async () => {
  const f = fixture(), nativeWrite = fs.writeFile, retained = `${f.root}.retained`; roots.push(retained); let descriptor: number | undefined, foreign: string | undefined;
  const replacement = ((path: fs.PathOrFileDescriptor, data: string, encoding: BufferEncoding, callback: (error: NodeJS.ErrnoException | null) => void) => {
    if (typeof path === 'number') descriptor = path;
    nativeWrite(path, data, encoding, error => { const stage = readdirSync(f.root).find(name => name.startsWith(`${basename(f.path)}.tmp-`)); if (!stage) throw Error('Missing actual native stage'); renameSync(f.root, retained); mkdirSync(f.root); foreign = join(f.root, stage); writeFileSync(foreign, 'foreign'); writeFileSync(f.path, 'foreign destination'); callback(error); });
  }) as typeof fs.writeFile;
  const write = spyOn(fs, 'writeFile').mockImplementation(replacement);
  try { await expect(new JsonFileStore(f.path).save({ next: true })).rejects.toThrow(); }
  finally { write.mockRestore(); }
  if (descriptor === undefined || !foreign) throw Error('Missing actual parent retirement'); expect(() => fstatSync(descriptor!)).toThrow(); expect(readFileSync(foreign, 'utf8')).toBe('foreign'); expect(readFileSync(f.path, 'utf8')).toBe('foreign destination'); expect(readFileSync(join(retained, 'state.json'), 'utf8')).toBe('{"old":true}');
});
test('directory fsync failures are indeterminate and never restore/delete the visible new destination', async () => {
  const f = fixture(), nativeSync = fs.fsync;
  const sync = spyOn(fs, 'fsync').mockImplementation(((fd: number, callback: fs.NoParamCallback) => { if (fstatSync(fd).isDirectory()) { queueMicrotask(() => callback(Object.assign(Error('synthetic directory durability failure'), { code: 'EIO' }))); return; } nativeSync(fd, callback); }) as typeof fs.fsync);
  let failure: unknown; try { await new JsonFileStore(f.path).save({ next: true }).catch(error => { failure = error; }); }
  finally { sync.mockRestore(); }
  expect(failure).toMatchObject({ phase: 'published-indeterminate' }); expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ next: true });
});
test('a borrowed serializer cannot retarget a newly substituted original parent', async () => {
  const f = fixture(), retained = `${f.root}.retained`; roots.push(retained);
  await expect(new JsonFileStore(f.path).save({ toJSON() { renameSync(f.root, retained); mkdirSync(f.root); writeFileSync(f.path, 'foreign'); return { next: true }; } })).rejects.toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe('foreign'); expect(readFileSync(join(retained, 'state.json'), 'utf8')).toBe('{"old":true}');
});
test('undefined serialization rejects before persisting invalid JSON text', async () => {
  const f = fixture(); await expect(new JsonFileStore<undefined>(f.path).save(undefined)).rejects.toThrow(); expect(readFileSync(f.path, 'utf8')).toBe('{"old":true}'); expect(readdirSync(f.root)).toEqual(['state.json']);
});
test('native JSON files retain owner-only permissions under a permissive process umask', async () => {
  const f = fixture(), previous = process.umask(0); try { await new JsonFileStore(f.path).save({ next: true }); expect(lstatSync(f.path).mode & 0o777).toBe(0o600); expect(existsSync(f.path)).toBe(true); } finally { process.umask(previous); }
});
for (const asyncWriter of [false, true]) test(`${asyncWriter ? 'async' : 'sync'} publication never retries an uncertain close on a reused foreign FD`, async () => {
  const f = fixture(), nativeOpen = fs.openSync, nativeClose = fs.closeSync, foreign = join(f.root, 'foreign'); writeFileSync(foreign, 'foreign bytes'); let original: number | undefined, reused: number | undefined;
  const open = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = nativeOpen(path, flags, mode); if (typeof path === 'string' && path.startsWith(`${f.path}.tmp-`)) original = fd; return fd; });
  const close = spyOn(fs, 'closeSync').mockImplementation(fd => { if (fd === original && reused === undefined) { nativeClose(fd); reused = nativeOpen(foreign, 'r'); throw Object.assign(Error('synthetic lost close acknowledgement'), { code: 'EIO' }); } nativeClose(fd); });
  let failure: unknown;
  try { if (asyncWriter) await new JsonFileStore(f.path).save({ next: true }).catch(error => { failure = error; }); else { try { writeJsonFileAtomic(f.path, { next: true }, { durable: true }); } catch (error) { failure = error; } } }
  finally { close.mockRestore(); open.mockRestore(); }
  try { expect(failure).toBeInstanceOf(Error); if (reused === undefined) throw Error('Missing actual reused descriptor'); expect(() => fstatSync(reused!)).not.toThrow(); expect(readFileSync(foreign, 'utf8')).toBe('foreign bytes'); }
  finally { if (reused !== undefined) nativeClose(reused); }
});

test('existing saves fsync only their actual parent; new parent entries flush their own ancestry without unrelated roots', async () => {
  const f = fixture(), nativeOpen = fs.openSync, nativeSync = fs.fsync, opened = new Map<number, string>(), synced: string[] = [];
  const open = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = nativeOpen(path, flags, mode); if (typeof path === 'string') opened.set(fd, path); return fd; });
  const sync = spyOn(fs, 'fsync').mockImplementation(((fd: number, callback: fs.NoParamCallback) => { if (fstatSync(fd).isDirectory()) { const path = opened.get(fd); if (!path) throw Error('Missing original native directory'); synced.push(path); } nativeSync(fd, callback); }) as typeof fs.fsync);
  try {
    await new JsonFileStore(f.path).save({ next: true }); expect(synced).toEqual([f.root]); synced.length = 0;
    const nested = join(f.root, 'new', 'nested'); await new JsonFileStore(join(nested, 'state.json')).save({ next: true });
    expect(synced).toEqual([nested, join(f.root, 'new'), f.root]);
  } finally { sync.mockRestore(); open.mockRestore(); }
});
