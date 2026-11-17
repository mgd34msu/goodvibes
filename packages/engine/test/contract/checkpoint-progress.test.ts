/**
 * Contract checkpoints lose no saved work: a restart at any save point reads
 * back exactly what was saved; a version-6 single file loads, resumes and is
 * converted once; a process killed during a save or a conversion leaves a
 * contract that loads as it was before or after that save; and two processes
 * never both write one contract.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContractStore, ContractStoreVersionError, contractCheckpointDir, contractCheckpointsDir, contractPath, serializeContract, storedCheckpointText,
} from '../../platform/src/platform/contract/store.js';
import type { Contract } from '../../platform/src/platform/contract/types.js';
import { passingCheck, progressContract, progressStep } from './checkpoint-progress-support.js';

const roots: string[] = [];
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-contract-progress-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function storeAt(root: string): ContractStore {
  return new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
}

/** A contract as a checkpoint holds it, to compare what was saved with what a restart reads. */
function saved(contract: Contract): unknown {
  return (JSON.parse(serializeContract(contract, 0)!) as { contract: unknown }).contract;
}

/** What a restarted process reads: a new store's load. */
function restart(root: string, id: string): Contract {
  const contract = storeAt(root).load(id);
  if (contract === null) throw new Error('the contract did not load');
  return contract;
}

function paths(root: string, id: string) {
  const dir = contractCheckpointDir(root, id);
  return { dir, base: join(dir, 'base.json'), log: join(dir, 'progress.log') };
}

function quarantined(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(name => name.includes('.corrupt-')) : [];
}

describe('restart at every save point', () => {
  test('finished units stay finished, running units stay as saved, and a save writes only what changed', () => {
    const root = projectRoot(), first = progressContract(5, 5_000);
    let store = storeAt(root);
    store.put(first);
    expect(store.write(first.id)).toBe(true);
    const { base, log } = paths(root, first.id);
    const baseBefore = statSync(base);
    store.dispose();

    let contract = first;
    for (let step = 1; step <= 12; step++) {
      // Each step runs in a process that has just restarted from the last save.
      store = storeAt(root);
      contract = store.load(first.id)!;
      store.hold(contract);
      const logBefore = existsSync(log) ? statSync(log).size : 0;
      progressStep(contract, step);
      expect(store.write(contract.id)).toBe(true);
      // The captured input (about 750 KB) is not written again: a save is a few hundred bytes.
      expect(statSync(log).size - logBefore).toBeLessThan(2_048);
      store.dispose();

      const after = restart(root, first.id);
      expect(saved(after)).toEqual(saved(contract));
      for (const unit of after.units) {
        const savedUnit = contract.units.find(candidate => candidate.id === unit.id)!;
        // No finished work lost: a passed unit comes back passed, with its checks and its answer.
        // No unit run twice: a running unit comes back with the agent it had, not as pending work to start again.
        expect([unit.status, unit.activeAgentId, unit.answer]).toEqual([savedUnit.status, savedUnit.activeAgentId, savedUnit.answer]);
        expect(unit.checks.map(check => check.id)).toEqual(savedUnit.checks.map(check => check.id));
      }
    }
    expect(contract.units.filter(unit => unit.status === 'passed').length).toBeGreaterThan(0);
    expect(contract.units.filter(unit => unit.status === 'running').length).toBeGreaterThan(0);
    // The base, which holds the captured input, was written once.
    const baseAfter = statSync(base);
    expect([baseAfter.ino, baseAfter.size, baseAfter.mtimeMs]).toEqual([baseBefore.ino, baseBefore.size, baseBefore.mtimeMs]);
  });

  test('a unit added, a decision replaced and a field removed between saves all come back', () => {
    const root = projectRoot(), contract = progressContract(2, 10);
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    progressStep(contract, 1);
    contract.units.push({ ...contract.units[0]!, id: 'u3', status: 'pending', agentIds: [], checks: [], touchedPaths: [], activeAgentId: undefined });
    contract.groups[0]!.unitIds.push('u3');
    contract.decisions[0] = { ...contract.decisions[0]!, reason: 'replaced' };
    contract.statusLine = undefined;
    contract.units[1]!.checks.push(passingCheck('u2.k1', 9));
    expect(store.write(contract.id)).toBe(true);
    contract.units.pop();
    contract.groups[0]!.unitIds.pop();
    expect(store.write(contract.id)).toBe(true);
    store.dispose();
    expect(saved(restart(root, contract.id))).toEqual(saved(contract));
  });

  test('a captured input set after the start is written once, and a compaction keeps it without copying it', () => {
    const root = projectRoot(), contract = progressContract(2, 0);
    contract.inputSnapshot = undefined;
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    contract.inputSnapshot = progressContract(1, 5_000).inputSnapshot;
    expect(store.write(contract.id)).toBe(true);
    const { dir, log } = paths(root, contract.id);
    const [input] = readdirSync(dir).filter(name => name.startsWith('inputSnapshot.'));
    const written = statSync(join(dir, input!));
    // Enough changing output to pass the compaction threshold several times over.
    for (let step = 1; step <= 40; step++) {
      progressStep(contract, step);
      contract.units[0]!.lastOutput = `${step}`.repeat(60_000);
      expect(store.write(contract.id)).toBe(true);
      if (step % 10 === 0) {
        store.dispose();
        expect(saved(restart(root, contract.id))).toEqual(saved(contract));
      }
    }
    store.dispose();
    const kept = statSync(join(dir, input!));
    expect([kept.ino, kept.mtimeMs]).toEqual([written.ino, written.mtimeMs]);
    expect(readdirSync(dir).filter(name => name.startsWith('inputSnapshot.'))).toEqual([input!]);
    // Without compaction the log would hold all 2.4 MB of output written.
    expect(statSync(log).size).toBeLessThan(1.5 * 1024 * 1024);
    expect(readFileSync(log, 'utf8')).not.toContain('src/module-4999/file-4999.ts');
    expect(saved(restart(root, contract.id))).toEqual(saved(contract));
  });
});

describe('a version-6 single-file checkpoint', () => {
  test('loads, resumes and is moved into its directory once, byte for byte, leaving nothing behind', () => {
    const root = projectRoot(), original = progressContract(3, 200);
    progressStep(original, 1);
    const text = serializeContract(original, 5)!;
    mkdirSync(contractCheckpointsDir(root), { recursive: true });
    writeFileSync(contractPath(root, original.id), text);

    const store = storeAt(root);
    const contract = store.load(original.id)!;
    expect(saved(contract)).toEqual(saved(original));
    expect(store.listStoredIds()).toEqual([original.id]);
    store.hold(contract);
    progressStep(contract, 2);
    expect(store.write(contract.id)).toBe(true);

    const { base } = paths(root, original.id);
    expect(readdirSync(contractCheckpointsDir(root))).toEqual([]);
    expect(readFileSync(base, 'utf8')).toBe(text);
    const moved = statSync(base);
    progressStep(contract, 3);
    expect(store.write(contract.id)).toBe(true);
    store.dispose();
    const again = statSync(base);
    expect([again.ino, again.size, again.mtimeMs]).toEqual([moved.ino, moved.size, moved.mtimeMs]);
    expect(saved(restart(root, original.id))).toEqual(saved(contract));
    expect(storeAt(root).listStoredIds()).toEqual([original.id]);
  });
});

describe('a process killed during a save or a conversion', () => {
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
    const whole = readFileSync(log), record = whole.subarray(prefix.length);

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

  test('a process killed while saving in a loop leaves the state of one of its saves, never earlier than the last it reported', async () => {
    const root = projectRoot(), start = progressContract(4, 2_000);
    const store = storeAt(root);
    store.put(start);
    expect(store.write(start.id)).toBe(true);
    store.dispose();
    const initial = serializeContract(start, 0)!;

    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'checkpoint-progress-child.ts'), 'loop', root, start.id], { stdout: 'pipe', stderr: 'pipe' });
    let reported = 0, pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk);
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) reported = Number(line.slice('saved '.length));
      if (reported >= 40) break;
    }
    child.kill('SIGKILL');
    await child.exited;
    expect(reported).toBeGreaterThanOrEqual(40);

    const loaded = restart(root, start.id);
    const step = loaded.usage.llmCallCount;
    expect(step).toBeGreaterThanOrEqual(reported);
    const expected = JSON.parse(initial) as { contract: Contract };
    for (let n = 1; n <= step; n++) progressStep(expected.contract, n);
    expect(saved(loaded)).toEqual(saved(expected.contract));
    expect(quarantined(paths(root, start.id).dir)).toEqual([]);

    // The next process carries on from there.
    const next = storeAt(root), resumed = next.load(start.id)!;
    next.hold(resumed);
    progressStep(resumed, step + 1);
    expect(next.write(resumed.id)).toBe(true);
    next.dispose();
    expect(saved(restart(root, start.id))).toEqual(saved(resumed));
  });

  test('a conversion cut after its directory was made reads the single file, and converts on the next save', () => {
    const root = projectRoot(), contract = progressContract(2, 20);
    mkdirSync(contractCheckpointsDir(root), { recursive: true });
    writeFileSync(contractPath(root, contract.id), serializeContract(contract, 5)!);
    mkdirSync(paths(root, contract.id).dir, { recursive: true });
    const store = storeAt(root), loaded = store.load(contract.id)!;
    expect(saved(loaded)).toEqual(saved(contract));
    store.hold(loaded);
    progressStep(loaded, 1);
    expect(store.write(loaded.id)).toBe(true);
    store.dispose();
    expect(existsSync(contractPath(root, contract.id))).toBe(false);
    expect(saved(restart(root, contract.id))).toEqual(saved(loaded));
  });

  test('a compaction cut before its rename leaves the old log in force, and its temp file is cleared by the next writer', () => {
    const root = projectRoot(), contract = progressContract(2, 20);
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    progressStep(contract, 1);
    expect(store.write(contract.id)).toBe(true);
    store.dispose();
    const { dir, log } = paths(root, contract.id);
    const temp = `${log}.tmp-999999-1-deadbeef`;
    writeFileSync(temp, '{"v":1,"s":6,"at":1,"snap":{"contract":{}},"base":[],"files":{}}\n');
    expect(saved(restart(root, contract.id))).toEqual(saved(contract));
    const next = storeAt(root), resumed = next.load(contract.id)!;
    next.hold(resumed);
    progressStep(resumed, 2);
    expect(next.write(resumed.id)).toBe(true);
    next.dispose();
    expect(existsSync(temp)).toBe(false);
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
    expect(writer.writeFailure(contract.id)?.newerFormat).toBe(true);
    writer.dispose();
    expect(readFileSync(log, 'utf8')).toBe(newer);
  });
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
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'checkpoint-progress-child.ts'), 'hold', root, contract.id], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const decoder = new TextDecoder();
    let output = '';
    for await (const chunk of child.stdout) { output += decoder.decode(chunk); if (output.includes('saved\n')) break; }
    const theirs = restart(root, contract.id);

    progressStep(mine, 1);
    mine.statusLine = 'written by the stale copy';
    expect(local.write(mine.id)).toBe(false);
    expect(local.writeFailure(mine.id)).not.toBeNull();
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

  test('two stores in one process do not both write one contract', () => {
    const root = projectRoot(), contract = progressContract(2, 20);
    const a = storeAt(root), b = storeAt(root);
    a.put(contract);
    expect(a.write(contract.id)).toBe(true);
    const copy = b.load(contract.id)!;
    b.hold(copy);
    progressStep(copy, 1);
    expect(b.write(copy.id)).toBe(false);
    progressStep(contract, 1);
    contract.statusLine = 'the writer';
    expect(a.write(contract.id)).toBe(true);
    a.dispose(); b.dispose();
    expect(saved(restart(root, contract.id))).toEqual(saved(contract));
    expect(storedCheckpointText(root, contract.id)).toContain('the writer');
  });
});
