/** Native snapshot compatibility/ownership regressions, authored and UNRUN. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TriggerManager, TriggerSnapshotStore, TriggerStoreVersionError, checksumOf, getTriggerReapReportPath, loadTriggerSnapshot, saveTriggerSnapshot, validateSnapshot, writeReapReport, type TriggerRecoveryReport, type TriggerRecord } from '../platform/src/platform/triggers/index.ts';
const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync(join(tmpdir(), 'trigger-snapshot-v2-')); roots.push(root); return { root, path: join(root, 'triggers.json') }; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const input = { daemonBootId: 'fixture-boot', triggers: [], grants: [], eventLog: [], now: 1000 } as const;
const report: TriggerRecoveryReport = { at: 1000, reason: 'startup', triggersLoaded: 1, triggersReaped: 1, reapedIds: ['retired'], runsReaped: 0, observationsReaped: 0, eventsReaped: 0, orphanedProcesses: [] };
function publishedV1(triggers: readonly unknown[] = []) {
  const body = { version: 1, daemonBootId: 'released-boot', savedAt: 1000, triggers, grants: [], eventLog: [] };
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


function platformToolRecord(state: 'idle' | 'cancelled' = 'idle'): TriggerRecord {
  return {
    definition: { id: 'bounded-inspection', label: 'Bounded inspection', createdAt: 1000,
      spec: { kind: 'condition', probe: { kind: 'platform-tool', tool: 'status.inspect', input: { detail: 'summary' } }, extract: { kind: 'raw' }, rule: { kind: 'change' } },
      action: { kind: 'agent-turn', prompt: 'Review the bounded inspection result.' } },
    state, observations: [], runs: [], ruleState: {}, strikes: 0, backoffRung: 0, firedCount: 0, droppedLines: 0, updatedAt: 1000,
  };
}
/** The deployed old probe spelling appears only in actual saved-input fixtures. */
function savedEarlierToolRecord(state: 'idle' | 'cancelled' = 'idle') {
  const record = platformToolRecord(state), spec = record.definition.spec;
  if (spec.kind !== 'condition') throw Error('Expected condition fixture');
  return { ...record, definition: { ...record.definition, spec: { ...spec, probe: { ...spec.probe, kind: 'sdk-tool' } } } };
}

for (const version of [1, 2]) test(`actual saved v${version} earlier tool probes normalize on read and publish only canonical data`, () => {
  const { root, path: previousPath } = fixture(), path = join(root, 'triggers-v2.json');
  const previous = version === 1 ? publishedV1([savedEarlierToolRecord('cancelled')]) : undefined;
  const earlier = version === 2 ? `${JSON.stringify({ version: 2, daemonBootId: 'earlier', savedAt: 1000, triggers: [savedEarlierToolRecord()], grants: [], eventLog: [] })}\n` : undefined;
  if (previous !== undefined) fs.writeFileSync(previousPath, previous, { mode: 0o600 });
  if (earlier !== undefined) fs.writeFileSync(path, earlier, { mode: 0o600 });
  const formats: string[] = [];
  const store = new TriggerSnapshotStore(path, () => { formats.push('trigger-snapshots-v2'); }, version === 1 ? previousPath : undefined,
    () => { formats.push('trigger-platform-tool-kind-v1'); });
  const loaded = store.load(true).snapshot;
  expect(loaded).not.toBeNull();
  const probe = loaded!.triggers[0]?.definition.spec;
  expect(probe?.kind === 'condition' && probe.probe.kind).toBe('platform-tool');
  expect(formats).toEqual([]);
  if (earlier !== undefined) expect(fs.readFileSync(path, 'utf8')).toBe(earlier);
  if (previous !== undefined) expect(fs.readFileSync(previousPath, 'utf8')).toBe(previous);
  store.save({ ...input, triggers: loaded!.triggers });
  const published = fs.readFileSync(path, 'utf8');
  expect(published).toContain('platform-tool'); expect(published).not.toContain('sdk-tool');
  expect(formats).toContain('trigger-platform-tool-kind-v1');
  if (previous !== undefined) expect(fs.readFileSync(previousPath, 'utf8')).toBe(previous);
  expect('invalid' in validateSnapshot({ version: 2, daemonBootId: 'caller', savedAt: 1000, triggers: [savedEarlierToolRecord()], grants: [], eventLog: [] })).toBe(true);
});

test('actual manager refuses an incompatible platform-tool reader before changing saved trigger bytes or admitting effects', async () => {
  const { path } = fixture();
  const bytes = JSON.stringify({ version: 2, daemonBootId: 'earlier', savedAt: 1000, triggers: [savedEarlierToolRecord()], grants: [], eventLog: [] });
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  let effects = 0; const formats: string[] = [];
  const manager = new TriggerManager({ storePath: path, config: { enabled: true }, now: () => 1000,
    nativeDataWriter: { declare(format) { formats.push(format); if (format === 'trigger-platform-tool-kind-v1') throw Error('reader cohort incompatible'); } },
    actions: { async runAgentTurn() { effects++; return ''; }, async runGrant() { effects++; return ''; } } });
  try {
    expect(() => manager.load()).toThrow('reader cohort incompatible');
    expect(formats).toContain('trigger-snapshots-v2'); expect(formats).toContain('trigger-platform-tool-kind-v1');
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes); expect(effects).toBe(0);
    expect(fs.existsSync(`${path}.cutover.json`)).toBe(false);
  } finally { manager.shutdown(); await manager.join(); }
});

test('an asynchronous platform-tool write restriction is drained and refuses before original snapshot mutation', () => {
  const { path } = fixture(), bytes = JSON.stringify({ version: 2, daemonBootId: 'earlier', savedAt: 1000, triggers: [], grants: [], eventLog: [] });
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  const store = new TriggerSnapshotStore(path, undefined, undefined, async () => { throw Error('retired reader'); });
  store.load(); expect(() => store.save({ ...input, triggers: [platformToolRecord()] })).toThrow();
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes); expect(fs.existsSync(`${path}.cutover.json`)).toBe(false);
});
