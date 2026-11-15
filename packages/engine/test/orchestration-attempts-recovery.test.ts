/**
 * Best-of-N groups after a restart, a retry and a failed merge; the engine's
 * handling of a cancelled run's result, of a refused spawn, and of the
 * launch-time dirty-tree notice; and the memory bound on the dirty snapshot.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAttemptsCoordinator,
  emptyWorkItemUsage,
  type OrchestrationEvent,
  type WorkItem,
  type WorkItemSpec,
  type Workstream,
} from '../platform/src/platform/orchestration/index.js';
import { copyContractFields } from '../platform/src/platform/orchestration/contract-binding.js';
import { createOrchestrationEngine, type OrchestrationEngineDeps } from '../platform/src/platform/orchestration/engine.js';
import { deserializeWorkstreamSnapshot, serializeWorkstreamSnapshot } from '../platform/src/platform/orchestration/persistence.js';
import { excludeUntouchedLaunchResidue, nativeDirtySnapshotEntries, snapshotDirtyTreeWithin } from '../platform/src/platform/orchestration/dirty-guard.js';
import type { PhaseRunnerAgentManagerLike, WorktreeOps } from '../platform/src/platform/orchestration/phase-runner.js';
import type { PhaseSpec } from '../platform/src/platform/orchestration/types.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../platform/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/manager.js';

async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// The attempts coordinator, driven directly
// ---------------------------------------------------------------------------

function makeItem(spec: WorkItemSpec): WorkItem {
  return {
    id: spec.id ?? `item-${Math.random().toString(36).slice(2, 8)}`,
    title: spec.title,
    task: spec.task,
    dependsOn: [],
    currentPhaseId: 'phase-1',
    state: 'pending',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths: [],
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: 0,
    ...copyContractFields(spec),
  };
}

function makeWorkstream(items: WorkItem[]): Workstream {
  return { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items, isolation: 'worktree', createdAt: 0 };
}

interface CoordinatorHarness {
  readonly events: OrchestrationEvent[];
  readonly cleaned: string[];
  readonly judged: number[];
  readonly coordinator: ReturnType<typeof createAttemptsCoordinator>;
  readonly workstream: () => Workstream;
}

function coordinatorHarness(options: {
  readonly attempts: number;
  readonly autoAccept?: boolean;
  readonly enqueue?: (item: WorkItem) => void | Promise<void>;
}): { h: CoordinatorHarness; siblings: WorkItem[]; groupId: string } {
  const events: OrchestrationEvent[] = [];
  const cleaned: string[] = [];
  const judged: number[] = [];
  let ws!: Workstream;
  const coordinator = createAttemptsCoordinator({
    emit: (event) => events.push(event),
    getWorkstream: () => ws,
    enqueueIntegration: async (_workstream, item) => { await options.enqueue?.(item); },
    cleanupWorktree: async (_workstream, item) => { cleaned.push(item.id); },
    diffItem: async (item) => ({ files: [`${item.id}.ts`], unifiedDiff: `diff ${item.id}`, stat: '1 file' }),
    judge: async ({ candidates }) => { judged.push(candidates.length); return { winnerItemId: candidates.find((entry) => entry.state === 'held-merge')?.itemId ?? null, reasons: ['only candidate'] }; },
  });
  const siblings = coordinator.expandItems('ws-1', 'worktree', [{ title: 'T', task: 'x', attempts: options.attempts, ...(options.autoAccept ? { autoAcceptWinner: true } : {}) }], makeItem);
  ws = makeWorkstream(siblings);
  return { h: { events, cleaned, judged, coordinator, workstream: () => ws }, siblings, groupId: siblings[0]!.attemptGroupId! };
}

describe('a group whose winner was already picked', () => {
  test('is not registered again by a resume, and the winner survives a snapshot round trip', async () => {
    const { h, siblings } = coordinatorHarness({ attempts: 3 });
    for (const sibling of siblings) h.coordinator.onItemPassedTerminal(h.workstream(), sibling);
    await h.coordinator.pickWinner(siblings[0]!.attemptGroupId!, siblings[1]!.id);
    await h.coordinator.join();
    expect(await h.coordinator.listGroups()).toEqual([]);

    const snapshot = serializeWorkstreamSnapshot(h.workstream(), []);
    if (snapshot === null) throw new Error('the workstream did not serialize');
    const restored = deserializeWorkstreamSnapshot(snapshot);
    expect(restored).not.toBeNull();
    const restoredWorkstream = restored!.workstream as unknown as Workstream;
    expect(restoredWorkstream.items.some((item) => item.attemptWinner === true)).toBe(true);

    const resumed = createAttemptsCoordinator({
      emit: () => undefined,
      getWorkstream: () => restoredWorkstream,
      enqueueIntegration: () => undefined,
      cleanupWorktree: async () => undefined,
      diffItem: async () => null,
    });
    resumed.reconcileGroups(restoredWorkstream);
    expect(await resumed.listGroups()).toEqual([]);
  });
});

describe('a group that settles, reopens and settles again', () => {
  test('announces readiness again and auto-picks, and does not judge a group with no passing attempt', async () => {
    const { h, siblings } = coordinatorHarness({ attempts: 3, autoAccept: true });
    const ws = h.workstream();
    for (const sibling of siblings) {
      sibling.state = 'failed';
      h.coordinator.onItemFailedTerminal(ws, sibling);
    }
    await flush();
    const ready = () => h.events.filter((event) => event.type === 'attempts-ready');
    expect(ready()).toHaveLength(1);
    // Nothing passed, so there was nothing to judge.
    expect(h.judged).toEqual([]);

    // The operator retries one attempt, and it now passes.
    const retried = siblings[0]!;
    retried.state = 'pending';
    h.coordinator.onItemReopened(retried);
    h.coordinator.onItemPassedTerminal(ws, retried);
    await flush();
    expect(ready()).toHaveLength(2);
    expect(h.judged).toEqual([3]);
    expect(h.events.some((event) => event.type === 'attempt-winner-picked' && event.winnerItemId === retried.id)).toBe(true);
  });
});

describe('a winner whose merge fails', () => {
  test('keeps the losers and puts the group back to be picked again', async () => {
    let failMerge = true;
    const { h, siblings, groupId } = coordinatorHarness({
      attempts: 3,
      enqueue: () => { if (failMerge) throw new Error('integration lane is down'); },
    });
    for (const sibling of siblings) h.coordinator.onItemPassedTerminal(h.workstream(), sibling);
    const winner = siblings[1]!;
    await h.coordinator.pickWinner(groupId, winner.id);
    await h.coordinator.join();

    expect(h.cleaned).toEqual([]);
    expect(winner.state).toBe('held-merge');
    expect(winner.attemptWinner).toBeUndefined();
    const groups = await h.coordinator.listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ready).toBe(true);

    failMerge = false;
    await h.coordinator.pickWinner(groupId, winner.id);
    await h.coordinator.join();
    expect(h.cleaned.sort()).toEqual([siblings[0]!.id, siblings[2]!.id].sort());
    expect(await h.coordinator.listGroups()).toEqual([]);
  });
});

describe('a winner whose merge the lane records as failed', () => {
  // The real lane never rejects: a merge that threw is recorded on the item as a
  // conflict with no conflicting files, and the promise resolves.
  test('keeps the losers and lists the group again', async () => {
    const { h, siblings, groupId } = coordinatorHarness({
      attempts: 3,
      enqueue: (item) => { item.mergeState = 'conflict'; item.conflictFiles = undefined; item.blockedReason = 'integration-error: git is unavailable'; },
    });
    for (const sibling of siblings) h.coordinator.onItemPassedTerminal(h.workstream(), sibling);
    const winner = siblings[1]!;
    await h.coordinator.pickWinner(groupId, winner.id);
    await h.coordinator.join();

    expect(h.cleaned).toEqual([]);
    expect(winner.state).toBe('held-merge');
    expect(winner.attemptWinner).toBeUndefined();
    expect(h.events.some((event) => event.type === 'item-attempt-held')).toBe(true);
    expect(await h.coordinator.listGroups()).toHaveLength(1);
  });

  test('a real conflict with files is the winner merge having run, so the losers are cleaned', async () => {
    const { h, siblings, groupId } = coordinatorHarness({
      attempts: 3,
      enqueue: (item) => { item.mergeState = 'conflict'; item.conflictFiles = ['a.ts']; },
    });
    for (const sibling of siblings) h.coordinator.onItemPassedTerminal(h.workstream(), sibling);
    await h.coordinator.pickWinner(groupId, siblings[1]!.id);
    await h.coordinator.join();
    expect(h.cleaned.sort()).toEqual([siblings[0]!.id, siblings[2]!.id].sort());
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function makeRecord(id: string, task: string): AgentRecord {
  return {
    id, task, template: 'engineer', tools: [], status: 'running', startedAt: Date.now(), toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
  };
}

interface EngineHarness {
  readonly bus: RuntimeEventBus;
  readonly spawned: string[];
  makeEngine(overrides?: Partial<OrchestrationEngineDeps>): ReturnType<typeof createOrchestrationEngine>;
  cancelEvent(agentId: string): void;
}

function engineHarness(projectRoot: string): EngineHarness {
  const bus = new RuntimeEventBus();
  const store = new Map<string, AgentRecord>();
  const spawned: string[] = [];
  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${spawned.length + 1}`;
      const task = (input as { task: string }).task;
      spawned.push(id);
      const record = makeRecord(id, task);
      store.set(id, record);
      return record;
    },
    getStatus: (id: string) => store.get(id) ?? null,
    cancel: (id: string) => { const record = store.get(id); if (record) record.status = 'cancelled'; return true; },
    registerCancellationSignal: () => undefined,
    releaseCancellationSignal: () => undefined,
  };
  const configManager = {
    get: (key: string): unknown => (key === 'contract.commitScope' ? 'scoped' : undefined),
    getCategory: (category: string): unknown => (category === 'contract'
      ? { maxFixRounds: 5, autoCommit: true, transportRetryLimit: 1, transportRetryDelayMs: 1, commitScope: 'scoped', gates: [] }
      : undefined),
  } as unknown as OrchestrationEngineDeps['configManager'];
  const createWorktree = (): WorktreeOps => ({
    merge: async () => true,
    cleanup: async () => undefined,
    commitWorkingTree: async () => ({ hash: 'commit-hash', skippedIgnored: [] }),
    currentHead: async () => 'head-hash',
  });
  return {
    bus, spawned,
    makeEngine: (overrides = {}) => createOrchestrationEngine({
      agentManager, configManager, runtimeBus: bus, projectRoot, createWorktree, persist: false, skipClaimVerification: true, ...overrides,
    }),
    cancelEvent: (agentId) => bus.emit('agents', createEventEnvelope(
      'AGENT_CANCELLED',
      { type: 'AGENT_CANCELLED', agentId, reason: 'operator cancellation' },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    )),
  };
}

const phase: PhaseSpec = { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } };

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'orch-recovery-'));
  const initialized = Bun.spawnSync(['git', 'init', '-q'], { cwd: projectRoot });
  if (initialized.exitCode !== 0) throw new Error(new TextDecoder().decode(initialized.stderr));
  writeFileSync(join(projectRoot, '.gitignore'), '.goodvibes/\n');
});
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

describe('a requeued item', () => {
  test('does not publish the cancelled run as one of its reports', async () => {
    const harness = engineHarness(projectRoot);
    const engine = harness.makeEngine();
    try {
      const ws = engine.createWorkstream({ title: 'ws', phases: [phase], items: [{ id: 'a', title: 'A', task: 'do A' }] });
      engine.start(ws.id);
      await flush();
      expect(ws.items[0]!.state).toBe('in-phase');
      const firstAgent = ws.items[0]!.agentId!;

      expect(engine.requeueItem('a', 'start over')).toBe(true);
      harness.cancelEvent(firstAgent);
      await flush(60);

      // The retried item reads its prior reports; none may come from the run it replaced.
      expect(engine.getPhaseResults(ws.id)).toEqual([]);
    } finally { engine.dispose(); }
  });
});

describe('a refused spawn', () => {
  test('is announced once while the reason stays the same, and rechecked with a growing delay', async () => {
    jest.useFakeTimers();
    try {
      const harness = engineHarness(projectRoot);
      let probes = 0;
      const engine = harness.makeEngine({
        fleetCapacity: () => { probes += 1; return { active: 0, maxSize: 8, capKey: 'fleet.maxSize', refusal: 'host memory is low' }; },
      });
      const refusals: OrchestrationEvent[] = [];
      engine.on((event) => { if (event.type === 'pool-spawn-refused') refusals.push(event); });
      const ws = engine.createWorkstream({ title: 'ws', phases: [phase], items: [{ id: 'a', title: 'A', task: 'do A' }] });
      engine.start(ws.id);
      engine.start(ws.id);
      engine.start(ws.id);
      expect(refusals).toHaveLength(1);

      const probesAfterStart = probes;
      jest.advanceTimersByTime(20_000);
      expect(refusals).toHaveLength(1);
      // A fixed half-second poll would have probed forty more times in twenty seconds.
      expect(probes - probesAfterStart).toBeLessThan(15);
      expect(probes - probesAfterStart).toBeGreaterThan(0);
      engine.dispose();
    } finally { jest.useRealTimers(); }
  });
});

describe('a repository that was dirty at launch', () => {
  test('tells a listener that subscribes after construction', () => {
    writeFileSync(join(projectRoot, 'residue.txt'), 'left over from an earlier run');
    const harness = engineHarness(projectRoot);
    const engine = harness.makeEngine();
    try {
      const seen: OrchestrationEvent[] = [];
      engine.on((event) => seen.push(event));
      const notices = seen.filter((event) => event.type === 'dirty-tree-at-launch');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.type === 'dirty-tree-at-launch' && notices[0].paths).toContain('residue.txt');
    } finally { engine.dispose(); }
  });

  test('says nothing when the tree was clean', () => {
    const committed = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: projectRoot });
    Bun.spawnSync(['git', 'add', '.gitignore'], { cwd: projectRoot });
    Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'ignore'], { cwd: projectRoot });
    expect(committed.exitCode).toBe(0);
    const harness = engineHarness(projectRoot);
    const engine = harness.makeEngine();
    try {
      const seen: OrchestrationEvent[] = [];
      engine.on((event) => seen.push(event));
      expect(seen).toEqual([]);
    } finally { engine.dispose(); }
  });
});

describe('a dirty file too large to keep in memory', () => {
  const launch = (): ReturnType<typeof snapshotDirtyTreeWithin> => snapshotDirtyTreeWithin(projectRoot, { perFileBytes: 10 });

  test('is excluded as launch residue while its content is unchanged', () => {
    writeFileSync(join(projectRoot, 'big.bin'), 'x'.repeat(100));
    const snapshot = launch();
    expect(excludeUntouchedLaunchResidue(projectRoot, ['big.bin'], snapshot)).toEqual({ included: [], excluded: ['big.bin'], uncertain: [] });
  });

  test('is claimed once a phase changes its content', () => {
    writeFileSync(join(projectRoot, 'big.bin'), 'x'.repeat(100));
    const snapshot = launch();
    writeFileSync(join(projectRoot, 'big.bin'), 'y'.repeat(100));
    expect(excludeUntouchedLaunchResidue(projectRoot, ['big.bin'], snapshot)).toEqual({ included: ['big.bin'], excluded: [], uncertain: [] });
  });
});

describe('the dirty snapshot is bounded in memory', () => {
  test('a file past the per-file bound is left unread, the rest are held', () => {
    writeFileSync(join(projectRoot, 'big.bin'), 'x'.repeat(100));
    writeFileSync(join(projectRoot, 'small.txt'), 'tiny');
    const snapshot = snapshotDirtyTreeWithin(projectRoot, { perFileBytes: 10 });
    const entries = nativeDirtySnapshotEntries(snapshot, projectRoot);
    expect(entries.get('big.bin')?.kind).toBe('unavailable');
    expect(entries.get('small.txt')?.kind).toBe('file');
  });

  test('files past the total bound are left unread once it is used up', () => {
    writeFileSync(join(projectRoot, 'a.txt'), '12345678');
    writeFileSync(join(projectRoot, 'b.txt'), '12345678');
    const snapshot = snapshotDirtyTreeWithin(projectRoot, { totalBytes: 10 });
    const entries = nativeDirtySnapshotEntries(snapshot, projectRoot);
    expect([entries.get('a.txt')?.kind, entries.get('b.txt')?.kind].sort()).toEqual(['file', 'unavailable']);
  });
});
