// Proves: A crash during a contract save loses or corrupts saved progress, or an older build (after a rollback) writes over progress saved by a newer one.
// Red when: A torn last record makes the checkpoint unreadable or quarantined or is chained onto by the next save, or a build that cannot read a newer record writes over it.
// Proves: After a restart a contract's saved progress is not what was saved, finished work is run and paid for again, or two writers write one contract.
// Red when: A restart reads back something other than the last save, compaction drops state or an input, an older single-file contract cannot be continued, a second process or a stale copy overwrites a save, or the runner reruns or recharges a passed unit.
/**
 * A contract's saved progress is intact after a restart, and completed work is
 * neither run again nor paid for again.
 *
 * The store: a restart at any save point reads back exactly what was saved
 * (finished units stay finished with their checks and answer, a running unit
 * keeps its agent, usage keeps what was spent); a version-6 single file loads,
 * resumes and is converted; a save cut at any byte reads as the save before it,
 * and a record from a newer build is never written over; and two writers never
 * both write one contract.
 *
 * The runner: after a restart, a unit whose check had passed is settled
 * without an agent, so its work is not repeated and nothing new is spent on it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractStoreVersionError, contractCheckpointsDir, contractPath, serializeContract } from '../platform/src/platform/contract/store.js';
import type { ContractView } from '../platform/src/platform/contract/types.js';
import { firstLine, paths, progressContract, progressStep, quarantined, restart, saved, storeAt } from './contract-progress-support.js';
import { makeHarness, makeRepo, startContract, twoUnitPlan, type AgentScript, type Harness } from './contract/runner-support.js';

const roots: string[] = [];
const harnesses: Harness[] = [];
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-contract-progress-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  try { await Promise.all(harnesses.splice(0).map(h => h.dispose())); }
  finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});

describe('restart at every save point', () => {
  test('finished units stay finished, running units keep their agent, and spent usage is kept', () => {
    const root = projectRoot(), first = progressContract(5, 2_000);
    let store = storeAt(root);
    store.put(first);
    expect(store.write(first.id)).toBe(true);
    store.dispose();

    let contract = first;
    for (let step = 1; step <= 12; step++) {
      // Each step runs in a process that has just restarted from the last save.
      store = storeAt(root);
      contract = store.load(first.id)!;
      store.hold(contract);
      progressStep(contract, step);
      expect(store.write(contract.id)).toBe(true);
      store.dispose();

      const after = restart(root, first.id);
      expect(saved(after)).toEqual(saved(contract));
      for (const unit of after.units) {
        const savedUnit = contract.units.find(candidate => candidate.id === unit.id)!;
        // A passed unit comes back passed with its checks and its answer; a running unit with the agent it had, not as work to start again.
        expect([unit.status, unit.activeAgentId, unit.answer]).toEqual([savedUnit.status, savedUnit.activeAgentId, savedUnit.answer]);
        expect(unit.checks.map(check => check.id)).toEqual(savedUnit.checks.map(check => check.id));
      }
      expect(after.usage.llmCallCount).toBe(step);
    }
    expect(contract.units.filter(unit => unit.status === 'passed').length).toBeGreaterThan(0);
    expect(contract.units.filter(unit => unit.status === 'running').length).toBeGreaterThan(0);
  });

  test('a captured input set after the start, and every save after many compactions, come back', () => {
    const root = projectRoot(), contract = progressContract(2, 0);
    contract.inputSnapshot = undefined;
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    contract.inputSnapshot = progressContract(1, 2_000).inputSnapshot;
    expect(store.write(contract.id)).toBe(true);
    // Enough changing output to pass the compaction threshold several times over.
    for (let step = 1; step <= 40; step++) {
      progressStep(contract, step);
      contract.units[0]!.lastOutput = `${step}`.repeat(60_000);
      expect(store.write(contract.id)).toBe(true);
    }
    store.dispose();
    expect(saved(restart(root, contract.id))).toEqual(saved(contract));
  });
});

test('a version-6 single-file checkpoint loads, resumes, and after conversion still reads back every save', () => {
  const root = projectRoot(), original = progressContract(3, 200);
  progressStep(original, 1);
  mkdirSync(contractCheckpointsDir(root), { recursive: true });
  writeFileSync(contractPath(root, original.id), serializeContract(original, 5)!);

  const store = storeAt(root);
  const contract = store.load(original.id)!;
  expect(saved(contract)).toEqual(saved(original));
  expect(store.listStoredIds()).toEqual([original.id]);
  store.hold(contract);
  progressStep(contract, 2);
  expect(store.write(contract.id)).toBe(true);
  progressStep(contract, 3);
  expect(store.write(contract.id)).toBe(true);
  store.dispose();
  expect(saved(restart(root, original.id))).toEqual(saved(contract));
  expect(storeAt(root).listStoredIds()).toEqual([original.id]);
});

describe('one writer per contract', () => {
  test('a second process is refused while the first writes, and a stale copy never overwrites the newer save', async () => {
    const root = projectRoot(), contract = progressContract(3, 20);
    const first = storeAt(root);
    first.put(contract);
    expect(first.write(contract.id)).toBe(true);
    first.dispose();

    // This process reads the contract, then another process takes it and saves.
    const local = storeAt(root), mine = local.load(contract.id)!;
    local.hold(mine);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'contract-progress-child.ts'), 'hold', root, contract.id], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    expect(await firstLine(child.stdout)).toBe('saved');
    const theirs = restart(root, contract.id);

    progressStep(mine, 1);
    mine.statusLine = 'written by the stale copy';
    expect(local.write(mine.id)).toBe(false);
    expect(saved(restart(root, contract.id))).toEqual(saved(theirs));

    await child.stdin.end();
    expect(await child.exited).toBe(0);
    // The other process is gone, but its save is newer than this copy: still not written over.
    expect(local.write(mine.id)).toBe(false);
    expect(saved(restart(root, contract.id))).toEqual(saved(theirs));
    local.dispose();

    // A process that reads the contract now continues it.
    const fresh = storeAt(root), current = fresh.load(contract.id)!;
    fresh.hold(current);
    progressStep(current, 2);
    expect(fresh.write(current.id)).toBe(true);
    fresh.dispose();
    expect(saved(restart(root, contract.id))).toEqual(saved(current));
  });
});

/** Resolves once `holds` is true, checked at each contract event the runner emits: waits on the run, never on a clock. */
function until(h: Harness, holds: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (holds()) { resolve(); return; }
    const check = (): void => { if (holds()) { off(); resolve(); } };
    // The event is emitted as the change is made; the store reads it a turn later.
    const off = h.runner.on(() => { check(); queueMicrotask(check); setImmediate(check); });
  });
}

const viewOf = (h: Harness, id: string): ContractView => {
  const contract = h.store.get(id);
  if (contract === null) throw new Error(`no contract ${id}`);
  return contract;
};
const unitOf = (h: Harness, id: string, unitId: string) => viewOf(h, id).units.find(unit => unit.id === unitId);
const ended = (h: Harness, id: string): boolean => ['passed', 'failed', 'cancelled'].includes(viewOf(h, id).status);

/** An agent that writes its file, reports the turn, and never finishes (the process stops under it). */
const writesThenHangs = (file: string): AgentScript => () => [
  { tool: true, files: { [file]: 'export const convert = () => 0;\n' }, text: `wrote ${file}` },
  { text: '', stop: { kind: 'hang' } },
];
const finishes = (file: string, text: string): AgentScript => () => [{ files: { [file]: `${text}\n` }, text }];
const mustNotRun: AgentScript = () => { throw new Error('the unit that already passed was given an agent again'); };

test('after a restart, a unit whose check had passed is not run again and what it spent is counted once', async () => {
  const root = makeRepo();
  roots.push(root);
  // u1 (group g1) finishes and passes; u2 (group g2, after g1) is working when the process stops.
  const first = makeHarness({ root, plan: twoUnitPlan(), scripts: { u1: finishes('src/csv.ts', 'Finished the parser.'), u2: writesThenHangs('src/convert.ts') } });
  const id = (await startContract(first)).contract.id;
  await until(first, () => unitOf(first, id, 'u1')?.status === 'passed' && unitOf(first, id, 'u2')?.status === 'running');
  const before = structuredClone(viewOf(first, id));
  await first.dispose();
  first.store.flush();
  expect(before.units[0]!.agentIds).toHaveLength(1);

  // The restarted process: u1 must not get an agent; u2 gets a fresh one and finishes.
  const second = makeHarness({ root, plan: twoUnitPlan(), scripts: { u1: mustNotRun, u2: finishes('src/convert.ts', 'Wired the parser into convert.') } });
  harnesses.push(second);
  const report = await second.runner.resumeAll();
  expect(report.resumed.map(entry => entry.contractId)).toEqual([id]);
  await until(second, () => ended(second, id));
  const done = viewOf(second, id);
  expect(done.status).toBe('passed');

  const u1 = done.units.find(unit => unit.id === 'u1')!, u2 = done.units.find(unit => unit.id === 'u2')!;
  expect(second.agentsOf('u1')).toEqual([]);
  expect(second.events.filter(event => event.type === 'CONTRACT_UNIT_SPAWNED').map(event => event.type === 'CONTRACT_UNIT_SPAWNED' ? event.unitId : '')).toEqual(['u2']);
  expect(u1.agentIds).toEqual(before.units[0]!.agentIds);
  expect(u1.checks.map(check => check.id)).toEqual(before.units[0]!.checks.map(check => check.id));
  // Spent before the restart is kept and not counted again: u1 costs what it cost, u2 adds only its fresh agent's run.
  expect(u1.usage).toEqual(before.units[0]!.usage);
  expect(u2.agentIds).toHaveLength(before.units[1]!.agentIds.length + 1);
  expect(done.usage.llmCallCount).toBe(before.usage.llmCallCount + 1);
});

describe('a process killed during a save', () => {
  test('a save cut at any byte reads as the save before it, is never quarantined, and the next save does not merge with it', () => {
    const root = projectRoot(), contract = progressContract(3, 50);
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    progressStep(contract, 1);
    expect(store.write(contract.id)).toBe(true);
    const before = saved(contract);
    const { dir, log } = paths(root, contract.id);
    const prefix = readFileSync(log);
    progressStep(contract, 2);
    expect(store.write(contract.id)).toBe(true);
    const after = saved(contract);
    store.dispose();
    const record = readFileSync(log).subarray(prefix.length);

    for (let cut = 0; cut <= record.length; cut++) {
      writeFileSync(log, Buffer.concat([prefix, record.subarray(0, cut)]));
      expect(saved(restart(root, contract.id))).toEqual(cut === record.length ? after : before);
    }
    // Power lost after the size grew but before the data landed: zeros, not a record.
    writeFileSync(log, Buffer.concat([prefix, Buffer.alloc(64)]));
    expect(saved(restart(root, contract.id))).toEqual(before);

    // Half a record on disk; the next process saves again: its record stands alone.
    writeFileSync(log, Buffer.concat([prefix, record.subarray(0, record.length >> 1)]));
    const next = storeAt(root), resumed = next.load(contract.id)!;
    next.hold(resumed);
    progressStep(resumed, 2);
    progressStep(resumed, 3);
    expect(next.write(resumed.id)).toBe(true);
    next.dispose();
    expect(saved(restart(root, contract.id))).toEqual(saved(resumed));
    expect(quarantined(dir)).toEqual([]);
  });

  test('a progress record written by a newer build is refused and never written over', () => {
    const root = projectRoot(), contract = progressContract(2, 20);
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    store.dispose();
    const { log } = paths(root, contract.id);
    const newer = '{"v":2,"s":99,"at":1,"ops":[]}\n';
    writeFileSync(log, newer);
    expect(() => storeAt(root).load(contract.id)).toThrow(ContractStoreVersionError);
    const writer = storeAt(root);
    writer.hold(contract);
    progressStep(contract, 1);
    expect(writer.write(contract.id)).toBe(false);
    writer.dispose();
    expect(readFileSync(log, 'utf8')).toBe(newer);
  });
});
