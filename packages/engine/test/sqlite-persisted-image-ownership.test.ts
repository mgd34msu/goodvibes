import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSQLitePersistedImage, SQLitePublicationError, SQLiteStorePersistence,
  type SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(present = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'sqlite-image-owner-')); roots.push(root);
  const file = join(root, 'knowledge.sqlite');
  if (present) fs.writeFileSync(file, 'original image');
  return { root, file, persistence: new SQLiteStorePersistence(file) };
}

test('separate native image reads carry separate evidence and detached bytes', () => {
  const f = fixture();
  const first = readSQLitePersistedImage(f.persistence), second = readSQLitePersistedImage(f.persistence);
  expect(first.data).toEqual(second.data); expect(first.identity).toBe(second.identity);
  expect(first.evidence).not.toBe(second.evidence);
  if (!first.data) throw new Error('Fixture image missing');
  first.data.fill(0);
  expect(readSQLitePersistedImage(f.persistence).data?.toString()).toBe('original image');
});

test('lookalike stores cannot mint native persisted-image evidence', () => {
  const f = fixture();
  for (const borrowed of [{ ...f.persistence }, Object.create(SQLiteStorePersistence.prototype),
    { path: f.file, read: () => fs.readFileSync(f.file), observationIdentity: () => f.persistence.observationIdentity() }]) {
    expect(() => readSQLitePersistedImage(borrowed as SQLiteStorePersistence)).toThrow('owner is unavailable');
  }
});

test('public method and path replacement cannot retarget a registered native reader', () => {
  const f = fixture(); const other = join(f.root, 'other.sqlite'); fs.writeFileSync(other, 'foreign image');
  Object.defineProperty(f.persistence, 'path', { value: other });
  Object.defineProperty(f.persistence, 'read', { value: () => Buffer.from('forged image') });
  Object.defineProperty(f.persistence, 'observationIdentity', { value: () => 'forged identity' });
  const actual = readSQLitePersistedImage(f.persistence);
  expect(actual.data?.toString()).toBe('original image'); expect(actual.identity).not.toBe('forged identity');
});

test('save baselines reject mutated borrowed bytes and remain private after valid capture', () => {
  const f = fixture(), input = f.persistence.read(); if (!input) throw new Error('Fixture image missing');
  input.fill(0);
  expect(() => f.persistence.acceptBaseline(input)).toThrow('baseline differs');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('original image');
  const actual = f.persistence.read(); f.persistence.acceptBaseline(actual);
  actual?.fill(0);
  expect(JSON.stringify(f.persistence)).not.toContain('original image');
  f.persistence.writeIfCurrent(Buffer.from('next image'));
  expect(fs.readFileSync(f.file, 'utf8')).toBe('next image');
});

test('ordinary save accepts an identical-byte replacement by comparing its exact original baseline', () => {
  const f = fixture(); f.persistence.acceptBaseline(f.persistence.read());
  const original = readSQLitePersistedImage(f.persistence);
  const replacement = f.file + '.replacement'; fs.copyFileSync(f.file, replacement); fs.renameSync(replacement, f.file);
  expect(readSQLitePersistedImage(f.persistence).identity).not.toBe(original.identity);
  f.persistence.writeIfCurrent(Buffer.from('next image'));
  expect(fs.readFileSync(f.file, 'utf8')).toBe('next image');
});

for (const changed of [false, true]) test(`actual independent publication owners preserve exact save-baseline comparison (changed=${changed})`, async () => {
  const f = fixture(), other = new SQLiteStorePersistence(f.file);
  f.persistence.acceptBaseline(f.persistence.read()); other.acceptBaseline(other.read());
  const firstLease = await f.persistence.lock();
  try { f.persistence.writeIfCurrent(Buffer.from(changed ? 'first change' : 'original image')); }
  finally { firstLease(); }
  const secondLease = await other.lock();
  try {
    if (changed) {
      expect(() => other.writeIfCurrent(Buffer.from('second change'))).toThrow('persisted state changed');
      expect(fs.readFileSync(f.file, 'utf8')).toBe('first change');
    } else {
      other.writeIfCurrent(Buffer.from('second change'));
      expect(fs.readFileSync(f.file, 'utf8')).toBe('second change');
    }
  } finally { secondLease(); }
});

test('actual byte changes refuse stale saves despite replaced public observation methods', () => {
  const f = fixture(); f.persistence.acceptBaseline(f.persistence.read());
  const before = fs.statSync(f.file); fs.writeFileSync(f.file, 'modified image'); fs.utimesSync(f.file, before.atime, before.mtime);
  Object.defineProperty(f.persistence, 'observationIdentity', { value: () => 'unchanged' });
  expect(() => f.persistence.writeIfCurrent(Buffer.from('must not publish'))).toThrow('persisted state changed');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('modified image');
});

test('a once-observed file cannot disappear into an empty image or save baseline', () => {
  const f = fixture(); f.persistence.acceptBaseline(f.persistence.read()); fs.rmSync(f.file);
  expect(() => readSQLitePersistedImage(f.persistence)).toThrow();
  expect(() => f.persistence.acceptBaseline(null)).toThrow();
  expect(() => f.persistence.writeIfCurrent(Buffer.from('must not resurrect'))).toThrow();
  expect(fs.existsSync(f.file)).toBe(false);
});

test('a fresh absent image can publish its first actual file', () => {
  const f = fixture(false); expect(readSQLitePersistedImage(f.persistence).data).toBeNull();
  f.persistence.acceptBaseline(null); f.persistence.writeIfCurrent(Buffer.from('first image'));
  expect(readSQLitePersistedImage(f.persistence).data?.toString()).toBe('first image');
});

test('unsafe leaf and parent replacements cannot be treated as native image sources', () => {
  const f = fixture(), other = join(f.root, 'other.sqlite'); fs.writeFileSync(other, 'foreign image');
  fs.renameSync(f.file, f.file + '.original'); fs.symlinkSync(other, f.file);
  expect(() => readSQLitePersistedImage(f.persistence)).toThrow();
  fs.unlinkSync(f.file); fs.renameSync(f.file + '.original', f.file);
  readSQLitePersistedImage(f.persistence);
  const retained = f.root + '.retained'; roots.push(retained); fs.renameSync(f.root, retained);
  fs.mkdirSync(f.root); fs.writeFileSync(f.file, 'original image');
  expect(() => readSQLitePersistedImage(f.persistence)).toThrow('original coordinated directory changed');
  expect(() => f.persistence.writeIfCurrent(Buffer.from('must not follow replacement parent'))).toThrow('original coordinated directory changed');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('original image');
});

test('publication snapshots its actual I/O methods before caller replacement', () => {
  const f = fixture(); const io: SQLitePublicationIO = { ...fs };
  const owner = new SQLiteStorePersistence(f.file, io); owner.acceptBaseline(owner.read());
  io.renameSync = () => { throw new Error('replaced publication method'); };
  io.writeFileSync = () => { throw new Error('replaced publication method'); };
  owner.writeIfCurrent(Buffer.from('next image'));
  expect(fs.readFileSync(f.file, 'utf8')).toBe('next image');
});

test('incorrect published bytes are indeterminate and never become an accepted baseline', () => {
  const f = fixture(); const io: SQLitePublicationIO = { ...fs,
    writeFileSync(file) { fs.writeFileSync(file, 'incorrect publication'); },
  };
  const owner = new SQLiteStorePersistence(f.file, io); owner.acceptBaseline(owner.read());
  let error: unknown;
  try { owner.writeIfCurrent(Buffer.from('next image')); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(SQLitePublicationError);
  if (!(error instanceof SQLitePublicationError)) throw new Error('Expected uncertain actual publication');
  expect(error.phase).toBe('indeterminate'); expect(fs.readFileSync(f.file, 'utf8')).toBe('incorrect publication');
  expect(() => owner.writeIfCurrent(Buffer.from('must not retry'))).toThrow('persisted state changed');
  expect(fs.readdirSync(dirname(f.file)).some(name => name.includes('.pending-'))).toBe(false);
});


// Regression source intentionally UNRUN during the coding-first pass.
test('baseline capture, unchanged replacement comparison and native saves do not compute a digest', () => {
  const f = fixture(), hash = spyOn(crypto, 'createHash');
  try {
    f.persistence.acceptBaseline(f.persistence.read());
    const replacement = f.file + '.replacement'; fs.copyFileSync(f.file, replacement); fs.renameSync(replacement, f.file);
    f.persistence.writeIfCurrent(Buffer.from('next exact image'));
    f.persistence.writeIfCurrent(Buffer.from('another exact image'));
    expect(fs.readFileSync(f.file, 'utf8')).toBe('another exact image'); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('a failed exclusive publication open never removes a colliding foreign temporary file', () => {
  const f = fixture(); let collided: string | undefined;
  const io: SQLitePublicationIO = { ...fs, openSync(path, flags, mode) {
    if (typeof path === 'string' && path.includes('.pending-')) { collided = path; fs.writeFileSync(path, 'Foreign retained collision', { mode: 0o644 }); }
    return fs.openSync(path, flags, mode);
  } };
  const owner = new SQLiteStorePersistence(f.file, io); owner.acceptBaseline(owner.read());
  expect(() => owner.writeIfCurrent(Buffer.from('must not publish'))).toThrow(SQLitePublicationError);
  if (!collided) throw new Error('Fixture failed to intercept actual exclusive stage');
  expect(fs.readFileSync(collided, 'utf8')).toBe('Foreign retained collision'); expect(fs.statSync(collided).mode & 0o777).toBe(0o644);
  expect(fs.readFileSync(f.file, 'utf8')).toBe('original image');
});

test('an owned temporary file replaced during a borrowed write is neither published nor cleaned as ours', () => {
  const f = fixture(); let stage: string | undefined;
  const io: SQLitePublicationIO = { ...fs,
    openSync(path, flags, mode) { if (typeof path === 'string' && path.includes('.pending-')) stage = path; return fs.openSync(path, flags, mode); },
    writeFileSync(fd, data) {
      fs.writeFileSync(fd, data);
      if (!stage) throw new Error('Actual original stage unavailable');
      fs.renameSync(stage, stage + '.retained'); fs.writeFileSync(stage, 'Foreign replacement stage', { mode: 0o644 });
    },
  };
  const owner = new SQLiteStorePersistence(f.file, io); owner.acceptBaseline(owner.read());
  expect(() => owner.writeIfCurrent(Buffer.from('must not publish'))).toThrow(SQLitePublicationError);
  if (!stage) throw new Error('Fixture original stage missing');
  expect(fs.readFileSync(stage, 'utf8')).toBe('Foreign replacement stage'); expect(fs.readFileSync(stage + '.retained', 'utf8')).toBe('must not publish');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('original image');
});

test('a borrowed rename that publishes before throwing remains indeterminate and preserves visible bytes', () => {
  const f = fixture(); const io: SQLitePublicationIO = { ...fs, renameSync(from, to) { fs.renameSync(from, to); throw new Error('Lost rename acknowledgement'); } };
  const owner = new SQLiteStorePersistence(f.file, io); owner.acceptBaseline(owner.read());
  let error: unknown; try { owner.writeIfCurrent(Buffer.from('visible new image')); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(SQLitePublicationError); expect((error as SQLitePublicationError).phase).toBe('indeterminate');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('visible new image'); expect(() => owner.writeIfCurrent(Buffer.from('no speculative retry'))).toThrow('persisted state changed');
});

test('a fresh native image receives its exact private mode even under a restrictive umask', () => {
  const f = fixture(false), previous = process.umask(0o777);
  try { f.persistence.acceptBaseline(null); f.persistence.writeIfCurrent(Buffer.from('first private image')); }
  finally { process.umask(previous); }
  expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
});


test('parent replacement inside a borrowed write receives no further publication or cleanup effects', () => {
  const f = fixture(), retained = f.root + '.retained'; roots.push(retained); let replaced = false;
  const io: SQLitePublicationIO = { ...fs, writeFileSync(fd, data) {
    fs.writeFileSync(fd, data);
    if (!replaced) { replaced = true; fs.renameSync(f.root, retained); fs.mkdirSync(f.root); fs.writeFileSync(f.file, 'Foreign replacement database'); }
  } };
  const owner = new SQLiteStorePersistence(f.file, io); owner.acceptBaseline(owner.read());
  expect(() => owner.writeIfCurrent(Buffer.from('private owned stage'))).toThrow(SQLitePublicationError);
  expect(fs.readdirSync(f.root)).toEqual(['knowledge.sqlite']); expect(fs.readFileSync(f.file, 'utf8')).toBe('Foreign replacement database');
  expect(fs.readFileSync(join(retained, 'knowledge.sqlite'), 'utf8')).toBe('original image');
});

test('an explicitly configured initial directory alias keeps the original canonical database and alias intact', () => {
  const f = fixture(), alias = join(f.root, 'configured-alias'); fs.symlinkSync(f.root, alias);
  const owner = new SQLiteStorePersistence(join(alias, 'knowledge.sqlite')); owner.acceptBaseline(owner.read());
  owner.writeIfCurrent(Buffer.from('canonical next image'));
  expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true); expect(fs.readFileSync(f.file, 'utf8')).toBe('canonical next image');
  expect(fs.readFileSync(join(alias, 'knowledge.sqlite'), 'utf8')).toBe('canonical next image');
});


test('initially missing nested database parents restore private owner access under a restrictive umask', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'sqlite-private-create-')); roots.push(root);
  const file = join(root, 'new', 'nested', 'knowledge.sqlite'), previous = process.umask(0o777);
  try {
    const owner = new SQLiteStorePersistence(file); owner.acceptBaseline(null); owner.writeIfCurrent(Buffer.from('first private nested image'));
  } finally { process.umask(previous); }
  expect(fs.statSync(join(root, 'new')).mode & 0o777).toBe(0o700); expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600); expect(fs.readFileSync(file, 'utf8')).toBe('first private nested image');
});
