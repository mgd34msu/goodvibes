/** Regression source intentionally UNRUN during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyVerifiedUpdate, realUpdateFileIo, sha256, createNativeDataWriteOwner, NATIVE_READER_REQUIREMENT_FILE, UpdateTransactionError, retainNativeUpdateDirectory } from '../sdk/src/platform/runtime/self-update.js';
import { acquireCrossProcessLock, tryAcquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
const restore: Array<() => void> = [];
afterEach(() => { for (const close of restore.splice(0).reverse()) close(); });
function fixture() {
  const root = makeProjectTempDir('native-owned-update'), directory = join(root, 'selected'); fs.mkdirSync(directory);
  const execPath = join(directory, 'goodvibes'), bytes = Buffer.from('Verified replacement program'); fs.writeFileSync(execPath, 'Original program', { mode: 0o755 });
  const asset = 'goodvibes-macos-x64', manifest = Buffer.from(`${sha256(bytes)}  ${asset}\n`);
  return { root, directory, execPath, bytes, asset, manifest,
    fetchImpl: async (url: string) => new Response(url.endsWith('/SHA256SUMS.txt') ? manifest : bytes),
    targets: [{ label: 'terminal', path: execPath, assetName: asset, executable: true }],
  };
}
function apply(f: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof applyVerifiedUpdate>[0]> = {}) {
  return applyVerifiedUpdate({ fetchImpl: f.fetchImpl, targets: f.targets, downloadBaseUrl: 'https://fixture.invalid/release', io: realUpdateFileIo, platform: 'darwin', native: true, readerExecPath: f.execPath, ...extra });
}

test('an install directory alias substituted during downloads receives no claims, stages or live bytes', async () => {
  const f = fixture(), outside = join(f.root, 'outside'), retained = join(f.root, 'retained'); fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'keep'), 'Foreign original'); let replaced = false;
  await expect(apply(f, { fetchImpl: async url => {
    if (!replaced) { replaced = true; fs.renameSync(f.directory, retained); fs.symlinkSync(outside, f.directory); }
    return f.fetchImpl(url);
  } })).rejects.toThrow('directory');
  expect(fs.readdirSync(outside)).toEqual(['keep']); expect(fs.readFileSync(join(retained, 'goodvibes'), 'utf8')).toBe('Original program');
});

test('a selected missing nested stage parent cannot be replaced with an outside alias during downloads', async () => {
  const f = fixture(), outside = join(f.root, 'outside'); fs.mkdirSync(outside); let replaced = false;
  const addon = join(f.directory, 'lib', 'addon.bin'), addonBytes = Buffer.from('Addon bytes');
  const manifest = `${sha256(f.bytes)}  ${f.asset}\n${sha256(addonBytes)}  addon.bin\n`;
  await expect(apply(f, { targets: [...f.targets, { label: 'addon', path: addon, assetName: 'addon.bin', executable: false }], fetchImpl: async url => {
    if (!replaced) { replaced = true; fs.symlinkSync(outside, join(f.directory, 'lib')); }
    return new Response(url.endsWith('/SHA256SUMS.txt') ? manifest : url.endsWith('/addon.bin') ? addonBytes : f.bytes);
  } })).rejects.toThrow('directory');
  expect(fs.readdirSync(outside)).toEqual([]); expect(fs.readFileSync(f.execPath, 'utf8')).toBe('Original program');
});

test('a stage collision after slot inspection is neither overwritten nor cleaned', async () => {
  const f = fixture(), path = f.execPath + '.update-download', actual = fs.openSync; let collided = false;
  const open = spyOn(fs, 'openSync').mockImplementation((selected, flags, mode) => {
    if (!collided && selected === path) { collided = true; fs.writeFileSync(path, 'Foreign retained stage', { mode: 0o644 }); }
    return actual(selected, flags, mode);
  }); restore.push(() => open.mockRestore());
  let error: unknown; try { await apply(f); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(UpdateTransactionError); expect((error as UpdateTransactionError).receipt.recoveryRequired).toBe(true);
  expect(fs.readFileSync(path, 'utf8')).toBe('Foreign retained stage'); expect(fs.statSync(path).mode & 0o777).toBe(0o644);
  expect(fs.readFileSync(f.execPath, 'utf8')).toBe('Original program');
});

test('a borrowed callback cannot replace an original claim and retain mutation authority', async () => {
  const f = fixture(), claim = f.execPath + '.update-transaction';
  await expect(apply(f, { beforeCommit() { fs.unlinkSync(claim); fs.writeFileSync(claim, 'Foreign claim', { mode: 0o644 }); } })).rejects.toThrow();
  expect(fs.readFileSync(f.execPath, 'utf8')).toBe('Original program'); expect(fs.readFileSync(claim, 'utf8')).toBe('Foreign claim'); expect(fs.statSync(claim).mode & 0o777).toBe(0o644);
});

test('the actual native update admission holds the same strict reader-requirements lease as new data writers', async () => {
  const f = fixture(), owner = createNativeDataWriteOwner({ execPath: f.execPath, version: '3.1.2', assertCurrent() {} }); let checked = false;
  await apply(f, { beforeCommit() { expect(() => owner.declare('knowledge-schema-v12')).toThrow('Another native owner'); checked = true; } });
  expect(checked).toBe(true); expect(fs.readFileSync(f.execPath)).toEqual(f.bytes);
  expect(() => owner.declare('knowledge-schema-v12')).not.toThrow();
  expect(fs.existsSync(join(f.directory, NATIVE_READER_REQUIREMENT_FILE + '.lock'))).toBe(false);
});

test('another requirements publisher blocks the swap and its original lease survives cleanup', async () => {
  const f = fixture(), path = join(f.directory, NATIVE_READER_REQUIREMENT_FILE + '.lock'), release = tryAcquireCrossProcessLock(path);
  if (!release) throw new Error('Fixture lease unavailable');
  try { await expect(apply(f)).rejects.toThrow(); expect(fs.existsSync(path)).toBe(true); expect(fs.readFileSync(f.execPath, 'utf8')).toBe('Original program'); }
  finally { release(); }
});

test('directory retention allows owned child changes while refusing foreign replacement and unknown creation', () => {
  const f = fixture(), future = join(f.directory, 'new', 'nested'), owner = retainNativeUpdateDirectory(f.directory, [future]);
  fs.writeFileSync(join(f.directory, 'normal-child'), 'Expected child changes do not retire parent ownership'); owner.assertCurrent();
  owner.ensure(future); owner.assertCurrent(); expect(fs.statSync(future).isDirectory()).toBe(true);
  const other = join(f.directory, 'unselected'); expect(() => owner.ensure(other)).toThrow('selected'); expect(fs.existsSync(other)).toBe(false);
});

test('short native lease release never removes a substituted symlink to its original inode', () => {
  const f = fixture(), path = join(f.directory, 'lock'), retained = path + '.retained', release = tryAcquireCrossProcessLock(path);
  if (!release) throw new Error('Fixture lease unavailable');
  fs.renameSync(path, retained); fs.symlinkSync(retained, path);
  expect(() => release()).toThrow('Original native lock owner changed');
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(true); expect(fs.existsSync(retained)).toBe(true);
});


test('async native lease release also retains a substituted symlink to its original inode', async () => {
  const f = fixture(), path = join(f.directory, 'async-lock'), retained = path + '.retained';
  const release = await acquireCrossProcessLock(path, { strictOwnership: true });
  fs.renameSync(path, retained); fs.symlinkSync(retained, path);
  expect(() => release()).not.toThrow();
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(true); expect(fs.existsSync(retained)).toBe(true);
});

test('a strict owner never takes over a foreign symlink merely because its target names a dead process', () => {
  const f = fixture(), path = join(f.directory, 'foreign-lock'), outside = join(f.root, 'outside-lock');
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); expect(child.status).toBe(0);
  const original = JSON.stringify({ pid: child.pid, token: '0123456789abcdef', acquiredAt: Date.now() }); fs.writeFileSync(outside, original, { mode: 0o600 }); fs.symlinkSync(outside, path);
  const acquired = tryAcquireCrossProcessLock(path); try { expect(acquired).toBeNull(); } finally { acquired?.(); }
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(true); expect(fs.readFileSync(outside, 'utf8')).toBe(original);
});


test('an inadmissible async lock keeps the event loop available until its bounded timeout', async () => {
  const f = fixture(), path = join(f.directory, 'blocked-lock'), outside = join(f.root, 'outside-blocked');
  fs.writeFileSync(outside, 'Foreign entry'); fs.symlinkSync(outside, path);
  let timerRan = false; const timer = setTimeout(() => { timerRan = true; }, 0);
  try {
    await expect(acquireCrossProcessLock(path, { strictOwnership: true, totalTimeoutMs: 40, initialBackoffMs: 5, maxBackoffMs: 5 })).rejects.toThrow('timed out');
    expect(timerRan).toBe(true); expect(fs.lstatSync(path).isSymbolicLink()).toBe(true); expect(fs.readFileSync(outside, 'utf8')).toBe('Foreign entry');
  } finally { clearTimeout(timer); }
});
