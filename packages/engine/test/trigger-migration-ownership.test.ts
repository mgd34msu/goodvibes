/** Actual trigger migration/execution lifetimes. Authored source; UNRUN. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TriggerManager, TriggerMigrationRequiredError, TriggerSnapshotStore, TriggerStoreOwnershipError,
  loadTriggerSnapshot, type TriggerManagerOptions, type TriggerRecord } from '../sdk/src/platform/triggers/index.ts';
const roots: string[] = [], managers: TriggerManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) { manager.shutdown(); await manager.join(); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const emptyActions = { async runAgentTurn() { return ''; }, async runGrant() { return ''; } };
const definition = { id: 'watch', label: 'Watch', createdAt: 0,
  spec: { kind: 'condition', probe: { kind: 'file', path: '/fixture' }, extract: { kind: 'raw' }, rule: { kind: 'change' } }, action: { kind: 'agent-turn' } } as const;
function fixture() { const root = mkdtempSync(join(tmpdir(), 'trigger-migration-')); roots.push(root); return { root, path: join(root, 'triggers-v2.json'), old: join(root, 'triggers.json') }; }
function manager(path: string, options: Partial<TriggerManagerOptions> = {}) { const value = new TriggerManager({ storePath: path, config: { enabled: true }, actions: emptyActions, now: () => 1000, ...options }); managers.push(value); return value; }
function record(state: 'idle' | 'cancelled' = 'idle'): TriggerRecord { return { definition, state, observations: [], runs: [], ruleState: {}, strikes: 0, backoffRung: 0, firedCount: 0, droppedLines: 0, updatedAt: 1000 }; }
function oldBytes(records: readonly TriggerRecord[] = []) {
  const body = { version: 1, daemonBootId: 'actual-old-boot', savedAt: 1000, triggers: records, grants: [], eventLog: [] };
  // Actual published v1 fixture representation; fresh runtime v2 never hashes.
  return `${JSON.stringify({ ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') })}\n`;
}
test('runnable v1 is read-only until explicit migration; no silent recovery or new command', async () => {
  const { path, old } = fixture(), bytes = oldBytes([record()]); writeFileSync(old, bytes);
  let declarations = 0;
  const owner = manager(path, { previousStorePath: old, nativeDataWriter: { declare(format) { expect(format).toBe('trigger-snapshots-v2'); declarations += 1; } } });
  expect(owner.start().triggersLoaded).toBe(1); expect(owner.executionOwnership).toBe('migration-required'); expect(owner.list()).toHaveLength(1);
  await expect(owner.create({ ...definition, id: 'second' })).rejects.toBeInstanceOf(TriggerMigrationRequiredError);
  expect(declarations).toBe(0); expect(readFileSync(old, 'utf8')).toBe(bytes);
  owner.migratePrevious({ olderInstancesClosed: true }); expect(owner.executionOwnership).toBe('local'); expect(declarations).toBeGreaterThan(0);
  expect(loadTriggerSnapshot(path).snapshot?.triggers).toHaveLength(1); expect(readFileSync(old, 'utf8')).toBe(bytes);
  const cutover = JSON.parse(readFileSync(`${path}.cutover.json`, 'utf8')) as Record<string, unknown>;
  expect(cutover['phase']).toBe('committed'); expect(cutover['migration']).toBe('operator-confirmed');
});
test('explicit migration cannot replace the original source selected by migration-required inspection', () => {
  const { path, old } = fixture(); writeFileSync(old, oldBytes([record()])); const owner = manager(path, { previousStorePath: old }); owner.start();
  const changed = oldBytes([{ ...record(), updatedAt: 2000 }]); writeFileSync(old, changed);
  expect(() => owner.migratePrevious({ olderInstancesClosed: true })).toThrow(); expect(readFileSync(old, 'utf8')).toBe(changed);
});
test('only terminal v1 history migrates automatically; original snapshot and report remain byte-for-byte', () => {
  const { path, old } = fixture(), bytes = oldBytes([record('cancelled')]), reportPath = join(roots.at(-1)!, 'triggers-reaped.json');
  writeFileSync(old, bytes); writeFileSync(reportPath, '[]\n');
  const owner = manager(path, { previousStorePath: old }); owner.start();
  expect(owner.executionOwnership).toBe('local'); expect(readFileSync(old, 'utf8')).toBe(bytes); expect(readFileSync(reportPath, 'utf8')).toBe('[]\n');
});
test('a changed original v1 source invalidates execution and the next boot instead of recapturing a new source', async () => {
  const { path, old } = fixture(); writeFileSync(old, oldBytes()); const owner = manager(path, { previousStorePath: old }); owner.start();
  const current = readFileSync(path, 'utf8'); writeFileSync(old, oldBytes([record()]));
  await expect(owner.create(definition)).rejects.toThrow(); expect(readFileSync(path, 'utf8')).toBe(current);
  owner.shutdown(); await owner.join();
  expect(() => manager(path, { previousStorePath: old }).start()).toThrow();
});
test('committed v2 loss never replays preserved runnable v1 effects', async () => {
  const { path, old } = fixture(); writeFileSync(old, oldBytes([record()])); const owner = manager(path, { previousStorePath: old }); owner.start(); owner.migratePrevious({ olderInstancesClosed: true });
  owner.shutdown(); await owner.join(); unlinkSync(path);
  expect(() => manager(path, { previousStorePath: old }).start()).toThrow(); expect(readFileSync(old, 'utf8')).toBe(oldBytes([record()]));
});
test('a prepared history-only cutover can finish after interruption, while future cutover records are preserved', () => {
  const { path, old } = fixture(); writeFileSync(old, oldBytes());
  const oldData = JSON.parse(oldBytes()) as { checksum: string; daemonBootId: string; savedAt: number };
  const previousSource = { version: 1, checksum: oldData.checksum, daemonBootId: oldData.daemonBootId, savedAt: oldData.savedAt };
  writeFileSync(`${path}.cutover.json`, JSON.stringify({ version: 1, phase: 'prepared', migration: 'terminal-history', previousSource }));
  const owner = manager(path, { previousStorePath: old }); owner.start(); expect(owner.executionOwnership).toBe('local');
  const other = fixture(), bytes = '{"version":99,"future":"keep"}'; writeFileSync(`${other.path}.cutover.json`, bytes);
  expect(() => manager(other.path).start()).toThrow(); expect(readFileSync(`${other.path}.cutover.json`, 'utf8')).toBe(bytes);
});
test('another terminal boots and inspects read-only without sweeping, rewriting or firing', async () => {
  const { path } = fixture(), first = manager(path); await first.create(definition); const bytes = readFileSync(path, 'utf8');
  const second = manager(path); expect(() => second.start()).not.toThrow(); expect(second.executionOwnership).toBe('other-process'); expect(second.list().map(value => value.definition.id)).toEqual(['watch']);
  await expect(second.create({ ...definition, id: 'second' })).rejects.toBeInstanceOf(TriggerStoreOwnershipError); expect(readFileSync(path, 'utf8')).toBe(bytes);
  await first.create({ ...definition, id: 'newly-published' }); expect(second.list()).toHaveLength(2);
});
test('the actual launch promise keeps execution ownership until its late returned native resource is cancelled and drained', async () => {
  const { path } = fixture(), launch = Promise.withResolvers<{ processId: string; pid: number; startedAt: number }>(), cancelled: string[] = [];
  let first!: TriggerManager;
  first = manager(path, { processHost: { launch() { first.shutdown(); return launch.promise; }, observe() { return null; }, cancel(id) { cancelled.push(id); }, isSameProcessAlive() { return false; } } });
  const creating = first.create({ ...definition, spec: { kind: 'on-exit', command: 'fixture-command' } });
  const second = manager(path); second.start(); expect(second.executionOwnership).toBe('other-process');
  launch.resolve({ processId: 'actual-original', pid: 22, startedAt: 1000 }); await expect(creating).rejects.toThrow(); await first.join(); expect(cancelled).toEqual(['actual-original']);
  const third = manager(path); third.start(); expect(third.executionOwnership).toBe('local');
});
test('a rejected installed reader floor precedes all external launches and leaves prior data intact', async () => {
  const { path } = fixture(); let launches = 0;
  const owner = manager(path, { nativeDataWriter: { declare() { throw Error('unsupported installed reader'); } }, processHost: { async launch() { launches += 1; return { processId: 'never', pid: 1, startedAt: 1 }; }, observe() { return null; }, cancel() {}, isSameProcessAlive() { return false; } } });
  await expect(owner.create({ ...definition, spec: { kind: 'on-exit', command: 'fixture-command' } })).rejects.toThrow('unsupported installed reader'); expect(launches).toBe(0);
});
test('post-launch persistence failure cancels exactly the returned resource and invokes no action', async () => {
  const { path } = fixture(); let fail = false, actions = 0; const cancelled: string[] = [];
  const owner = manager(path, { nativeDataWriter: { declare() { if (fail) throw Error('reader retired'); } },
    actions: { async runAgentTurn() { actions += 1; return ''; }, async runGrant() { actions += 1; return ''; } },
    processHost: { async launch() { const saved = loadTriggerSnapshot(path).snapshot; expect(saved?.triggers[0]?.definition.id).toBe('watch'); fail = true; return { processId: 'only-original', pid: 1, startedAt: 1 }; }, observe() { return null; }, cancel(id) { cancelled.push(id); }, isSameProcessAlive() { return false; } } });
  await expect(owner.create({ ...definition, spec: { kind: 'on-exit', command: 'fixture-command' } })).rejects.toThrow('reader retired'); expect(cancelled).toEqual(['only-original']); expect(actions).toBe(0);
});
test('synchronous stream output is held until the running record is durable; rejected publication never fires', async () => {
  const { path } = fixture(); let fail = false, actions = 0; const stopped: string[] = [];
  const owner = manager(path, { nativeDataWriter: { declare() { if (fail) throw Error('reader retired'); } },
    actions: { async runAgentTurn() { actions += 1; return ''; }, async runGrant() { actions += 1; return ''; } },
    streamHost: { async start(input) { input.onChunk('ERROR ready\n'); expect(actions).toBe(0); fail = true; return { streamId: 'only-original', pid: 2 }; }, stop(id) { stopped.push(id); } } });
  await expect(owner.create({ ...definition, spec: { kind: 'stream', command: 'fixture-command', match: { kind: 'regex', pattern: 'ERROR' }, batchLines: 1 } })).rejects.toThrow('reader retired'); expect(actions).toBe(0); expect(stopped).toEqual(['only-original']);
});
test('the actual on-exit executor observes a durable one-shot claim before doing work', async () => {
  const { path } = fixture(); let actions = 0, ended = false;
  const owner = manager(path, { actions: { async runAgentTurn() { const record = loadTriggerSnapshot(path).snapshot?.triggers[0]; expect(record?.state).toBe('fired'); expect(record?.runs.at(-1)?.detail).toContain('completion has not been observed'); actions += 1; return 'acknowledged'; }, async runGrant() { return ''; } },
    processHost: { async launch() { return { processId: 'only-original', pid: 1, startedAt: 1 }; }, observe() { return { running: !ended, exitCode: 0, signal: null, timedOut: false, stdoutTail: '', stderrTail: '' }; }, cancel() {}, isSameProcessAlive() { return true; } } });
  await owner.create({ ...definition, spec: { kind: 'on-exit', command: 'fixture-command' } }); ended = true; await owner.pollProcesses(); await owner.pollProcesses(); expect(actions).toBe(1);
});
test('standalone read-only inspection cannot quarantine corrupt data owned by another manager', async () => {
  const { path } = fixture(), owner = manager(path); await owner.create(definition); writeFileSync(path, 'corrupt-for-inspection');
  expect(() => new TriggerSnapshotStore(path).load(true)).toThrow(); expect(readFileSync(path, 'utf8')).toBe('corrupt-for-inspection');
});
