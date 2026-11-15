/** Actual settlement barriers: terminal statuses/events never stand in for executor cleanup. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../platform/src/platform/agents/worktree.js';
import { createOrchestrationEngine, type OrchestrationEngineDeps } from '../platform/src/platform/orchestration/engine.js';
import { createAttemptsCoordinator } from '../platform/src/platform/orchestration/attempts.js';
import { createWorktreeIsolationManager } from '../platform/src/platform/orchestration/worktree-isolation.js';
import type { WorkItem, WorkItemSpec } from '../platform/src/platform/orchestration/types.js';
import { emptyWorkItemUsage } from '../platform/src/platform/orchestration/types.js';
import { createOrchestrationHarness, engineerReportOutput, makeFakeConfigManager } from './_helpers/orchestration-harness.js';
import { waitFor } from './_helpers/test-timeout.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

let useNativeWorktrees = false;
function nativeGit(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
function fixture(overrides: Partial<OrchestrationEngineDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orch-join-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (useNativeWorktrees) {
    nativeGit(root, 'init', '-q', '-b', 'main'); writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    writeFileSync(join(root, 'seed'), 'native original'); nativeGit(root, 'add', '.'); nativeGit(root, 'commit', '-qm', 'seed');
  }
  const h = createOrchestrationHarness();
  const engine = createOrchestrationEngine({
    projectRoot: root, agentManager: h.agentManager, runtimeBus: h.bus,
    configManager: makeFakeConfigManager(), createWorktree: () => h.worktree,
    skipClaimVerification: true, persist: false, ...overrides,
  });
  cleanups.push(() => engine.dispose());
  const makeStream = (items: WorkItemSpec[] = [{ id: 'item', title: 'Item', task: 'Do work' }], isolation?: 'worktree') => engine.createWorkstream({
    title: 'Work', phases: [{ id: 'phase', kind: 'engineer', role: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } }],
    items, ...(isolation ? { isolation } : {}),
  });
  return { root, h, engine, makeStream };
}

/**
 * Appends 'joined' to `log` when `promise` settles. A test pushes a label just
 * before it releases each barrier, so "join stayed pending until the barrier
 * was released" is an ordering in the log rather than a count of turns waited.
 */
function recordSettled(promise: Promise<void>, log: string[]): void {
  void promise.then(() => { log.push('joined'); });
}

function stubIsolatedCleanup(): void {
  // Creation remains real: settlement barriers must hold resources admitted by
  // actual native Git, not a public fake that cannot issue creation receipts.
  useNativeWorktrees = true;
  const clean = spyOn(IsolatedWorktree.prototype, 'isClean').mockResolvedValue(true);
  const remove = spyOn(IsolatedWorktree.prototype, 'remove').mockResolvedValue(undefined);
  cleanups.push(() => { useNativeWorktrees = false; clean.mockRestore(); remove.mockRestore(); });
}

describe('a phase whose agent ends without a terminal event', () => {
  test('settles from the ended record once the agent execution drained', async () => {
    const { engine, h, makeStream } = fixture();
    const execution = deferred();
    h.agentManager.join = () => execution.promise;
    const ws = makeStream();
    engine.start(ws.id);
    await waitFor(() => h.spawnedRecords.length === 1);
    const record = h.agentManager.getStatus(ws.items[0]!.agentId!)!;
    record.status = 'failed';
    record.error = 'observation held';
    execution.resolve();
    await waitFor(() => ws.items[0]!.state === 'failed');
    expect(ws.items[0]!.state).toBe('failed');
  });
});

describe('OrchestrationEngine.join', () => {
  test('waits through a terminal event, executor finally, and phase cleanup after passive disposal', async () => {
    const { engine, h, makeStream } = fixture();
    const execution = deferred();
    const cleanup = deferred();
    const cleanupEntered = deferred();
    const executionEntered = deferred();
    const log: string[] = [];
    h.agentManager.join = () => { executionEntered.resolve(); return execution.promise; };
    h.worktree.cleanup = async () => { cleanupEntered.resolve(); await cleanup.promise; };
    const ws = makeStream();
    engine.start(ws.id);
    h.completeAgent(ws.items[0]!.agentId!, engineerReportOutput({}));
    engine.dispose();
    const joined = engine.join();
    recordSettled(joined, log);
    await executionEntered.promise;
    expect(h.worktree.commits).toHaveLength(0);
    log.push('executor-exits');
    execution.resolve();
    await cleanupEntered.promise;
    log.push('cleanup-exits');
    cleanup.resolve();
    await joined;
    expect(log).toEqual(['executor-exits', 'cleanup-exits', 'joined']);
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('reserves admission before spawn reentrantly kills, disposes, and joins', async () => {
    const { engine, h, makeStream } = fixture();
    const execution = deferred();
    const executionEntered = deferred();
    const log: string[] = [];
    h.agentManager.join = () => { executionEntered.resolve(); return execution.promise; };
    const originalSpawn = h.agentManager.spawn;
    let joined!: Promise<void>;
    h.agentManager.spawn = (input, binding) => {
      const record = originalSpawn(input, binding);
      expect(engine.kill('item')).toBe(true);
      engine.dispose();
      joined = engine.join();
      return record;
    };
    const ws = makeStream();
    engine.start(ws.id);
    recordSettled(joined, log);
    await executionEntered.promise;
    expect(h.cancelCalls.some((call) => call.agentId === 'agent-1')).toBe(true);
    expect(h.worktree.cleanups).toHaveLength(0);
    log.push('executor-exits');
    execution.resolve();
    await joined;
    expect(log).toEqual(['executor-exits', 'joined']);
    expect(h.worktree.cleanups).toEqual(['agent-1']);
    expect(ws.items[0]!.state).toBe('failed');
  });

  test('cancellation from item-agent-spawned cannot miss a synchronous terminal event', async () => {
    const { engine, h, makeStream } = fixture();
    engine.on((event) => { if (event.type === 'item-agent-spawned') engine.kill(event.itemId); });
    const ws = makeStream();
    engine.start(ws.id);
    engine.dispose();
    await engine.join();
    expect(ws.items[0]!.state).toBe('failed');
    expect(h.worktree.cleanups).toEqual(['agent-1']);
  });

  test('a completion emitted inside spawn is observed before spawn returns', async () => {
    const { engine, h, makeStream } = fixture();
    const originalSpawn = h.agentManager.spawn;
    h.agentManager.spawn = (input, binding) => {
      const record = originalSpawn(input, binding);
      h.completeAgent(record.id, engineerReportOutput({}));
      return record;
    };
    const ws = makeStream();
    engine.start(ws.id);
    await engine.join();
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('requeue waits for the old executor to exit before admitting its replacement', async () => {
    const { engine, h, makeStream } = fixture();
    const firstExecution = deferred();
    const firstExecutionEntered = deferred();
    const log: string[] = [];
    h.agentManager.join = (id) => {
      if (id !== 'agent-1') return Promise.resolve();
      firstExecutionEntered.resolve();
      return firstExecution.promise;
    };
    const ws = makeStream();
    engine.start(ws.id);
    expect(engine.requeueItem('item', 'fresh run')).toBe(true);
    await firstExecutionEntered.promise;
    expect(h.spawnedRecords).toHaveLength(1);
    const joined = engine.join();
    recordSettled(joined, log);
    log.push('old-executor-exits');
    firstExecution.resolve();
    await waitFor(() => h.spawnedRecords.length === 2);
    log.push('replacement-completes');
    h.completeAgent('agent-2', engineerReportOutput({}));
    await joined;
    expect(log).toEqual(['old-executor-exits', 'replacement-completes', 'joined']);
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('retry after kill cannot be overwritten by the cancelled phase settling later', async () => {
    const { engine, h, makeStream } = fixture();
    const firstExecution = deferred();
    const firstExecutionEntered = deferred();
    const log: string[] = [];
    h.agentManager.join = (id) => {
      if (id !== 'agent-1') return Promise.resolve();
      firstExecutionEntered.resolve();
      return firstExecution.promise;
    };
    const ws = makeStream();
    engine.start(ws.id);
    engine.kill('item');
    expect(engine.retryItem('item')).toBe(true);
    const joined = engine.join();
    recordSettled(joined, log);
    await firstExecutionEntered.promise;
    expect(h.spawnedRecords).toHaveLength(1);
    log.push('old-executor-exits');
    firstExecution.resolve();
    await waitFor(() => h.spawnedRecords.length === 2);
    log.push('replacement-completes');
    h.completeAgent('agent-2', engineerReportOutput({}));
    await joined;
    expect(log).toEqual(['old-executor-exits', 'replacement-completes', 'joined']);
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('joins the next phase admitted from the preceding phase finalizer', async () => {
    const { engine, h } = fixture();
    const ws = engine.createWorkstream({
      title: 'Pipeline', items: [{ id: 'item', title: 'Work', task: 'Work' }],
      phases: [1, 2].map((n) => ({ id: `phase-${n}`, kind: 'engineer', role: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] } })),
    });
    engine.start(ws.id);
    const log: string[] = [];
    const joined = engine.join();
    recordSettled(joined, log);
    h.completeAgent('agent-1', engineerReportOutput({}));
    await waitFor(() => h.spawnedRecords.length === 2);
    log.push('second-phase-completes');
    h.completeAgent('agent-2', engineerReportOutput({}));
    await joined;
    expect(log).toEqual(['second-phase-completes', 'joined']);
    expect(engine.getPhaseResults(ws.id)).toHaveLength(2);
  });

  test('abort during contract pre-spawn waits for it but never starts its late spawn decision', async () => {
    const decision = deferred<{ kind: 'spawn' }>();
    const decisionRequested = deferred();
    const log: string[] = [];
    const { engine, h, makeStream } = fixture({ contractUnitSettlement: {
      beforeSpawn: () => { decisionRequested.resolve(); return decision.promise; },
      settle: async () => 'completed',
    } });
    const ws = makeStream([{ id: 'item', title: 'Unit', task: 'Do work', contractId: 'contract', contractUnitId: 'unit' }]);
    engine.start(ws.id);
    engine.kill('item');
    engine.dispose();
    const joined = engine.join();
    recordSettled(joined, log);
    await decisionRequested.promise;
    log.push('decision-arrives');
    decision.resolve({ kind: 'spawn' });
    await joined;
    expect(log).toEqual(['decision-arrives', 'joined']);
    expect(h.spawnedRecords).toHaveLength(0);
  });

  test('contract semantic settlement also waits for its agent executor finally', async () => {
    const execution = deferred();
    const executionEntered = deferred();
    const log: string[] = [];
    const { engine, h, makeStream } = fixture({ contractUnitSettlement: {
      beforeSpawn: async () => ({ kind: 'spawn' }),
      settle: async () => 'completed',
    } });
    h.agentManager.join = () => { executionEntered.resolve(); return execution.promise; };
    const ws = makeStream([{ id: 'item', title: 'Unit', task: 'Do work', contractId: 'contract', contractUnitId: 'unit' }]);
    engine.start(ws.id);
    const joined = engine.join();
    recordSettled(joined, log);
    await executionEntered.promise;
    expect(h.worktree.cleanups).toHaveLength(0);
    log.push('executor-exits');
    execution.resolve();
    await joined;
    expect(log).toEqual(['executor-exits', 'joined']);
    expect(ws.items[0]!.state).toBe('passed');
  });

  test('kill during isolated setup waits for setup and cleanup without spawning an agent', async () => {
    stubIsolatedCleanup();
    const setup = deferred();
    const entered = deferred();
    const log: string[] = [];
    const { engine, h, makeStream } = fixture({ runWorktreeSetup: async () => { entered.resolve(); await setup.promise; } });
    const ws = makeStream(undefined, 'worktree');
    engine.start(ws.id);
    await entered.promise;
    engine.kill('item');
    const joined = engine.join();
    recordSettled(joined, log);
    expect(ws.items[0]!.worktreePath).toBeDefined();
    log.push('setup-finishes');
    setup.resolve();
    await joined;
    expect(log).toEqual(['setup-finishes', 'joined']);
    expect(h.spawnedRecords).toHaveLength(0);
    expect(ws.items[0]!.worktreePath).toBeUndefined();
    engine.dispose();
  });

  test('best-of-N loser cleanup cannot delete a cancelled sibling before its executor exits', async () => {
    stubIsolatedCleanup();
    const execution = deferred();
    const removed: string[] = [];
    const log: string[] = [];
    const integrate = spyOn(IsolatedWorktree.prototype, 'integrate').mockResolvedValue({ status: 'empty' });
    const remove = spyOn(IsolatedWorktree.prototype, 'remove').mockImplementation(async function (this: IsolatedWorktree) {
      removed.push(this.path);
      log.push(`removed:${this.path}`);
    });
    cleanups.push(() => { integrate.mockRestore(); remove.mockRestore(); });
    const loserSpawned = deferred();
    const { engine, h } = fixture({ runWorktreeSetup: async path => {
      // Complete native setup in the opposite order from the item array. Agent
      // ordinals follow spawn order, not the winner/loser identities.
      if (path === ws.items[0]!.worktreePath) await loserSpawned.promise;
    } });
    const bothSpawned = deferred(), originalSpawn = h.agentManager.spawn; let spawns = 0;
    h.agentManager.spawn = (input, binding) => {
      const result = originalSpawn(input, binding);
      if (++spawns === 1) loserSpawned.resolve();
      if (spawns === 2) bothSpawned.resolve();
      return result;
    };
    cleanups.push(() => { loserSpawned.resolve(); execution.resolve(); });
    const ws = engine.createWorkstream({
      title: 'Attempts', isolation: 'worktree',
      items: [{ id: 'item', title: 'Try', task: 'Work', attempts: 2 }],
      phases: [{ kind: 'engineer', role: 'engineer', capacity: 2, gate: { scope: 'off', gates: [] } }],
    });
    engine.start(ws.id);
    await bothSpawned.promise;
    const winner = ws.items[0]!;
    const loser = ws.items[1]!;
    expect(winner.agentId).toBe('agent-2');
    expect(loser.agentId).toBe('agent-1');
    const loserExecutionEntered = deferred();
    h.agentManager.join = id => {
      if (id !== loser.agentId) return Promise.resolve();
      loserExecutionEntered.resolve();
      return execution.promise;
    };
    const loserPath = loser.worktreePath!;
    const held = deferred();
    const unlisten = engine.on(event => {
      if (event.type === 'item-attempt-held' && event.itemId === winner.id) held.resolve();
    });
    h.completeAgent(winner.agentId!, engineerReportOutput({}));
    await held.promise;
    unlisten();
    expect(winner.state).toBe('held-merge');
    engine.kill(loser.id);
    await engine.pickAttemptWinner(winner.attemptGroupId!, winner.id);
    await loserExecutionEntered.promise;
    expect(removed).not.toContain(loserPath);
    const joined = engine.join();
    recordSettled(joined, log);
    log.push('executor-exits');
    execution.resolve();
    await joined;
    expect(removed).toContain(loserPath);
    // The loser's directory went only after its executor exited, and join waited for both.
    expect(log.indexOf('executor-exits')).toBeLessThan(log.indexOf(`removed:${loserPath}`));
    expect(log.at(-1)).toBe('joined');
    engine.dispose();
  });

  test('joins integration started by imported terminal items and its delayed removal', async () => {
    stubIsolatedCleanup();
    const integration = deferred<{ status: 'empty' }>();
    const removal = deferred();
    const removalEntered = deferred();
    const integrate = spyOn(IsolatedWorktree.prototype, 'integrate').mockImplementation(() => integration.promise);
    const remove = spyOn(IsolatedWorktree.prototype, 'remove').mockImplementation(async () => { removalEntered.resolve(); await removal.promise; });
    cleanups.push(() => { integrate.mockRestore(); remove.mockRestore(); });
    const { root, engine, makeStream } = fixture();
    const ws = makeStream(undefined, 'worktree');
    const originalOwner = createWorktreeIsolationManager({ projectRoot: root, emit() {} });
    await originalOwner.ensureWorktree(ws, ws.items[0]!);
    ws.items[0]!.state = 'passed';
    ws.items[0]!.currentPhaseId = null;
    expect(engine.importWorkstream(engine.serializeWorkstream(ws.id)!)).toBe(true);
    engine.dispose();
    const log: string[] = [];
    const joined = engine.join();
    recordSettled(joined, log);
    log.push('integration-finishes');
    integration.resolve({ status: 'empty' });
    await removalEntered.promise;
    log.push('removal-finishes');
    removal.resolve();
    await joined;
    expect(log).toEqual(['integration-finishes', 'removal-finishes', 'joined']);
  });
});

function item(spec: WorkItemSpec): WorkItem {
  return { id: spec.id!, task: spec.task, title: spec.title, dependsOn: [], state: 'pending', currentPhaseId: null,
    allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 0 };
}

describe('orchestration nested work', () => {
  test('auto-judge and fire-and-forget loser cleanup remain owned after attempts-ready', async () => {
    const judgment = deferred<{ winnerItemId: string; reasons: string[] }>();
    const loserCleanup = deferred();
    let joined!: Promise<void>;
    const ws = { id: 'ws', title: 'Attempts', schemaVersion: 1, phases: [], items: [] as WorkItem[], isolation: 'worktree' as const, createdAt: 0 };
    const coordinator = createAttemptsCoordinator({
      emit: (event) => { if (event.type === 'attempts-ready') joined = coordinator.join(); },
      getWorkstream: () => ws, enqueueIntegration: () => undefined,
      cleanupWorktree: () => loserCleanup.promise, diffItem: async () => null,
      judge: () => judgment.promise,
    });
    ws.items = coordinator.expandItems(ws.id, 'worktree', [{ id: 'item', title: 'Try', task: 'Do work', attempts: 2, autoAcceptWinner: true }], item);
    for (const sibling of ws.items) coordinator.onItemPassedTerminal(ws, sibling);
    const log: string[] = [];
    recordSettled(joined, log);
    log.push('judgment-arrives');
    judgment.resolve({ winnerItemId: ws.items[0]!.id, reasons: ['best'] });
    await waitFor(() => ws.items[0]!.attemptWinner === true);
    log.push('loser-cleanup-finishes');
    loserCleanup.resolve();
    await joined;
    expect(log).toEqual(['judgment-arrives', 'loser-cleanup-finishes', 'joined']);
    expect(ws.items[0]!.attemptWinner).toBe(true);
  });

  test('kept-worktree eviction is joined after the triggering cleanup has returned', async () => {
    stubIsolatedCleanup();
    const eviction = deferred<{ preservedCommit: string | null }>();
    const dirty = spyOn(IsolatedWorktree.prototype, 'isClean').mockResolvedValue(false);
    const evict = spyOn(IsolatedWorktree.prototype, 'evict').mockImplementation(() => eviction.promise);
    cleanups.push(() => { dirty.mockRestore(); evict.mockRestore(); });
    const { root } = fixture();
    const isolation = createWorktreeIsolationManager({ projectRoot: root, emit: () => undefined, keptWorktreeCap: 0 });
    const workItem = item({ id: 'item', task: 'Work', title: 'Work' });
    const ws = { id: 'ws', title: 'Work', schemaVersion: 1, phases: [], items: [workItem], isolation: 'worktree' as const, createdAt: 0 };
    await isolation.ensureWorktree(ws, workItem);
    await isolation.cleanupTerminated(ws, workItem);
    const log: string[] = [];
    const joined = isolation.join();
    recordSettled(joined, log);
    log.push('eviction-finishes');
    eviction.resolve({ preservedCommit: 'saved' });
    await joined;
    expect(log).toEqual(['eviction-finishes', 'joined']);
    expect(workItem.worktreePath).toBeUndefined();
  });
});
