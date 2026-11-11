import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentFileObservations, currentFileObservationsAsync, currentFileMatchesText } from '../../platform/src/platform/contract/current-file-observations.js';
import { reviewInventoryObservation, reviewInventoryObservationAsync } from '../../platform/src/platform/contract/review-inventory.js';
import { reviewedFileFromObservation } from '../../platform/src/platform/contract/review-file-observations.js';
import { collectUnitEvidence } from '../../platform/src/platform/contract/evidence.js';
import type { ContractConfigReader } from '../../platform/src/platform/contract/config.js';
import { RuntimeEventBus } from '../../platform/src/platform/runtime/events/index.js';
import { makeContract, makeUnit } from './fixtures.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cooperative-review-'));
  const paths = Array.from({ length: 64 }, (_, index) => `file-${index}.txt`);
  for (const path of paths) writeFileSync(join(root, path), path);
  return { root, paths };
}

test('large native review reads let input run between files and preserve every original observation', async () => {
  const { root, paths } = fixture();
  let running = true, ticks = 0;
  const heartbeat = () => { ticks++; if (running) setImmediate(heartbeat); };
  setImmediate(heartbeat);
  try {
    const owner = {};
    const observations = await currentFileObservationsAsync(root, [...paths, paths[0]!], { owner, includeText: true });
    expect(ticks).toBeGreaterThan(1);
    expect(observations).toHaveLength(paths.length);
    for (let index = 0; index < paths.length; index++) {
      expect(currentFileMatchesText(observations[index], paths[index]!)).toBe(true);
      expect(observations[index]).toEqual(currentFileObservations(root, [paths[index]!], { owner, includeText: true })[0]);
    }
    const contract = makeContract({ projectRoot: root, reviewInventory: { paths, source: 'filesystem', errors: [] } });
    const before = ticks;
    expect(await reviewInventoryObservationAsync(contract, observations)).toEqual(reviewInventoryObservation(contract, observations));
    expect(ticks - before).toBeGreaterThan(1);
  } finally { running = false; rmSync(root, { recursive: true, force: true }); }
});

test('cancellation interrupts the scan before the next file, without dropping authority checks', async () => {
  const { root, paths } = fixture();
  try {
    const abort = new AbortController();
    setImmediate(() => abort.abort());
    await expect(currentFileObservationsAsync(root, paths, {}, abort.signal)).rejects.toThrow();
    const observations = currentFileObservations(root, paths);
    const contract = makeContract({ projectRoot: root, reviewInventory: { paths, source: 'filesystem', errors: [] } });
    await expect(reviewInventoryObservationAsync(contract, observations, abort.signal)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file replaced while a cooperative scan yields cannot retain its earlier reviewed status', async () => {
  const { root, paths } = fixture();
  try {
    const old = currentFileObservations(root, [paths[0]!])[0]!;
    const descriptor = reviewedFileFromObservation(old)!;
    const contract = makeContract({ projectRoot: root, reviewInventory: { paths, source: 'filesystem', errors: [] }, units: [makeUnit({
      role: 'research', status: 'passed', checks: [{ id: 'u1.k1', at: 1, trigger: 'completion', result: 'pass', quality: {}, decisionIds: ['native-check'],
        goal: { verdict: 'met', probabilityUnmet: 0.1, outcome: 'act' }, reviewedFiles: [descriptor] }],
    })] });
    setImmediate(() => writeFileSync(join(root, paths[0]!), 'Changed during the scan'));
    const observations = await currentFileObservationsAsync(root, paths);
    const review = await reviewInventoryObservationAsync(contract, observations);
    expect(review?.files[0]?.assessment).toBe('changed');
    expect(review?.reviewedFiles).toBe(0);
    expect(currentFileMatchesText(old, paths[0]!)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unit evidence uses cooperative scanning for every inspected file in the assigned review inventory', async () => {
  const { root, paths } = fixture();
  let running = true, ticks = 0;
  const heartbeat = () => { ticks++; if (running) setImmediate(heartbeat); };
  setImmediate(heartbeat);
  try {
    const unit = makeUnit({ files: ['.'], role: 'research', readEvidence: paths.map(path => ({
      path: join(root, path), returnedRanges: ['1'], returnedLines: 1,
    })) });
    const contract = makeContract({ projectRoot: root, units: [unit], reviewInventory: { paths, source: 'filesystem', errors: [] } });
    contract.decisions.push({ id: 'plan', at: 1, action: 'plan-accepted', targetId: contract.id, reason: 'Assigned review', decisionIds: ['native-plan'] });
    const evidence = await collectUnitEvidence(contract, unit, 'turn-end', { cwd: root, output: '', report: null, mustWrite: false, turns: [],
      configManager: { get: () => undefined, getCategory: () => undefined } as unknown as ContractConfigReader, runtimeBus: new RuntimeEventBus() });
    expect(ticks).toBeGreaterThan(1);
    const orchestration = evidence.orchestration as { currentFiles: { path: string }[]; reviewInventory: { totalFiles: number } };
    expect(orchestration.currentFiles.map(file => file.path)).toEqual(paths);
    expect(orchestration.reviewInventory.totalFiles).toBe(paths.length);
  } finally { running = false; rmSync(root, { recursive: true, force: true }); }
});
