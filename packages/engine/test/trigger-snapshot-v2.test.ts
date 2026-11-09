/** Native snapshot compatibility/ownership regressions, authored and UNRUN. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TriggerManager, TriggerSnapshotStore, TriggerStoreVersionError, checksumOf, getTriggerReapReportPath, loadTriggerSnapshot, saveTriggerSnapshot, validateSnapshot, writeReapReport, type TriggerRecoveryReport } from '../sdk/src/platform/triggers/index.ts';
const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync(join(tmpdir(), 'trigger-snapshot-v2-')); roots.push(root); return { root, path: join(root, 'triggers.json') }; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const input = { daemonBootId: 'fixture-boot', triggers: [], grants: [], eventLog: [], now: 1000 } as const;
const report: TriggerRecoveryReport = { at: 1000, reason: 'startup', triggersLoaded: 1, triggersReaped: 1, reapedIds: ['retired'], runsReaped: 0, observationsReaped: 0, eventsReaped: 0, orphanedProcesses: [] };
function publishedV1() {
  const body = { version: 1, daemonBootId: 'released-boot', savedAt: 1000, triggers: [], grants: [], eventLog: [] };
  // Independent reproduction of the deployed v1 fixture representation only.
  return `${JSON.stringify({ ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') })}\n`;
}
test('fresh v2 writes/read have no whole-document checksum and compatibility hashing refuses v2', () => {
  const { path } = fixture(); saveTriggerSnapshot(path, input);
  const data = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  expect(data['version']).toBe(2); expect(Object.hasOwn(data, 'checksum')).toBe(false); expect(loadTriggerSnapshot(path).snapshot?.version).toBe(2);
  expect(() => checksumOf({ ...input, savedAt: input.now, version: 2 })).toThrow(); expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});
test('actual v1 reads preserve its exact checksum and a rejected new reader floor preserves original bytes', () => {
  const { path } = fixture(), bytes = publishedV1(); fs.writeFileSync(path, bytes, { mode: 0o600 });
  const store = new TriggerSnapshotStore(path, () => { throw Error('reader cohort incompatible'); });
  expect(store.load().snapshot?.version).toBe(1); expect(() => store.save(input)).toThrow('reader cohort incompatible'); expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
});
test('future snapshot refuses before quarantine, reset, floor declaration or trigger effects', async () => {
  const { root, path } = fixture(), bytes = '{"version":99,"future":"keep"}\n'; fs.writeFileSync(path, bytes, { mode: 0o600 });
  let declared = 0, actions = 0;
  const manager = new TriggerManager({ storePath: path, config: { enabled: true }, nativeDataWriter: { declare() { declared += 1; } },
    actions: { async runAgentTurn() { actions += 1; return ''; }, async runGrant() { actions += 1; return ''; } } });
  expect(() => manager.load()).toThrow(TriggerStoreVersionError); await expect(manager.create({})).rejects.toBeInstanceOf(TriggerStoreVersionError);
  expect(declared).toBe(0); expect(actions).toBe(0); expect(fs.readFileSync(path, 'utf8')).toBe(bytes); expect(fs.readdirSync(root)).toEqual(['triggers.json']);
});
test('unknown future versions are also preserved by the direct writer entry point', () => {
  const { path } = fixture(), bytes = '{"version":3,"future":"keep"}'; fs.writeFileSync(path, bytes);
  expect(() => saveTriggerSnapshot(path, input)).toThrow(TriggerStoreVersionError); expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
});
test('the old PID temporary name and unknown quarantine target remain untouched', () => {
  const { path } = fixture(), oldTemp = `${path}.tmp-${process.pid}`; fs.writeFileSync(oldTemp, 'foreign temp'); saveTriggerSnapshot(path, input);
  expect(fs.readFileSync(oldTemp, 'utf8')).toBe('foreign temp');
  const clock = spyOn(Date, 'now').mockReturnValue(4242);
  try {
    const oldQuarantine = `${path}.corrupt-4242`; fs.mkdirSync(oldQuarantine); fs.writeFileSync(join(oldQuarantine, 'foreign'), 'keep'); fs.writeFileSync(path, 'broken');
    const loaded = loadTriggerSnapshot(path); expect(loaded.snapshot).toBeNull(); expect(loaded.quarantined).toContain('moved to');
    expect(fs.readFileSync(join(oldQuarantine, 'foreign'), 'utf8')).toBe('keep');
    const copies = fs.readdirSync(dirname(path)).filter(name => name.startsWith('triggers.json.corrupt-') && fs.statSync(join(dirname(path), name)).isFile());
    expect(copies).toHaveLength(1); expect(fs.readFileSync(join(dirname(path), copies[0]!), 'utf8')).toBe('broken'); expect(fs.statSync(join(dirname(path), copies[0]!)).mode & 0o777).toBe(0o600);
  } finally { clock.mockRestore(); }
});
test('a failed quarantine rename never falls back to unlinking the original', () => {
  const { path } = fixture(), bytes = 'broken but retained'; fs.writeFileSync(path, bytes);
  const original = fs.renameSync, rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from) === path) throw Object.assign(Error('fixture rename denied'), { code: 'EACCES' }); original(from, to);
  });
  try { expect(() => loadTriggerSnapshot(path)).toThrow(); expect(fs.readFileSync(path, 'utf8')).toBe(bytes); }
  finally { rename.mockRestore(); }
});
test('changed parent during floor declaration cannot publish into its foreign replacement', () => {
  const { root, path } = fixture(), original = `${root}.original`; roots.push(original);
  saveTriggerSnapshot(path, input); const bytes = fs.readFileSync(path, 'utf8');
  const store = new TriggerSnapshotStore(path, () => { fs.renameSync(root, original); fs.mkdirSync(root); fs.writeFileSync(path, 'foreign source'); }); store.load();
  expect(() => store.save(input)).toThrow(); expect(fs.readFileSync(path, 'utf8')).toBe('foreign source'); expect(fs.readFileSync(join(original, 'triggers.json'), 'utf8')).toBe(bytes);
});
test('equal-byte replacement invalidates the original manager store owner', () => {
  const { path } = fixture(); saveTriggerSnapshot(path, input); const store = new TriggerSnapshotStore(path); store.load(); const bytes = fs.readFileSync(path, 'utf8');
  fs.renameSync(path, `${path}.original`); fs.writeFileSync(path, bytes); expect(() => store.save(input)).toThrow(); expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
});
test('malformed report history is preserved instead of silently resetting it', () => {
  const { path } = fixture(), reportPath = getTriggerReapReportPath(path), bytes = '{"future":3}'; fs.writeFileSync(reportPath, bytes);
  expect(() => writeReapReport(path, report)).toThrow(); expect(fs.readFileSync(reportPath, 'utf8')).toBe(bytes);
});
test('v2 fully validates grants/events/runtime records, beyond only a definition id', () => {
  const base = { version: 2, daemonBootId: 'fixture', savedAt: 1, triggers: [], grants: [], eventLog: [] };
  expect('invalid' in validateSnapshot({ ...base, grants: [{ id: 'forged' }] })).toBe(true);
  expect('invalid' in validateSnapshot({ ...base, eventLog: [{ at: 1, triggerId: 'x', kind: 'condition', event: 'execute-arbitrary', fingerprint: '' }] })).toBe(true);
});
