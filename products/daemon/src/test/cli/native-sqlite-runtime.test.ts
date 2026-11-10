import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { compileDaemonSqliteLibrary } from '../../../scripts/build-sqlite-runtime.ts';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as nativeFs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { daemonSqliteRuntime, initializeDaemonNativeSqlite, type DaemonSqliteOwner } from '../../cli/native-sqlite-runtime.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(arch: 'x64' | 'arm64' = 'arm64', { pinBytes = true } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-sqlite-owner-')); roots.push(root);
  const cohort = join(root, 'cohort'); mkdirSync(cohort);
  const execPath = join(cohort, 'goodvibes-daemon'); writeFileSync(execPath, 'inert test executable', { mode: 0o755 });
  const runtime = daemonSqliteRuntime('darwin', arch); if (!runtime) throw new Error('Missing fixture declaration');
  const library = join(cohort, runtime.libraryPath), provenance = join(cohort, runtime.provenancePath);
  mkdirSync(dirname(library), { recursive: true });
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(6, 12);
  const owner: DaemonSqliteOwner = Object.freeze({ schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: '2.0.23', target: runtime.target,
    sqliteVersion: runtime.sqliteVersion, sourceUrl: runtime.sourceUrl, sourceSha3: runtime.sourceSha3,
    sha256: pinBytes ? createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64), size: bytes.length });
  writeFileSync(library, bytes, { mode: 0o644 }); writeFileSync(provenance, JSON.stringify(owner), { mode: 0o644 });
  const options = { platform: 'darwin', arch, bundled: true, version: owner.daemonVersion, execPath, capturedOwner: owner };
  return { root, cohort, library, provenance, bytes, owner, options };
}

test('selects each declared architecture after captured owner, bytes and metadata match', () => {
  for (const arch of ['x64', 'arm64'] as const) {
    const f = fixture(arch); const events: string[] = [];
    initializeDaemonNativeSqlite({ ...f.options, assertCurrent: () => { events.push('current'); }, setCustomSQLite: path => { expect(path).toBe(f.library); events.push('select'); return true; } });
    expect(events).toEqual(['current', 'current', 'select', 'current']);
  }
});

test('unbundled source and Linux do not select custom SQLite', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-sqlite-inapplicable-')); roots.push(root);
  const execPath = join(root, 'absent-daemon'); let calls = 0;
  const setCustomSQLite = () => { calls++; return true; }, hash = spyOn(crypto, 'createHash');
  try {
    initializeDaemonNativeSqlite({ platform: 'darwin', arch: 'arm64', bundled: false, execPath, capturedOwner: null, setCustomSQLite });
    initializeDaemonNativeSqlite({ platform: 'linux', arch: 'arm64', bundled: true, execPath, capturedOwner: null, setCustomSQLite });
    expect(calls).toBe(0); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('retired target or absent compiled owner refuses before selection or digest work', () => {
  const options = { platform: 'darwin', arch: 'arm64', bundled: true, execPath: '/absent/daemon', capturedOwner: null };
  let calls = 0; const setCustomSQLite = () => { calls++; return true; };
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(() => initializeDaemonNativeSqlite({ ...options, arch: 'riscv64', setCustomSQLite })).toThrow('Unsupported');
    expect(() => initializeDaemonNativeSqlite({ ...options, setCustomSQLite })).toThrow('compiled producer');
    expect(calls).toBe(0); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('coherently replaced library and mutable sidecar cannot replace compiled byte authority', () => {
  const f = fixture(); const foreign = Buffer.from(f.bytes); foreign[40] = 1;
  writeFileSync(f.library, foreign); writeFileSync(f.provenance, JSON.stringify({ ...f.owner, sha256: createHash('sha256').update(foreign).digest('hex') }));
  let calls = 0;
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toThrow('compiled producer bytes');
  expect(calls).toBe(0);
});

test('supplier, daemon owner and architecture mismatches refuse before selection', () => {
  const f = fixture('arm64', { pinBytes: false }); let calls = 0; const setCustomSQLite = () => { calls++; return true; };
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(() => initializeDaemonNativeSqlite({ ...f.options, capturedOwner: { ...f.owner, sourceSha3: '0'.repeat(64) }, setCustomSQLite })).toThrow('compiled producer');
    expect(() => initializeDaemonNativeSqlite({ ...f.options, version: '2.0.24', setCustomSQLite })).toThrow('compiled producer');
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
  const wrong = Buffer.from(f.bytes); wrong.writeUInt32LE(0x01000007, 4);
  const wrongOwner: DaemonSqliteOwner = { ...f.owner, sha256: createHash('sha256').update(wrong).digest('hex') };
  writeFileSync(f.library, wrong); writeFileSync(f.provenance, JSON.stringify(wrongOwner));
  expect(() => initializeDaemonNativeSqlite({ ...f.options, capturedOwner: wrongOwner, setCustomSQLite })).toThrow('Mach-O architecture');
  expect(calls).toBe(0);
});

test('missing member, mode, symlink and sidecar owner changes refuse before selection', () => {
  for (const kind of ['missing', 'mode', 'symlink', 'owner'] as const) {
    const hash = spyOn(crypto, 'createHash');
    try {
      const f = fixture('arm64', { pinBytes: kind === 'owner' }); let calls = 0;
      if (kind === 'missing') rmSync(f.library);
      if (kind === 'mode') chmodSync(f.library, 0o600);
      if (kind === 'symlink') { const foreign = join(f.root, 'foreign'); writeFileSync(foreign, f.bytes); rmSync(f.library); symlinkSync(foreign, f.library); }
      if (kind === 'owner') writeFileSync(f.provenance, JSON.stringify({ ...f.owner, daemonVersion: '2.0.24' }));
      expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toThrow();
      expect(calls).toBe(0);
      if (kind !== 'owner') expect(hash).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); }
  }
});

test('oversized library and provenance refuse before reading or selecting', () => {
  for (const member of ['library', 'provenance'] as const) {
    const hash = spyOn(crypto, 'createHash');
    try {
      const f = fixture('arm64', { pinBytes: false }); let calls = 0;
      writeFileSync(f[member], Buffer.alloc(member === 'library' ? f.owner.size + 1 : 16_385));
      expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toThrow('size bound');
      expect(calls).toBe(0); expect(hash).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); }
  }
});

test('selected parent rename and restore during selection is detected', () => {
  const f = fixture();
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => {
    const retired = f.cohort + '.retired'; renameSync(f.cohort, retired); renameSync(retired, f.cohort); return true;
  } })).toThrow('changed before database construction');
});

test('equal-byte foreign inode substitution during selection refuses', () => {
  const f = fixture();
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => {
    const replacement = f.library + '.foreign'; writeFileSync(replacement, f.bytes, { mode: 0o644 }); renameSync(replacement, f.library); return true;
  } })).toThrow('changed before database construction');
});

test('prior-constructor selection refusal and cancellation never admit startup', () => {
  const f = fixture();
  expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => false })).toThrow('Bun refused');
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(() => initializeDaemonNativeSqlite({ ...f.options, signal: controller.signal, setCustomSQLite: () => { calls++; return true; } })).toThrow();
    expect(calls).toBe(0); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('asynchronous current restriction refuses and consumes rejection before selection', async () => {
  const f = fixture(); let calls = 0;
  expect(() => initializeDaemonNativeSqlite({ ...f.options, assertCurrent: () => Promise.reject(new Error('restriction failure')), setCustomSQLite: () => { calls++; return true; } })).toThrow('must be synchronous');
  await Promise.resolve(); expect(calls).toBe(0);
});

test('retained compiled SQLite admission tolerates sibling bookkeeping and still rejects original-file replacement', () => {
  const f = fixture();
  const admitted = initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => true });
  expect(admitted).toBeDefined(); writeFileSync(join(f.cohort, 'native-reader-floor.tmp'), 'Sibling bookkeeping');
  expect(() => admitted?.assertCurrent()).not.toThrow();
  const foreign = f.library + '.later'; writeFileSync(foreign, f.bytes, { mode: 0o644 }); renameSync(foreign, f.library);
  expect(() => admitted?.assertCurrent()).toThrow('Original native SQLite');
});

test('retained SQLite guards check each original physical ancestor once without recursive realpath or digest work', () => {
  const f = fixture();
  const admitted = initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => true });
  if (!admitted) throw new Error('Expected original native SQLite admission');
  let ancestors = 0;
  for (let path = dirname(f.library);;) {
    ancestors += 1;
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  const realpath = spyOn(nativeFs, 'realpathSync'), stat = spyOn(nativeFs, 'lstatSync'), hash = spyOn(crypto, 'createHash');
  try {
    for (let check = 0; check < 8; check++) admitted.assertCurrent();
    // Two selected files retain all physical ancestors plus their own inode.
    expect(stat).toHaveBeenCalledTimes(8 * 2 * (ancestors + 1));
    expect(realpath).not.toHaveBeenCalled(); expect(hash).not.toHaveBeenCalled();
  } finally { realpath.mockRestore(); stat.mockRestore(); hash.mockRestore(); }
});

test('an ancestor symlink cannot admit a native SQLite image even when it reaches the exact original files', () => {
  const f = fixture('arm64', { pinBytes: false }), original = f.cohort + '.original';
  renameSync(f.cohort, original); symlinkSync(original, f.cohort);
  let selected = 0;
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(() => initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { selected++; return true; } })).toThrow('parent is not a regular directory');
    expect(selected).toBe(0); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test.each(['symlink', 'replacement'] as const)('an admitted SQLite owner refuses %s of an ancestor while original leaf files survive', change => {
  const f = fixture();
  const admitted = initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => true });
  if (!admitted) throw new Error('Expected original native SQLite admission');
  const original = f.cohort + '.original'; renameSync(f.cohort, original);
  if (change === 'symlink') symlinkSync(original, f.cohort);
  else {
    mkdirSync(f.cohort); renameSync(join(original, 'lib'), join(f.cohort, 'lib'));
  }
  expect(() => admitted.assertCurrent()).toThrow();
});


test.each(['x64', 'arm64'] as const)('Darwin SQLite compiler keeps Apple --sdk selection for %s', arch => {
  const compile = spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.alloc(0));
  try {
    const source = '/owned native source/sqlite3.c', library = '/owned native output/libsqlite3.dylib';
    compileDaemonSqliteLibrary(arch, source, library);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith('xcrun', [
      '--sdk', 'macosx', 'clang', '-arch', arch === 'x64' ? 'x86_64' : 'arm64',
      '-dynamiclib', '-O2', '-DSQLITE_THREADSAFE=1', '-DSQLITE_ENABLE_COLUMN_METADATA', '-DSQLITE_ENABLE_FTS5',
      '-DSQLITE_ENABLE_RTREE', '-DSQLITE_ENABLE_DBSTAT_VTAB', '-DSQLITE_ENABLE_LOAD_EXTENSION',
      '-Wl,-install_name,@rpath/libsqlite3.dylib', source, '-o', library,
    ], { cwd: dirname(source), stdio: 'inherit', timeout: 120_000 });
  } finally { compile.mockRestore(); }
});


test('thrown rejected lifetime work drains and cannot select SQLite or continue an old admission', async () => {
  const f = fixture(), unhandled: unknown[] = [], normal = new Error('original native restriction');
  const observe = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', observe);
  let calls = 0, failure: unknown, rejected: Promise<never> | undefined;
  const hash = spyOn(crypto, 'createHash'), open = spyOn(nativeFs, 'openSync'), read = spyOn(nativeFs, 'readSync'), stat = spyOn(nativeFs, 'lstatSync');
  try {
    try { initializeDaemonNativeSqlite({ ...f.options, assertCurrent() { rejected = Promise.reject(new Error('borrowed async restriction')); throw rejected; },
      setCustomSQLite: () => { calls++; return true; } }); } catch (error) { failure = error; }
    expect(failure).toBe(rejected); expect(calls).toBe(0);
    expect(hash).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
    let active = true;
    const admitted = initializeDaemonNativeSqlite({ ...f.options, assertCurrent() {
      if (!active) { rejected = Promise.reject(new Error('retired async restriction')); throw rejected; }
    }, setCustomSQLite: () => { calls++; return true; } });
    if (!admitted) throw new Error('Expected actual native admission');
    expect(calls).toBe(1); expect(hash).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalled(); expect(read).toHaveBeenCalled(); expect(stat).toHaveBeenCalled(); active = false;
    try { admitted.assertCurrent(); } catch (error) { failure = error; }
    expect(failure).toBe(rejected); expect(calls).toBe(1);
    expect(() => initializeDaemonNativeSqlite({ ...f.options, assertCurrent() { throw normal; }, setCustomSQLite: () => { calls++; return true; } })).toThrow(normal);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(unhandled).toEqual([]);
  } finally { hash.mockRestore(); open.mockRestore(); read.mockRestore(); stat.mockRestore(); process.off('unhandledRejection', observe); }
});

test('the actual native selection boundary requires true and drains rejected returned or thrown work', async () => {
  const f = fixture(), unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); }; process.on('unhandledRejection', observe);
  try {
    for (const kind of ['returned', 'thrown'] as const) {
      let failure: unknown, rejected: Promise<never> | undefined;
      const select = (): boolean => {
        rejected = Promise.reject(new Error('borrowed native selection rejected'));
        if (kind === 'thrown') throw rejected;
        return rejected as unknown as boolean;
      };
      try { initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: select }); } catch (error) { failure = error; }
      if (kind === 'thrown') expect(failure).toBe(rejected);
      else expect(failure).toBeInstanceOf(Error);
    }
    let calls = 0;
    expect(initializeDaemonNativeSqlite({ ...f.options, setCustomSQLite: () => { calls++; return true; } })).toBeDefined();
    expect(calls).toBe(1);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', observe); }
});
