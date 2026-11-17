/**
 * A process killed during a contract's save, a compaction or a conversion
 * leaves the contract as it was before or after that save, never less, and a
 * progress record from a newer build is never written over. The restart and
 * single-writer proofs are in contract-progress-restart.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractStoreVersionError, contractCheckpointsDir, contractPath, serializeContract } from '../platform/src/platform/contract/store.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { paths, progressContract, progressStep, quarantined, restart, saved, storeAt } from './contract-progress-support.js';

const roots: string[] = [];
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-contract-progress-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('a process killed during a save, a compaction or a conversion', () => {
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

  test('a process killed while saving in a loop leaves the state of one of its saves, never earlier than the last it reported', async () => {
    const root = projectRoot(), start = progressContract(4, 2_000);
    const store = storeAt(root);
    store.put(start);
    expect(store.write(start.id)).toBe(true);
    store.dispose();
    const initial = serializeContract(start, 0)!;

    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'contract-progress-child.ts'), 'loop', root, start.id], { stdout: 'pipe', stderr: 'pipe' });
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
    expect(saved(restart(root, contract.id))).toEqual(saved(loaded));
  });

  test('a compaction cut before its rename leaves the old log in force', () => {
    const root = projectRoot(), contract = progressContract(2, 20);
    const store = storeAt(root);
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);
    progressStep(contract, 1);
    expect(store.write(contract.id)).toBe(true);
    store.dispose();
    const { dir, log } = paths(root, contract.id);
    writeFileSync(`${log}.tmp-999999-1-deadbeef`, '{"v":1,"s":6,"at":1,"snap":{"contract":{}},"base":[],"files":{}}\n');
    expect(saved(restart(root, contract.id))).toEqual(saved(contract));
    const next = storeAt(root), resumed = next.load(contract.id)!;
    next.hold(resumed);
    progressStep(resumed, 2);
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
