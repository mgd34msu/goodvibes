import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
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

test('ordinary save accepts an identical-byte physical replacement without storing another live image', () => {
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
  const prior = readSQLitePersistedImage(f.persistence).identity;
  const retained = f.root + '.retained'; roots.push(retained); fs.renameSync(f.root, retained);
  fs.mkdirSync(f.root); fs.writeFileSync(f.file, 'original image');
  expect(readSQLitePersistedImage(f.persistence).identity).not.toBe(prior);
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
