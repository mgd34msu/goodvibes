/**
 * Dirty-residue guard: a scoped commit must never
 * sweep in uncommitted changes left behind by a previously killed run
 * sharing the same projectRoot. Covers both the pure partition logic
 * (dirty-guard.ts, against a real scratch git repo) and the actual
 * phase-runner wiring (runPhase -> commitPhaseWork).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  excludeUntouchedLaunchResidue,
  snapshotDirtyTree,
} from '../platform/src/platform/orchestration/dirty-guard.js';
import { runPhase } from '../platform/src/platform/orchestration/phase-runner.js';
import { createCancellationRegistry } from '../platform/src/platform/orchestration/cancellation.js';
import { emptyWorkItemUsage, type Phase, type WorkItem, type Workstream } from '../platform/src/platform/orchestration/types.js';
import { AgentWorktree } from '../platform/src/platform/agents/worktree.js';
import {
  createOrchestrationHarness,
  engineerReportOutput,
  makeFakeConfigManager,
} from './_helpers/orchestration-harness.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
  return Buffer.from(result.stdout).toString('utf8');
}

// Every root made here is removed after the test, pass or fail.
const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** A repo whose commits never depend on the host's git identity. */
function initRepo(cwd: string): void {
  runGit(cwd, ['init']);
  runGit(cwd, ['config', 'user.name', 'test']);
  runGit(cwd, ['config', 'user.email', 'test@example.invalid']);
  runGit(cwd, ['config', 'commit.gpgsign', 'false']);
}

function commitCount(cwd: string): number {
  const result = Bun.spawnSync(['git', 'rev-list', '--count', 'HEAD'], { cwd });
  if (result.exitCode !== 0) return 0;
  return parseInt(Buffer.from(result.stdout).toString('utf8').trim() || '0', 10);
}

// ---------------------------------------------------------------------------
// dirty-guard.ts, pure partition logic
// ---------------------------------------------------------------------------

describe('dirty-guard: snapshotDirtyTree', () => {
  test('captures dirty tracked + untracked paths as git object ids, excluding .goodvibes', async () => {
    const root = tempRoot('dirty-guard-snapshot-');
    initRepo(root);
    writeFileSync(join(root, 'tracked.ts'), 'export const a = 1;\n');
    runGit(root, ['add', 'tracked.ts']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    writeFileSync(join(root, 'tracked.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'untracked.ts'), 'export const b = 1;\n');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'state.json'), '{}\n');

    const snapshot = snapshotDirtyTree(root);
    const launch = await snapshot.ready;

    expect(launch.ids.has('tracked.ts')).toBe(true);
    expect(launch.ids.has('untracked.ts')).toBe(true);
    expect([...launch.ids.keys()].some((path) => path.startsWith('.goodvibes'))).toBe(false);
    expect(launch.ids.get('tracked.ts')).toMatch(/^file:[a-f0-9]{40}/);
  });

  test('retains an unavailable snapshot without authorizing a later commit outside Git', async () => {
    const root = tempRoot('dirty-guard-nogit-');
    const snapshot = snapshotDirtyTree(root);
    const launch = await snapshot.ready;
    expect(launch.ids.size).toBe(0);
    expect(launch.available).toBe(false);
    await expect(excludeUntouchedLaunchResidue(root, ['owner-file'], snapshot)).rejects.toThrow('could not be listed');
  });

  test('keys non-ASCII paths by their RAW name (via `-z`), not git\'s C-quoted form, so native reads select the real file', async () => {
    const root = tempRoot('dirty-guard-unicode-');
    initRepo(root);
    // Both names are C-quoted by git's default porcelain (core.quotePath=true):
    // café.txt -> "caf\303\251.txt". Under the old newline parser the snapshot
    // keyed on the quoted string, so residue with such a name silently bypassed
    // exclusion and its content-hash read (of the quoted name) returned null.
    writeFileSync(join(root, 'café.txt'), 'accented\n');
    writeFileSync(join(root, '普通话.txt'), 'cjk\n');

    const snapshot = snapshotDirtyTree(root);
    const launch = await snapshot.ready;

    // Raw paths are the keys, never the quoted "caf\303\251.txt" form.
    expect(launch.ids.has('café.txt')).toBe(true);
    expect(launch.ids.has('普通话.txt')).toBe(true);
    expect([...launch.ids.keys()].some((key) => key.includes('\\') || key.startsWith('"'))).toBe(false);
    // Each path is named by its git object id; no file bytes are kept.
    expect(launch.ids.get('café.txt')).toMatch(/^file:[a-f0-9]{40}/);
    expect(launch.ids.get('普通话.txt')).toMatch(/^file:[a-f0-9]{40}/);

    // End to end: untouched non-ASCII residue is excluded from a scoped commit
    // (the whole point of the guard) instead of leaking through on a key mismatch.
    const { included, excluded } = await excludeUntouchedLaunchResidue(root, ['café.txt', '普通话.txt'], snapshot);
    expect([...excluded].sort()).toEqual(['café.txt', '普通话.txt'].sort());
    expect(included).toEqual([]);
  });

  test('`-z` rename record: keeps the destination and consumes the non-ASCII origin field', async () => {
    const root = tempRoot('dirty-guard-rename-');
    initRepo(root);
    writeFileSync(join(root, 'café.txt'), 'x\n');
    runGit(root, ['add', 'café.txt']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    // Staged rename → `git status --porcelain -z` emits `R  renamed.txt\0café.txt\0`.
    runGit(root, ['mv', 'café.txt', 'renamed.txt']);

    const snapshot = snapshotDirtyTree(root);
    const launch = await snapshot.ready;

    // The destination is captured; the following NUL-separated origin field is
    // consumed, never mis-parsed as its own standalone dirty path.
    expect(launch.ids.has('renamed.txt')).toBe(true);
    expect(launch.ids.has('café.txt')).toBe(false);
    expect(launch.ids.get('renamed.txt')).toMatch(/^file:[a-f0-9]{40}/);
  });
});

describe('dirty-guard: excludeUntouchedLaunchResidue', () => {
  test('a path dirty at launch and never modified afterward is excluded; a genuinely new path is included', async () => {
    const root = tempRoot('dirty-guard-exclude-');
    initRepo(root);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    const launchSnapshot = snapshotDirtyTree(root);
    await launchSnapshot.ready;
    expect((await launchSnapshot.ready).ids.has('residue.ts')).toBe(true);

    // This run creates a brand-new file; residue.ts is left byte-for-byte untouched.
    writeFileSync(join(root, 'feature.ts'), 'export const feature = 1;\n');

    const { included, excluded } = await excludeUntouchedLaunchResidue(root, ['residue.ts', 'feature.ts'], launchSnapshot);
    expect(excluded).toEqual(['residue.ts']);
    expect(included).toEqual(['feature.ts']);
  });

  test('a path dirty at launch that this run actually modifies is included', async () => {
    const root = tempRoot('dirty-guard-modified-');
    initRepo(root);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    const launchSnapshot = snapshotDirtyTree(root);
    await launchSnapshot.ready;

    writeFileSync(join(root, 'residue.ts'), 'export const residue = 2;\n');

    const { included, excluded } = await excludeUntouchedLaunchResidue(root, ['residue.ts'], launchSnapshot);
    expect(included).toEqual(['residue.ts']);
    expect(excluded).toEqual([]);
  });

  test('a path absent from the launch snapshot is always included, even if it later becomes dirty', async () => {
    const root = tempRoot('dirty-guard-fresh-');
    initRepo(root);
    const launchSnapshot = snapshotDirtyTree(root); // nothing dirty yet
    await launchSnapshot.ready;

    writeFileSync(join(root, 'new.ts'), 'export const isNew = true;\n');

    const { included, excluded } = await excludeUntouchedLaunchResidue(root, ['new.ts'], launchSnapshot);
    expect(included).toEqual(['new.ts']);
    expect(excluded).toEqual([]);
  });

  test('every candidate untouched since launch partitions to an empty included set', async () => {
    const root = tempRoot('dirty-guard-allexcluded-');
    initRepo(root);
    writeFileSync(join(root, 'residue-a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'residue-b.ts'), 'export const b = 1;\n');
    const launchSnapshot = snapshotDirtyTree(root);
    await launchSnapshot.ready;

    const { included, excluded } = await excludeUntouchedLaunchResidue(root, ['residue-a.ts', 'residue-b.ts'], launchSnapshot);
    expect(included).toEqual([]);
    expect([...excluded].sort()).toEqual(['residue-a.ts', 'residue-b.ts']);
  });
});

// ---------------------------------------------------------------------------
// phase-runner.ts wiring, runPhase -> commitPhaseWork end to end
// ---------------------------------------------------------------------------

function makeWorkstream(): Workstream {
  return { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items: [], createdAt: Date.now() };
}

function makeScopedPhase(): Phase {
  return { id: 'phase-1', ordinal: 1, role: 'engineer', capacity: 1, gate: { scope: 'scoped', gates: [] }, kind: 'engineer' };
}

function makeItem(touchedPaths: string[]): WorkItem {
  return {
    id: 'item-1',
    title: 'item',
    task: 'do work',
    dependsOn: [],
    currentPhaseId: 'phase-1',
    state: 'in-phase',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths,
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: Date.now(),
  };
}

describe('phase-runner: dirty-residue guard wiring', () => {
  test('excludes untouched launch-dirty residue from a scoped commit; commits only the genuinely new path', async () => {
    const root = tempRoot('phase-runner-dirty-exclude-');
    initRepo(root);
    // Residue left behind by a "previously killed run", already dirty before this engine launches.
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // Taken BEFORE any of this "run"'s own writes, matching real engine-launch
    // timing: snapshotDirtyTree is synchronous (see dirty-guard.ts), so this
    // deterministically reflects only what was dirty at launch.
    const launchDirtySnapshot = snapshotDirtyTree(root);

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    // item.touchedPaths already carries 'residue.ts', simulating WorkItem.touchedPaths'
    // real accumulate-and-never-reset behavior across phases/retries (phase-runner.ts).
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
      launchDirtySnapshot,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    // This run's engineer creates a genuinely new file; residue.ts stays untouched.
    writeFileSync(join(root, 'feature.ts'), 'export const feature = 1;\n');
    h.completeAgent(agentId, engineerReportOutput({ filesCreated: ['feature.ts'] }));
    const outcome = await outcomePromise;

    expect(outcome.agentStatus).toBe('completed');
    expect(outcome.result.gate.passed).toBe(true);
    expect(outcome.result.commitExclusion?.excludedPaths).toEqual(['residue.ts']);
    expect(outcome.result.commitExclusion?.skipped).toBe(false);

    expect(outcome.result.commit?.status).toBe('committed');
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('feature.ts');
    expect(committedFiles).not.toContain('residue.ts');
    // residue.ts is still sitting dirty on disk, never swept into the commit.
    expect(runGit(root, ['status', '--porcelain'])).toContain('residue.ts');
  });

  test('includes a pre-dirty path that this run actually modifies', async () => {
    const root = tempRoot('phase-runner-dirty-include-');
    initRepo(root);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // Taken BEFORE any of this "run"'s own writes, matching real engine-launch
    // timing: snapshotDirtyTree is synchronous (see dirty-guard.ts), so this
    // deterministically reflects only what was dirty at launch.
    const launchDirtySnapshot = snapshotDirtyTree(root);

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
      launchDirtySnapshot,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    // This run genuinely changes residue.ts's content.
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 2;\n');
    h.completeAgent(agentId, engineerReportOutput({ filesModified: ['residue.ts'] }));
    const outcome = await outcomePromise;

    expect(outcome.result.commitExclusion).toBeUndefined();
    expect(outcome.result.commit?.status).toBe('committed');
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('residue.ts');
  });

  test('skips the commit entirely with an honest recorded note when every candidate path is untouched residue', async () => {
    const root = tempRoot('phase-runner-dirty-skip-');
    initRepo(root);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // Taken BEFORE any of this "run"'s own writes, matching real engine-launch
    // timing: snapshotDirtyTree is synchronous (see dirty-guard.ts), so this
    // deterministically reflects only what was dirty at launch.
    const launchDirtySnapshot = snapshotDirtyTree(root);

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
      launchDirtySnapshot,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    // Engineer reports no new work; residue.ts is exactly as it was at launch.
    h.completeAgent(agentId, engineerReportOutput({}));
    const outcome = await outcomePromise;

    expect(outcome.result.commitExclusion?.skipped).toBe(true);
    expect(outcome.result.commitExclusion?.excludedPaths).toEqual(['residue.ts']);
    expect(commitCount(root)).toBe(0);
  });

  test('without a launchDirtySnapshot dep, behavior is unchanged: every candidate path commits (graceful degrade)', async () => {
    const root = tempRoot('phase-runner-dirty-degrade-');
    initRepo(root);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // No launchDirtySnapshot passed at all.

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    h.completeAgent(agentId, engineerReportOutput({}));
    const outcome = await outcomePromise;

    expect(outcome.result.commitExclusion).toBeUndefined();
    expect(outcome.result.commit?.status).toBe('committed');
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('residue.ts');
  });
});


// The actual phase runner must pass its original root to the final Git commit
// callback; a path resolved afresh after the phase is not that original source.
test('phase-runner passes the retained alias root guard through the Git commit assertion seam', async () => {
  const physical = tempRoot('phase-root-physical-'), foreign = tempRoot('phase-root-foreign-'), alias = physical + '.alias';
  symlinkSync(physical, alias, 'dir'); initRepo(alias);
  const launchDirtySnapshot = snapshotDirtyTree(alias), h = createOrchestrationHarness(), worktree = new AgentWorktree(alias);
  let callback: (() => void) | undefined;
  const commit = spyOn(worktree, 'commitWorkingTree').mockImplementation(async (_message, _paths, beforeCommit) => {
    callback = beforeCommit; beforeCommit?.(); return { hash: null, skippedIgnored: [] };
  });
  try {
    const outcomePromise = runPhase(makeWorkstream(), makeItem(['feature.ts']), makeScopedPhase(), [], {
      agentManager: h.agentManager, configManager: makeFakeConfigManager(), runtimeBus: h.bus, projectRoot: alias, sessionId: 'test',
      createWorktree: () => worktree, cancellation: createCancellationRegistry(), skipClaimVerification: true, launchDirtySnapshot,
    });
    writeFileSync(join(alias, 'feature.ts'), 'export const feature = true;\n');
    h.completeAgent(h.spawnedRecords.at(-1)!.id, engineerReportOutput({ filesCreated: ['feature.ts'] }));
    await outcomePromise; expect(typeof callback).toBe('function');
    unlinkSync(alias); symlinkSync(foreign, alias, 'dir');
    expect(() => callback?.()).toThrow(/Dirty snapshot root (alias|target|physical root) changed/);
  } finally { commit.mockRestore(); rmSync(alias, { force: true }); rmSync(physical, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
});
