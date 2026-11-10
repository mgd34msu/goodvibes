import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore } from '../platform/src/platform/state/json-file-store.js';
import { AtomicWriteDurabilityError } from '../platform/src/platform/utils/atomic-json-store.js';
import { writeJsonFileAtomicAsync } from '../platform/src/platform/utils/atomic-json-write-async.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const restore: Array<() => void> = [];
afterEach(() => { for (const close of restore.splice(0).reverse()) close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() { const root = makeProjectTempDir('atomic-async-publication'); return { root, file: join(root, 'state.json') }; }
function holdFirstDirectorySync(requiredFiles = 1) {
  const entered = deferred(), staged = deferred(), original = fs.fsync;
  let release: (() => void) | undefined, files = 0, held = false;
  const sync = spyOn(fs, 'fsync').mockImplementation((fd, callback) => {
    const directory = fs.fstatSync(fd).isDirectory();
    original(fd, error => {
      if (!directory) { if (++files === requiredFiles) staged.resolve(); callback(error); return; }
      if (!held) { held = true; release = () => callback(error); entered.resolve(); return; }
      callback(error);
    });
  });
  restore.push(() => { release?.(); sync.mockRestore(); });
  return { entered: entered.promise, staged: staged.promise, release() { const done = release; release = undefined; done?.(); } };
}

test('concurrent stores retain call-order images until each original durability acknowledgement drains', async () => {
  const f = fixture(), alias = join(f.root, 'alias'); fs.symlinkSync(f.root, alias);
  const gate = holdFirstDirectorySync(3), completed: string[] = [];
  const first = new JsonFileStore<{ value: string }>(f.file), other = new JsonFileStore<{ value: string }>(join(alias, 'state.json'));
  const initial = first.save({ value: 'first' }).then(() => { completed.push('first'); });
  await gate.entered;
  const secondValue = { value: 'second' }, thirdValue = { value: 'third' };
  const second = other.save(secondValue).then(() => { completed.push('second'); });
  const third = first.save(thirdValue).then(() => { completed.push('third'); });
  secondValue.value = 'caller changed second'; thirdValue.value = 'caller changed third';
  try {
    await gate.staged;
    expect(await first.load()).toEqual({ value: 'first' }); expect(completed).toEqual([]);
  } finally { gate.release(); }
  await Promise.all([initial, second, third]);
  expect(completed).toEqual(['first', 'second', 'third']); expect(await other.load()).toEqual({ value: 'third' });
  expect(fs.readdirSync(f.root).filter(name => name.includes('.tmp-'))).toEqual([]);
});

test('a queued retired caller refuses before publication and releases its live successor', async () => {
  const f = fixture(), gate = holdFirstDirectorySync(3); let active = true;
  const first = writeJsonFileAtomicAsync(f.file, { value: 'first' }); await gate.entered;
  const second = writeJsonFileAtomicAsync(f.file, { value: 'retired' }, { assertCurrent() { if (!active) throw new Error('Original caller retired'); } });
  // Observe every rejection as soon as the operation is accepted.
  const refused = second.catch((error: unknown) => error);
  const third = writeJsonFileAtomicAsync(f.file, { value: 'third' });
  try { await gate.staged; active = false; } finally { gate.release(); }
  await first;
  const error: unknown = await refused;
  expect(error).toBeInstanceOf(AtomicWriteDurabilityError);
  if (!(error instanceof AtomicWriteDurabilityError)) throw new Error('Missing typed publication refusal');
  expect(error.phase).toBe('before-publication'); expect(error.cause).toBeInstanceOf(Error);
  await third;
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ value: 'third' });
  expect(fs.readdirSync(f.root).filter(name => name.includes('.tmp-'))).toEqual([]);
});

test('a queued foreign stage replacement is preserved while its live successor can publish', async () => {
  const f = fixture(), gate = holdFirstDirectorySync(3), retained = join(f.root, 'original-stage');
  const first = writeJsonFileAtomicAsync(f.file, { value: 'first' }); await gate.entered;
  const second = writeJsonFileAtomicAsync(f.file, { value: 'second' }).catch((error: unknown) => error);
  const third = writeJsonFileAtomicAsync(f.file, { value: 'third' });
  let foreign: string | undefined;
  try {
    await gate.staged;
    foreign = fs.readdirSync(f.root).map(name => join(f.root, name)).find(path => path.includes('.tmp-') && JSON.parse(fs.readFileSync(path, 'utf8')).value === 'second');
    if (!foreign) throw new Error('Missing actual queued stage');
    fs.renameSync(foreign, retained); fs.writeFileSync(foreign, 'Foreign staged replacement', { mode: 0o644 });
  } finally { gate.release(); }
  await first;
  const error: unknown = await second;
  expect(error).toBeInstanceOf(AtomicWriteDurabilityError);
  if (!(error instanceof AtomicWriteDurabilityError)) throw new Error('Missing queued-stage refusal');
  expect(error.phase).toBe('before-publication'); await third;
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ value: 'third' });
  expect(fs.readFileSync(foreign!, 'utf8')).toBe('Foreign staged replacement'); expect(fs.statSync(foreign!).mode & 0o777).toBe(0o644);
  expect(JSON.parse(fs.readFileSync(retained, 'utf8'))).toEqual({ value: 'second' });
});

test('queued publications cannot enter a replaced original parent', async () => {
  const f = fixture(), parent = join(f.root, 'parent'), retained = join(f.root, 'retained-parent'); fs.mkdirSync(parent);
  const file = join(parent, 'state.json'), gate = holdFirstDirectorySync(2);
  const first = writeJsonFileAtomicAsync(file, { value: 'first' }).catch((error: unknown) => error); await gate.entered;
  const second = writeJsonFileAtomicAsync(file, { value: 'second' }).catch((error: unknown) => error);
  try {
    await gate.staged; fs.renameSync(parent, retained); fs.mkdirSync(parent);
    fs.writeFileSync(file, 'Foreign parent target');
  } finally { gate.release(); }
  const initial: unknown = await first, queued: unknown = await second;
  expect(initial).toBeInstanceOf(AtomicWriteDurabilityError); expect(queued).toBeInstanceOf(AtomicWriteDurabilityError);
  if (!(initial instanceof AtomicWriteDurabilityError) || !(queued instanceof AtomicWriteDurabilityError)) throw new Error('Missing original-parent refusal');
  expect(initial.phase).toBe('published-indeterminate'); expect(queued.phase).toBe('before-publication');
  expect(fs.readFileSync(file, 'utf8')).toBe('Foreign parent target');
  expect(JSON.parse(fs.readFileSync(join(retained, 'state.json'), 'utf8'))).toEqual({ value: 'first' });
});

test('a failed directory sync stays published-indeterminate and does not strand the next publisher', async () => {
  const f = fixture(), actual = fs.fsync; let failed = false;
  const sync = spyOn(fs, 'fsync').mockImplementation((fd, callback) => {
    if (!failed && fs.fstatSync(fd).isDirectory()) { failed = true; callback(new Error('Original directory sync failed')); return; }
    actual(fd, callback);
  }); restore.push(() => sync.mockRestore());
  const first = writeJsonFileAtomicAsync(f.file, { value: 'first' }).catch((error: unknown) => error);
  const second = writeJsonFileAtomicAsync(f.file, { value: 'second' });
  const error: unknown = await first;
  expect(error).toBeInstanceOf(AtomicWriteDurabilityError);
  if (!(error instanceof AtomicWriteDurabilityError)) throw new Error('Missing typed durability failure');
  expect(error.phase).toBe('published-indeterminate');
  await second; expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ value: 'second' });
});

test('an external replacement during directory sync cannot become the original acknowledged image', async () => {
  const f = fixture(), gate = holdFirstDirectorySync(), retained = join(f.root, 'retained');
  const pending = writeJsonFileAtomicAsync(f.file, { value: 'requested' }).catch((error: unknown) => error);
  try {
    await gate.entered;
    fs.renameSync(f.file, retained); fs.writeFileSync(f.file, 'Foreign replacement', { mode: 0o644 });
  } finally { gate.release(); }
  const error: unknown = await pending;
  expect(error).toBeInstanceOf(AtomicWriteDurabilityError);
  if (!(error instanceof AtomicWriteDurabilityError)) throw new Error('Missing original-image refusal');
  expect(error.phase).toBe('published-indeterminate');
  expect(fs.readFileSync(f.file, 'utf8')).toBe('Foreign replacement'); expect(fs.statSync(f.file).mode & 0o777).toBe(0o644);
  expect(JSON.parse(fs.readFileSync(retained, 'utf8'))).toEqual({ value: 'requested' });
});

test('serialization failure releases its reserved publication slot without delaying later captures', async () => {
  const f = fixture(), circular: { cycle?: unknown } = {}; circular.cycle = circular;
  const failed = writeJsonFileAtomicAsync(f.file, circular).catch((error: unknown) => error);
  const next = writeJsonFileAtomicAsync(f.file, { value: 'next' });
  expect(await failed).toBeInstanceOf(AtomicWriteDurabilityError); await next;
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ value: 'next' });
});

test('an early failed middle reservation cannot let its successor bypass an older live publication', async () => {
  const f = fixture(), gate = holdFirstDirectorySync(2), circular: { cycle?: unknown } = {}; circular.cycle = circular;
  const first = writeJsonFileAtomicAsync(f.file, { value: 'first' }); await gate.entered;
  let failedSettled = false, thirdSettled = false;
  const failed = writeJsonFileAtomicAsync(f.file, circular).catch((error: unknown) => { failedSettled = true; return error; });
  const third = writeJsonFileAtomicAsync(f.file, { value: 'third' }).then(() => { thirdSettled = true; });
  try {
    await gate.staged;
    expect(failedSettled).toBe(false); expect(thirdSettled).toBe(false);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ value: 'first' });
  } finally { gate.release(); }
  await first; expect(await failed).toBeInstanceOf(AtomicWriteDurabilityError); await third;
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({ value: 'third' });
});
