/** Authored unit observations and real file ownership; no live model/cache rewrites. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as atomic from '../platform/src/platform/utils/atomic-json-store.ts';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStaticInputs, staticInputKey, staticInputStanding, readStaticInput, staticDecisionSourceManifest,
  staticDecisionSourceObservation, revalidateStaticInput, withStaticSourcePolicyPass } from '../scripts/static-source-readings.ts';
import { createStaticCallRecorder } from '../scripts/static-source-call-recording.ts';
import { checkNoInternalIdentifiers } from '../scripts/internal-identifier-rule.ts';
import { sourceMarkerAnchors, sourceMarkerFindings } from '../scripts/no-todo-marker-rules.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('missing or empty stores and malformed receipts never calculate a policy or input digest', () => {
  const hashing = spyOn(crypto, 'createHash'), nativeHashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const input = captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const value = 3;')[0]!;
    const key = staticInputKey(input);
    expect(JSON.parse(key)).toEqual([input.kind, input.path, input.firstLine, input.lastLine, input.anchors.map(anchor => [anchor.id, anchor.line, anchor.col])]);
    expect(revalidateStaticInput(input, null)).toBeNull();
    expect(revalidateStaticInput(input, { format: 2, readings: {} })).toBeNull();
    expect(revalidateStaticInput(input, { format: 2, readings: { [key]: 17 } })).toBeNull();
    expect(hashing).not.toHaveBeenCalled(); expect(nativeHashing).not.toHaveBeenCalled();
  } finally { hashing.mockRestore(); nativeHashing.mockRestore(); }
});

for (const withProgress of [false, true]) for (const failed of [false, true]) test(`raw static capture does no hashing (progress=${withProgress}, failed=${failed})`, async () => {
  const hashing = spyOn(crypto, 'createHash'), nativeHashing = spyOn(Bun.CryptoHasher, 'hash');
  const model = fakePort(() => { if (failed) throw new Error('Unavailable unit fixture'); return noulAnswer(0.01); });
  const recorded = createStaticCallRecorder(model.port);
  try {
    const input = captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const value = 3;')[0]!;
    const reading = readStaticInput(recorded.port, recorded.capture, input, undefined, withProgress ? {
      previous: { format: 2, readings: {} }, onReceipt() {},
    } : undefined);
    if (failed) await expect(reading).rejects.toThrow();
    else {
      const receipt = await reading;
      expect(receipt.input).toEqual(input);
      expect(receipt.presence.state).toHaveProperty('source', input.source);
      expect(recorded.calls).toHaveLength(1);
    }
    expect(hashing).not.toHaveBeenCalled(); expect(nativeHashing).not.toHaveBeenCalled();
  } finally { hashing.mockRestore(); nativeHashing.mockRestore(); }
});

const scripts = resolve(import.meta.dir, '../scripts'), packages = resolve(scripts, '../..');
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'static-policy-original-')); roots.push(root);
  const policy = staticDecisionSourceManifest();
  for (const [file] of policy) {
    const original = resolve(scripts, file), path = join(root, relative(packages, original));
    fs.mkdirSync(dirname(path), { recursive: true }); fs.copyFileSync(original, path);
  }
  const capture = atomic.captureExistingDirectory;
  const directories = spyOn(atomic, 'captureExistingDirectory').mockImplementation(directory => {
    const inside = relative(packages, directory);
    return capture(inside === '' || (!inside.startsWith('..') && !inside.startsWith('/')) ? join(root, inside) : directory);
  });
  const source = join(root, relative(packages, resolve(scripts, 'batteries/static-source.ts')));
  const original = fs.readFileSync(source), stamp = fs.statSync(source);
  const changed = Buffer.from(original); changed[0] = changed[0] === 47 ? 42 : 47;
  const edit = (bytes: Buffer) => { fs.writeFileSync(source, bytes); fs.utimesSync(source, stamp.atime, stamp.mtime); };
  return { source, original, changed, edit, fileCount: policy.length, close: () => { directories.mockRestore(); } };
}
const descriptorReads = (read: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) =>
  read.mock.calls.filter(([path]) => typeof path === 'number').length;

test('actual multi-candidate gates capture raw policy originals once per pass without hashing', () => {
  const f = fixture(), readings = { format: 2 as const, readings: {} }, read = spyOn(fs, 'readFileSync');
  const hashing = spyOn(crypto, 'createHash');
  try {
    const candidates = Array.from({ length: 12 }, (_, index) => ({ relPath: `platform/src/example-${index}.ts`, text: 'const value = 3;' }));
    const held: string[] = [];
    expect(checkNoInternalIdentifiers(candidates, readings, finding => { held.push(finding); })).toEqual([]);
    expect(held.length).toBeGreaterThan(1); expect(descriptorReads(read)).toBe(f.fileCount);
    read.mockClear();
    const markers = Array.from({ length: 181 }, (_, index) => `// Finish persistence for reader ${index}.`).join('\n\n');
    expect(sourceMarkerFindings('platform/src/example.ts', markers, readings).length).toBeGreaterThan(1);
    expect(descriptorReads(read)).toBe(f.fileCount);
    read.mockClear(); checkNoInternalIdentifiers(candidates, readings);
    expect(descriptorReads(read)).toBe(f.fileCount);
    read.mockClear(); checkNoInternalIdentifiers(candidates, null);
    expect(descriptorReads(read)).toBe(0);
    expect(hashing).not.toHaveBeenCalled();
  } finally { hashing.mockRestore(); read.mockRestore(); f.close(); }
});

test('same-size edits, byte restoration and equal-byte replacement cannot revive a retired policy owner', () => {
  const f = fixture(), read = spyOn(fs, 'readFileSync');
  let originalManifest: ReturnType<typeof staticDecisionSourceManifest> = [];
  try {
    expect(() => withStaticSourcePolicyPass(() => {
      originalManifest = staticDecisionSourceManifest();
      expect(descriptorReads(read)).toBe(f.fileCount);
      expect(Object.isFrozen(originalManifest)).toBe(true); expect(Object.isFrozen(originalManifest[0])).toBe(true);
      expect(staticDecisionSourceManifest()).toBe(originalManifest); expect(descriptorReads(read)).toBe(f.fileCount);
      f.edit(f.changed); expect(() => staticDecisionSourceObservation()).toThrow('Static policy source changed');
      f.edit(f.original); expect(() => staticDecisionSourceObservation()).toThrow('Static policy source changed');
      expect(descriptorReads(read)).toBe(f.fileCount);
    })).toThrow('Static policy source changed');
    expect(() => withStaticSourcePolicyPass(() => {
      expect(staticDecisionSourceManifest()).toEqual(originalManifest); expect(descriptorReads(read)).toBe(f.fileCount * 2);
      fs.writeFileSync(`${f.source}.replacement`, f.original); fs.renameSync(`${f.source}.replacement`, f.source);
      expect(() => staticDecisionSourceObservation()).toThrow('Static policy source changed');
    })).toThrow('Static policy source changed');
    withStaticSourcePolicyPass(() => { expect(staticDecisionSourceManifest()).toEqual(originalManifest); });
    expect(descriptorReads(read)).toBe(f.fileCount * 3);
    fs.unlinkSync(f.source);
    expect(() => withStaticSourcePolicyPass(() => staticDecisionSourceObservation())).toThrow();
  } finally { read.mockRestore(); f.close(); }
});

test('actual gate held callbacks retire policy before later candidates can return a result', async () => {
  const f = fixture(), candidates = [
    { relPath: 'platform/src/uncaptured.ts', text: 'const missing = 3;' },
    { relPath: 'platform/src/current.ts', text: 'const value = 3;' },
  ];
  try {
    const readings = await preparedStaticReadings(captureStaticInputs('internal-identifier', candidates[1]!.relPath, candidates[1]!.text));
    const held: string[] = [];
    expect(() => checkNoInternalIdentifiers(candidates, readings, finding => {
      held.push(finding); f.edit(f.changed);
    })).toThrow('Static policy source changed');
    expect(held).toHaveLength(1);
  } finally { f.close(); }
});

test('the final actual callback cannot release a result using invalidated original policy', () => {
  const f = fixture(), readings = { format: 2 as const, readings: {} };
  try {
    expect(() => checkNoInternalIdentifiers([{ relPath: 'platform/src/example.ts', text: 'const value = 3;' }], readings,
      () => { f.edit(f.changed); })).toThrow('Static policy source changed');
  } finally { f.close(); }
});

test('incoherent original capture refuses a mixed complete raw policy observation', () => {
  const f = fixture(), originalRead = fs.readFileSync; let reads = 0, edited = false;
  const read = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = Reflect.apply(originalRead, fs, args);
    if (typeof args[0] === 'number' && ++reads === 2) { edited = true; f.edit(f.changed); }
    return value;
  }) as typeof fs.readFileSync);
  try {
    withStaticSourcePolicyPass(() => {
      expect(() => staticDecisionSourceObservation()).toThrow('Static policy source changed');
      expect(edited).toBe(true);
      fs.unlinkSync(f.source); expect(() => staticDecisionSourceObservation()).toThrow();
    });
  } finally { read.mockRestore(); f.close(); }
});

test('the actual static reader refuses policy retirement after its provider await before recording', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { entered = resolve; });
  const fake = fakePort(() => noulAnswer(0.01));
  const recorded = createStaticCallRecorder({ ...fake.port, async ask(request) { entered(); await held; return fake.port.ask(request); } });
  const input = captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const value = 3;')[0]!;
  const reading = readStaticInput(recorded.port, recorded.capture, input);
  try {
    await Promise.race([admitted, reading.then(() => { throw new Error('Read settled before provider admission'); })]);
    f.edit(f.changed); release();
    await expect(reading).rejects.toThrow('Static policy source changed');
    expect(fake.requests).toHaveLength(1); expect(recorded.calls).toHaveLength(0);
  } finally { release(); await reading.catch(() => undefined); f.close(); }
});

test('actual missing-store gates retain identical structural held scopes and no hashing', () => {
  const internalText = Array.from({ length: 240 }, (_, index) => `Paragraph ${index} is complete.`).join('\n\n');
  const deferredText = Array.from({ length: 240 }, (_, index) => `// Persistence reader ${index} is documented.`).join('\n\n');
  const internal = captureStaticInputs('internal-identifier', 'docs/example.md', internalText);
  const deferred = captureStaticInputs('deferred-work', 'platform/src/example.ts', deferredText, sourceMarkerAnchors('platform/src/example.ts', deferredText));
  expect(internal.length).toBeGreaterThan(1); expect(deferred.length).toBeGreaterThan(1);
  const hashing = spyOn(crypto, 'createHash'), nativeHashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const held: string[] = [];
    expect(checkNoInternalIdentifiers([{ relPath: 'docs/example.md', text: internalText }], null, value => { held.push(value); })).toEqual([]);
    expect(held).toEqual(internal.map(input => `docs/example.md:${input.firstLine}: internal-identifier evidence held (missing or stale decision source); review source or run static-source:read [internal-identifier]`));
    expect(sourceMarkerFindings('platform/src/example.ts', deferredText, null)).toEqual(deferred.map(input => ({ line: input.firstLine, col: 1,
      marker: 'evidence-held', text: 'missing or stale decision source; run static-source:read' })));
    expect(hashing).not.toHaveBeenCalled(); expect(nativeHashing).not.toHaveBeenCalled();
  } finally { hashing.mockRestore(); nativeHashing.mockRestore(); }
});

test('an edit outside the transmitted window reuses identical exact input and questions', async () => {
  const first = '// Visible original source.', text = [first, ...Array.from({ length: 80 }, () => ''), '// Remote original source.'].join('\n');
  const anchors = [{ id: 'original', line: 1, col: 1, text: first }];
  const before = captureStaticInputs('deferred-work', 'platform/src/example.ts', text, anchors)[0]!;
  const after = captureStaticInputs('deferred-work', 'platform/src/example.ts', text.replace('Remote original', 'Remote modified'), anchors)[0]!;
  expect(before).not.toHaveProperty('sourceHash'); expect(before).toEqual(after);
  expect(staticInputKey(before)).toBe(staticInputKey(after));
  const readings = await preparedStaticReadings([before]);
  expect(staticInputStanding(after, readings)).toEqual({ kind: 'clear' });
  const forbidden = fakePort(() => { throw new Error('Identical wire must not be reread'); });
  const recorded = createStaticCallRecorder(forbidden.port);
  await readStaticInput(recorded.port, recorded.capture, after, undefined, { previous: readings, onReceipt() {} });
  expect(forbidden.requests).toHaveLength(0); expect(recorded.calls).toHaveLength(0);
});
