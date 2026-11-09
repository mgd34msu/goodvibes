/** Source-only regressions; no provider calls or recorded-reading rewrites. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.ts';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStaticInputs, readStaticInput, staticDecisionSourceHash, staticDecisionSourceManifest,
  withStaticSourcePolicyPass } from '../scripts/static-source-readings.ts';
import { checkNoInternalIdentifiers } from '../scripts/internal-identifier-rule.ts';
import { sourceMarkerFindings } from '../scripts/no-todo-marker-rules.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scripts = resolve(import.meta.dir, '../scripts'), packages = resolve(scripts, '../..');
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'static-policy-original-')); roots.push(root);
  // Only the policy's existing16 named source files, real original bytes.
  for (const [file] of staticDecisionSourceManifest()) {
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
  return { source, original, changed, edit, close: () => { directories.mockRestore(); } };
}
const descriptorReads = (read: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) =>
  read.mock.calls.filter(([path]) => typeof path === 'number').length;

test('actual multi-candidate identifier gate and deferred-source reader hash policy bodies once per pass', () => {
  const f = fixture(), readings = { format: 1 as const, decisionSourceHash: staticDecisionSourceHash(), readings: {} }, read = spyOn(fs, 'readFileSync');
  try {
    const candidates = Array.from({ length: 12 }, (_, index) => ({ relPath: `sdk/src/example-${index}.ts`, text: 'const value = 3;' }));
    const held: string[] = [];
    expect(checkNoInternalIdentifiers(candidates, readings, finding => { held.push(finding); })).toEqual([]);
    expect(held.length).toBeGreaterThan(1); expect(descriptorReads(read)).toBe(16);
    read.mockClear();
    const markers = Array.from({ length: 12 }, (_, index) => `// Finish persistence for reader ${index}.`).join('\n\n');
    expect(sourceMarkerFindings('sdk/src/example.ts', markers, readings).length).toBeGreaterThan(1);
    expect(descriptorReads(read)).toBe(16);
    // A completed pass cannot make a later invocation silently reuse its owner.
    read.mockClear(); checkNoInternalIdentifiers(candidates, readings);
    expect(descriptorReads(read)).toBe(16);
    read.mockClear(); checkNoInternalIdentifiers(candidates, null);
    expect(descriptorReads(read)).toBe(0);
  } finally { read.mockRestore(); f.close(); }
});

test('same-size edits, restored bytes/mtime, and identical-byte leaf replacements recompute originals', () => {
  const f = fixture(), read = spyOn(fs, 'readFileSync');
  try {
    withStaticSourcePolicyPass(() => {
      const first = staticDecisionSourceHash(); expect(descriptorReads(read)).toBe(16);
      const manifest = staticDecisionSourceManifest();
      expect(Object.isFrozen(manifest)).toBe(true); expect(Object.isFrozen(manifest[0])).toBe(true);
      expect(staticDecisionSourceHash()).toBe(first); expect(descriptorReads(read)).toBe(16);
      f.edit(f.changed); expect(staticDecisionSourceHash()).not.toBe(first); expect(descriptorReads(read)).toBe(32);
      f.edit(f.original); expect(staticDecisionSourceHash()).toBe(first); expect(descriptorReads(read)).toBe(48);
      fs.writeFileSync(`${f.source}.replacement`, f.original); fs.renameSync(`${f.source}.replacement`, f.source);
      expect(staticDecisionSourceHash()).toBe(first); expect(descriptorReads(read)).toBe(64);
      fs.unlinkSync(f.source); expect(() => staticDecisionSourceHash()).toThrow();
    });
  } finally { read.mockRestore(); f.close(); }
});

test('actual gate held callbacks cannot make later candidates approve under a stale policy owner', async () => {
  const f = fixture(), candidates = [
    { relPath: 'sdk/src/uncaptured.ts', text: 'const missing = 3;' },
    { relPath: 'sdk/src/current.ts', text: 'const value = 3;' },
  ];
  try {
    const inputs = captureStaticInputs('internal-identifier', candidates[1]!.relPath, candidates[1]!.text);
    const readings = await preparedStaticReadings(inputs);
    const held: string[] = [];
    expect(checkNoInternalIdentifiers(candidates, readings, finding => {
      held.push(finding); if (held.length === 1) f.edit(f.changed);
    })).toEqual([]);
    expect(held).toHaveLength(2); expect(held[1]).toContain('stale decision source');
  } finally { f.close(); }
});

test('the final actual gate callback cannot release a result using an invalidated original policy', () => {
  const f = fixture(), readings = { format: 1 as const, decisionSourceHash: staticDecisionSourceHash(), readings: {} };
  try {
    expect(() => checkNoInternalIdentifiers([{ relPath: 'sdk/src/example.ts', text: 'const value = 3;' }], readings,
      () => { f.edit(f.changed); })).toThrow('Static policy source changed');
  } finally { f.close(); }
});

test('incoherent original capture is rejected instead of caching a mixed16-file manifest', () => {
  const f = fixture(), originalRead = fs.readFileSync; let reads = 0, edited = false;
  const read = spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const value = Reflect.apply(originalRead, fs, args);
    if (typeof args[0] === 'number' && ++reads === 2) { edited = true; f.edit(f.changed); }
    return value;
  });
  try {
    withStaticSourcePolicyPass(() => {
      expect(() => staticDecisionSourceHash()).toThrow('Static policy source changed');
      expect(edited).toBe(true);
      // No successful prior snapshot exists to fall back to after capture fails.
      fs.unlinkSync(f.source); expect(() => staticDecisionSourceHash()).toThrow();
    });
  } finally { read.mockRestore(); f.close(); }
});

test('actual static reader rechecks the owned policy after its provider await and rejects changed source', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { entered = resolve; });
  const fake = fakePort(() => noulAnswer(0.01));
  using log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog({ ...fake.port, async ask(request) { entered(); await held; return fake.port.ask(request); } }, log);
  try {
    const input = captureStaticInputs('internal-identifier', 'sdk/src/example.ts', 'const value = 3;')[0]!;
    const reading = readStaticInput(port, log, input);
    await admitted; f.edit(f.changed); release();
    await expect(reading).rejects.toThrow('Static decision source changed during reading');
    expect(fake.requests).toHaveLength(1);
    expect(log.query({ status: 'answered' })).toHaveLength(1);
  } finally { release(); f.close(); }
});
