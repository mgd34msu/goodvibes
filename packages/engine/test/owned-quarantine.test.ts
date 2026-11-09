import * as fs from 'node:fs';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.ts';
import { realLifecycleMarkerIo, recordDaemonStartAttempt } from '../platform/src/platform/daemon/lifecycle-marker.ts';
import { WorkPlanStore } from '../platform/src/platform/workflow/work-plan-store.ts';
/** UNRUN: original filesystem readers, exclusive recovery and persisted bounds. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureQuarantineSource, readCapturedQuarantineSourceAsync, quarantineCorruptFile, readJsonFileOrQuarantine, reapOwnedQuarantines, reapOwnedQuarantineDirectories } from '../platform/src/platform/utils/atomic-json-store.ts';
import { JsonFileStore } from '../platform/src/platform/state/json-file-store.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'owned-quarantine-')); roots.push(root); return { root, path: join(root, 'store.json') }; }
const options = { label: 'test/quarantine', reason: 'invalid saved container', recovery: 'The test rebuilds from preserved evidence.' };
const payloads = (root: string) => readdirSync(root).filter(name => name.startsWith('store.json.corrupt-') && !name.endsWith('.why'));
test('a validator cannot quarantine the different file it installs before throwing', () => {
  const f = fixture(); writeFileSync(f.path, '{}');
  expect(() => readJsonFileOrQuarantine(f.path, { ...options, validate() { renameSync(f.path, `${f.path}.retained`); writeFileSync(f.path, '{"replacement":true}'); throw Error('invalid shape'); } })).toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe('{"replacement":true}'); expect(readFileSync(`${f.path}.retained`, 'utf8')).toBe('{}'); expect(payloads(f.root)).toEqual([]);
});
test('a successful validator cannot publish a result from a retired original source', () => {
  const f = fixture(); writeFileSync(f.path, '{"version":1}');
  expect(() => readJsonFileOrQuarantine(f.path, { ...options, validate(value) { renameSync(f.path, `${f.path}.retained`); writeFileSync(f.path, '{"version":2}'); return value; } })).toThrow(); expect(payloads(f.root)).toEqual([]);
});
test('JSON parser and validator excerpts are absent from native recovery logs and receipts', () => {
  const f = fixture(), secret = 'SYNTHETIC_PRIVATE_BODY_NEVER_LOG'; writeFileSync(f.path, `{"password":"${secret}"`);
  const calls: unknown[] = [], log = spyOn(logger, 'error').mockImplementation((...args) => { calls.push(args); });
  try { expect(readJsonFileOrQuarantine(f.path, { ...options, validate: value => value })).toBeNull(); }
  finally { log.mockRestore(); }
  const all = JSON.stringify(calls) + readdirSync(f.root).filter(name => name.endsWith('.why')).map(name => readFileSync(join(f.root, name), 'utf8')).join(''); expect(all).not.toContain(secret); expect(payloads(f.root)).toHaveLength(1);
});
test('a late archive collision preserves both the original source and foreign destination', () => {
  const f = fixture(); writeFileSync(f.path, 'damaged'); let collision: string | undefined;
  expect(() => quarantineCorruptFile(f.path, { ...options, onEffect(published) { if (published || collision) return; const receipt = readdirSync(f.root).find(name => name.endsWith('.why')); if (!receipt) return; collision = join(f.root, receipt.slice(0, -4)); writeFileSync(collision, 'foreign archive'); } })).toThrow();
  if (!collision) throw Error('Missing actual late collision'); expect(readFileSync(collision, 'utf8')).toBe('foreign archive'); expect(readFileSync(f.path, 'utf8')).toBe('damaged');
});
test('a replaced original receipt is neither written nor removed', () => {
  const f = fixture(); writeFileSync(f.path, 'damaged'); let foreign: string | undefined;
  expect(() => quarantineCorruptFile(f.path, { ...options, onEffect(published) { if (published || foreign) return; const name = readdirSync(f.root).find(name => name.endsWith('.why')); if (!name) return; foreign = join(f.root, name); renameSync(foreign, `${foreign}.retained`); writeFileSync(foreign, 'foreign receipt'); } })).toThrow();
  if (!foreign) throw Error('Missing receipt replacement'); expect(readFileSync(foreign, 'utf8')).toBe('foreign receipt'); expect(readFileSync(f.path, 'utf8')).toBe('damaged');
});
test('same-length archive edits inside a publication callback produce an uncertain failure, never success or rollback', () => {
  const f = fixture(); writeFileSync(f.path, 'original'); let archive: string | undefined;
  expect(() => quarantineCorruptFile(f.path, { ...options, onEffect(published) { if (!published || archive) return; archive = join(f.root, payloads(f.root)[0]!); writeFileSync(archive, 'modified'); } })).toThrow();
  if (!archive) throw Error('Missing published archive'); expect(readFileSync(archive, 'utf8')).toBe('modified'); expect(existsSync(f.path)).toBe(false);
});
test('the original source is retained across the actual asynchronous JsonFileStore read', async () => {
  const f = fixture(); writeFileSync(f.path, '{"original":true}'); const source = captureQuarantineSource(f.path); if (!source) throw Error('Missing actual source');
  renameSync(f.path, `${f.path}.retained`); writeFileSync(f.path, '{"foreign":true}');
  try { await expect(new JsonFileStore(f.path).load(source)).rejects.toThrow(); }
  finally { source.close(); }
  expect(readFileSync(f.path, 'utf8')).toBe('{"foreign":true}'); expect(payloads(f.root)).toEqual([]);
});
test('native ownership records bound repeated corruption in a separate restarted reader process', async () => {
  const f = fixture();
  for (let index = 0; index < 8; index++) { writeFileSync(f.path, `corrupt source ${index}`); quarantineCorruptFile(f.path, { ...options, maxFiles: 100 }); }
  const modulePath = new URL('../platform/src/platform/utils/atomic-json-store.ts', import.meta.url).href;
  const code = `import { reapOwnedQuarantines } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(reapOwnedQuarantines(process.argv[1], { maxFiles: 3 })));`;
  const child = Bun.spawn([process.execPath, '--eval', code, f.path], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0); expect(stderr).not.toContain('Original store or recovery ownership'); const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { reaped: number }; expect(result.reaped).toBe(5); expect(payloads(f.root)).toHaveLength(3);
});
test('unknown historical files, symlinks and orphan receipts are preserved while native pairs are reaped', () => {
  const f = fixture(), historical = join(f.root, 'store.json.corrupt-old'), orphan = `${historical}-orphan.why`, alias = `${historical}-alias`, outside = join(f.root, 'outside');
  writeFileSync(historical, 'old bytes'); writeFileSync(orphan, 'historical receipt'); writeFileSync(outside, 'outside bytes'); symlinkSync(outside, alias);
  for (let index = 0; index < 4; index++) { writeFileSync(f.path, 'bad'); quarantineCorruptFile(f.path, { ...options, maxFiles: 100 }); }
  const result = reapOwnedQuarantines(f.path, { maxFiles: 1 }); expect(result.reaped).toBe(3); expect(result.preservedUnknown).toBeGreaterThanOrEqual(3);
  expect(readFileSync(historical, 'utf8')).toBe('old bytes'); expect(readFileSync(orphan, 'utf8')).toBe('historical receipt'); expect(lstatSync(alias).isSymbolicLink()).toBe(true); expect(readFileSync(outside, 'utf8')).toBe('outside bytes');
});
test('same-byte payload replacement does not match its old native ownership receipt', () => {
  const f = fixture(); writeFileSync(f.path, 'bad'); const first = quarantineCorruptFile(f.path, options); const bytes = readFileSync(first.quarantinePath); renameSync(first.quarantinePath, `${first.quarantinePath}.retained`); writeFileSync(first.quarantinePath, bytes);
  const result = reapOwnedQuarantines(f.path, { maxFiles: 0 }); expect(result.reaped).toBe(0); expect(result.preservedUnknown).toBeGreaterThan(0); expect(readFileSync(first.quarantinePath)).toEqual(bytes); expect(existsSync(`${first.quarantinePath}.why`)).toBe(true);
});
test('native archives and receipts are private under a permissive process umask', () => {
  const f = fixture(), previous = process.umask(0); try { writeFileSync(f.path, 'bad', { mode: 0o644 }); const result = quarantineCorruptFile(f.path, options); expect(lstatSync(result.quarantinePath).mode & 0o777).toBe(0o600); expect(lstatSync(`${result.quarantinePath}.why`).mode & 0o777).toBe(0o600); } finally { process.umask(previous); }
});
test('async validation is rejected without moving valid original bytes', () => {
  const f = fixture(); writeFileSync(f.path, '{}'); expect(() => readJsonFileOrQuarantine(f.path, { ...options, validate: async () => { throw Error('synthetic async failure'); } })).toThrow('synchronously'); expect(readFileSync(f.path, 'utf8')).toBe('{}'); expect(payloads(f.root)).toEqual([]);
});

test('checkpoint init refuses a new manifest substituted while the original asynchronous load rejects', async () => {
  const f = fixture(), checkpointDir = join(f.root, '.goodvibes', 'checkpoints'); mkdirSync(checkpointDir, { recursive: true }); const path = join(checkpointDir, 'index.json'); writeFileSync(path, '{"checkpoints":[');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), nativeLoad = JsonFileStore.prototype.load;
  const load = spyOn(JsonFileStore.prototype, 'load').mockImplementation(async function(this: JsonFileStore<unknown>, source) {
    try { return await nativeLoad.call(this, source); } catch { entered.resolve(); await release.promise; throw Error('Original index parse rejected'); }
  });
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: f.root, preferGitRoot: false }); const pending = manager.init(); const observed = pending.catch(error => error);
  try {
    await entered.promise; renameSync(path, `${path}.retained`); const fresh = '{"checkpoints":[]}'; writeFileSync(path, fresh); release.resolve();
    expect(await observed).toBeInstanceOf(Error); expect(readFileSync(path, 'utf8')).toBe(fresh); expect(readdirSync(checkpointDir).filter(name => name.startsWith('index.json.corrupt-'))).toEqual([]);
  } finally { release.resolve(); await observed; load.mockRestore(); manager.dispose(); }
});
test('native lifecycle parsing cannot quarantine or overwrite a different marker returned after original capture', () => {
  const f = fixture(); writeFileSync(f.path, 'old invalid marker'); let writes = 0;
  const io = { ...realLifecycleMarkerIo, captureSource(path: string) { const source = captureQuarantineSource(path); renameSync(path, `${path}.retained`); writeFileSync(path, '{"foreign":true}'); return source; }, write() { writes++; } };
  expect(() => recordDaemonStartAttempt(f.path, { io, version: '3.1.2' })).toThrow(); expect(writes).toBe(0); expect(readFileSync(f.path, 'utf8')).toBe('{"foreign":true}'); expect(payloads(f.root)).toEqual([]);
});
test('readonly malformed local plan reports recovery required without quarantine, reset or byte changes', () => {
  const f = fixture(), options = { homeDirectory: f.root, surfaceRoot: 'test', projectId: 'saved-project', projectRoot: '/actual/workspace' }, store = new WorkPlanStore(options); store.addItem('Saved work'); writeFileSync(store.filePath, '{"items":[');
  const raw = readFileSync(store.filePath), members = readdirSync(join(f.root, '.goodvibes', 'test', 'work-plans', '.native-plans')).sort();
  const projected = store.getActivePlan({ readOnly: true }); expect(projected.housekeeping?.recoveryRequired).toBe(true); expect(projected.housekeeping?.resetFromUnreadableFile).not.toBe(true); expect(readFileSync(store.filePath)).toEqual(raw); expect(readdirSync(join(f.root, '.goodvibes', 'test', 'work-plans', '.native-plans')).sort()).toEqual(members);
});

test('requesting source close during an actual async FD read holds the descriptor until callback drainage', async () => {
  const f = fixture(); writeFileSync(f.path, '{"saved":true}'); const source = captureQuarantineSource(f.path); if (!source) throw Error('Missing native read source');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), nativeRead = fs.readFile; let descriptor: number | undefined;
  const replacement = ((path: fs.PathOrFileDescriptor, callback: (error: NodeJS.ErrnoException | null, data: Buffer) => void) => {
    if (typeof path === 'number') descriptor = path;
    nativeRead(path, (error, data) => { entered.resolve(); void release.promise.then(() => callback(error, data)); });
  }) as typeof fs.readFile;
  const read = spyOn(fs, 'readFile').mockImplementation(replacement); const pending = readCapturedQuarantineSourceAsync(f.path, source); const observed = pending.catch(error => error);
  try {
    await entered.promise; source.close(); if (descriptor === undefined) throw Error('Missing actual retained descriptor'); expect(() => fs.fstatSync(descriptor!)).not.toThrow(); release.resolve(); expect(await observed).toBeInstanceOf(Error); expect(() => fs.fstatSync(descriptor!)).toThrow();
  } finally { release.resolve(); await observed; source.close(); read.mockRestore(); }
});
test('an actual async read failure propagates as IO failure rather than a corrupt JSON parse claim', async () => {
  const f = fixture(); writeFileSync(f.path, '{"saved":true}'); const failure = Object.assign(new Error('synthetic IO failure'), { code: 'EIO' });
  const replacement = ((_path: fs.PathOrFileDescriptor, callback: (error: NodeJS.ErrnoException | null, data: Buffer) => void) => { queueMicrotask(() => callback(failure, Buffer.alloc(0))); }) as typeof fs.readFile;
  const read = spyOn(fs, 'readFile').mockImplementation(replacement);
  try { await expect(new JsonFileStore(f.path).load()).rejects.toBe(failure); }
  finally { read.mockRestore(); }
  expect(readFileSync(f.path, 'utf8')).toBe('{"saved":true}'); expect(payloads(f.root)).toEqual([]);
});


test('global native retention scans each namespace once and never reads corrupt payload bodies', () => {
  const f = fixture(), other = join(f.root, 'other'); mkdirSync(other);
  const archives: string[] = [];
  for (let index = 0; index < 6; index++) {
    const path = join(index % 2 === 0 ? f.root : other, `source-${index}.json`); writeFileSync(path, `bad ${index}`);
    archives.push(quarantineCorruptFile(path, { ...options, now: index + 1, maxFiles: 100 }).quarantinePath);
  }
  const originalFiles = new Set(archives.map(path => fs.statSync(path, { bigint: true }).ino.toString()));
  const nativeRead = fs.readFileSync;
  const read = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === 'number' && originalFiles.has(fs.fstatSync(args[0], { bigint: true }).ino.toString())) throw Error('Unexpected corrupt payload read');
    return nativeRead(...args);
  }) as typeof fs.readFileSync);
  const list = spyOn(fs, 'readdirSync');
  let result: ReturnType<typeof reapOwnedQuarantineDirectories>;
  try {
    result = reapOwnedQuarantineDirectories([f.root, other], name => /^source-[0-9]+\.json$/.test(name), { now: 10, maxFiles: 2 });
    expect(list).toHaveBeenCalledTimes(2);
  } finally { list.mockRestore(); read.mockRestore(); }
  expect(result.reaped).toBe(4); expect(result.preservedUnknown).toBe(0);
  expect(archives.filter(path => existsSync(path))).toEqual(archives.slice(-2));
});

test('global reaping preserves a same-byte foreign payload substituted while reading its native receipt', () => {
  const f = fixture(); writeFileSync(f.path, 'damaged'); const archive = quarantineCorruptFile(f.path, options).quarantinePath;
  const bytes = readFileSync(archive), nativeParse = JSON.parse; let replaced = false;
  const parse = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const value: unknown = nativeParse(text, reviver);
    if (!replaced && typeof text === 'string' && text.includes('goodvibes-owned-quarantine')) {
      replaced = true; renameSync(archive, `${archive}.retained`); writeFileSync(archive, bytes);
    }
    return value;
  });
  let result: ReturnType<typeof reapOwnedQuarantineDirectories>;
  try { result = reapOwnedQuarantineDirectories([f.root], name => name === 'store.json', { maxFiles: 0 }); }
  finally { parse.mockRestore(); }
  expect(replaced).toBe(true); expect(result.reaped).toBe(0); expect(result.preservedUnknown).toBeGreaterThan(0);
  expect(readFileSync(archive)).toEqual(bytes); expect(readFileSync(`${archive}.retained`)).toEqual(bytes); expect(existsSync(`${archive}.why`)).toBe(true);
});

test('per-file native retention still accepts a source filename containing the archive delimiter', () => {
  const f = fixture(), path = join(f.root, 'source.corrupt-name.json'); writeFileSync(path, 'bad');
  const archived = quarantineCorruptFile(path, options).quarantinePath;
  expect(reapOwnedQuarantines(path, { maxFiles: 0 }).reaped).toBe(1); expect(existsSync(archived)).toBe(false);
});
