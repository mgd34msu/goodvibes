import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.js';
import { CheckpointDiffObservations } from '../platform/src/platform/workspace/checkpoint/diff-observations.js';
import { CHECKPOINT_DIFF_REVISION_PATTERN, CHECKPOINT_DIFF_SOURCE_MAX_BYTES } from '../platform/src/platform/workspace/checkpoint/diff-observation-contract.js';
import type { CheckpointDiff } from '../platform/src/platform/workspace/checkpoint/types.js';

test('actual checkpoint reads keep exact view ownership across refresh and refuse another manager or restored changed view', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-diff-owner-'));
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
  const replacement = new WorkspaceCheckpointManager({ workspaceRoot: root });
  try {
    const path = join(root, 'source.txt');
    writeFileSync(path, 'original\n');
    const baseline = await manager.create({ kind: 'manual' });
    if (!baseline) throw new Error('Missing baseline');
    writeFileSync(path, 'selected\n');
    const selected = await manager.diff(baseline.id);
    expect(selected.nativeRevision).toMatch(new RegExp(CHECKPOINT_DIFF_REVISION_PATTERN));
    expect((await manager.diff(baseline.id)).nativeRevision).toBe(selected.nativeRevision);
    // A direct platform caller cannot mutate the retained evidence through the response.
    selected.files.push('fabricated.txt');
    expect((await manager.diff(baseline.id)).nativeRevision).toBe(selected.nativeRevision);
    const foreign = await replacement.diff(baseline.id);
    expect(foreign.unifiedDiff).toBe(selected.unifiedDiff);
    expect(foreign.nativeRevision).not.toBe(selected.nativeRevision);
    writeFileSync(path, 'different\n');
    expect((await manager.diff(baseline.id)).nativeRevision).not.toBe(selected.nativeRevision);
    writeFileSync(path, 'selected\n');
    const restored = await manager.diff(baseline.id);
    expect(restored.unifiedDiff).toBe(selected.unifiedDiff);
    expect(restored.nativeRevision).not.toBe(selected.nativeRevision);
    manager.dispose();
    expect((await manager.diff(baseline.id)).nativeRevision).not.toBe(restored.nativeRevision);
  } finally { await manager.drain(); await replacement.drain(); rmSync(root, { recursive: true, force: true }); }
});

test('session endpoint provenance changes its read even when a later checkpoint restores exactly the same diff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-session-owner-'));
  let tick = 1000;
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, now: () => ++tick });
  try {
    const path = join(root, 'source.txt');
    writeFileSync(path, 'original\n'); await manager.create({ kind: 'manual' });
    writeFileSync(path, 'selected\n'); await manager.create({ kind: 'turn', sessionId: 'selected-session' });
    const selected = await manager.sessionChanges('selected-session');
    expect(selected.nativeRevision).toStartWith('checkpoint-diff:');
    expect((await manager.sessionChanges('selected-session')).nativeRevision).toBe(selected.nativeRevision);
    writeFileSync(path, 'different\n'); await manager.create({ kind: 'turn', sessionId: 'selected-session' });
    writeFileSync(path, 'selected\n'); await manager.create({ kind: 'turn', sessionId: 'selected-session' });
    const restored = await manager.sessionChanges('selected-session');
    expect(restored.unifiedDiff).toBe(selected.unifiedDiff);
    expect(restored.checkpointCount).toBeGreaterThan(selected.checkpointCount);
    expect(restored.nativeRevision).not.toBe(selected.nativeRevision);
    expect((await manager.diff(restored.from, restored.to)).nativeRevision).not.toBe(restored.nativeRevision);
  } finally { await manager.drain(); rmSync(root, { recursive: true, force: true }); }
});

test('failed, evicted and explicitly retired diff reads never resurrect a previous label', async () => {
  const owner = new CheckpointDiffObservations();
  const view = (): Promise<CheckpointDiff> => Promise.resolve({ from: 'base', to: 'WORKING', files: ['source.txt'], unifiedDiff: 'selected', stat: '' });
  const first = await owner.read(['checkpoint', 'base', 'WORKING'], view);
  await expect(owner.read(['checkpoint', 'base', 'WORKING'], () => Promise.reject(new Error('read unavailable')))).rejects.toThrow('read unavailable');
  const recovered = await owner.read(['checkpoint', 'base', 'WORKING'], view);
  expect(recovered.nativeRevision).not.toBe(first.nativeRevision);
  for (let index = 0; index < 40; index++) await owner.read(['session', `session-${index}`], view);
  const refreshed = await owner.read(['checkpoint', 'base', 'WORKING'], view);
  expect(refreshed.nativeRevision).not.toBe(recovered.nativeRevision);
  owner.clear();
  expect((await owner.read(['checkpoint', 'base', 'WORKING'], view)).nativeRevision).not.toBe(refreshed.nativeRevision);
});

test('oversized full diffs remain displayable without retaining or minting a selected-context revision', async () => {
  const owner = new CheckpointDiffObservations();
  const scope = ['session', 'large-session'];
  const small: CheckpointDiff = { from: 'base', to: 'latest', files: [], stat: '', unifiedDiff: 'small' };
  const before = await owner.read(scope, () => Promise.resolve(small));
  const large = { ...small, unifiedDiff: 'x'.repeat(CHECKPOINT_DIFF_SOURCE_MAX_BYTES + 1) };
  const observed = await owner.read(scope, () => Promise.resolve(large));
  expect(observed.unifiedDiff).toBe(large.unifiedDiff);
  expect(observed.nativeRevision).toBeUndefined();
  expect((await owner.read(scope, () => Promise.resolve(small))).nativeRevision).not.toBe(before.nativeRevision);
});
