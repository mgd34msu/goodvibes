/**
 * Contract units whose agents, checks, replies or restarts end in an order the
 * happy path never sees: each must still reach an outcome, never a unit or
 * contract left waiting on an event that will not come.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { IsolatedWorktree } from '../../platform/src/platform/agents/worktree.js';
import { contractInputPath } from '../../platform/src/platform/contract/input-snapshot.js';
import { isAbortError } from '../../platform/src/platform/contract/run-context.js';
import { eventsOf, makeHarness, oneUnitPlan, startContract, twoUnitPlan, waitFor, type Harness } from './runner-support.js';

let harness: Harness | undefined;
afterEach(async () => {
  const finished = harness;
  harness = undefined;
  await finished?.dispose();
});

function use(h: Harness): Harness {
  harness = h;
  return h;
}

const terminal = (h: Harness, contractId: string): boolean => {
  const status = h.store.get(contractId)?.status;
  return status === 'passed' || status === 'failed' || status === 'cancelled';
};

describe('a unit agent that ends without a terminal event', () => {
  test('an executor that rejects before running fails the unit instead of leaving it running', async () => {
    const failed: string[] = [];
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {},
      executeAgent: async () => { throw new Error('the run context could not be built'); },
    }));
    h.bus.on('AGENT_FAILED', ({ payload }) => { failed.push((payload as { agentId: string }).agentId); });
    const { contract } = await startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.units[0]!.status).toBe('failed');
    expect(done.error).toContain('the run context could not be built');
    expect(failed.filter(id => id === h.agentsOf('u1')[0])).toHaveLength(1);
  });

  test('a record marked failed with no event is settled once its execution drains', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {},
      executeAgent: async (record) => {
        await new Promise(resolve => setTimeout(resolve, 0));
        record.status = 'failed';
        record.error = 'observation held';
        record.completedAt = Date.now();
      },
    }));
    const { contract } = await startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('observation held');
  });
});

describe('a contract stopped while its result is being published', () => {
  test('a cancel during the worktree clean-up still records the publication that already happened', async () => {
    const evict = IsolatedWorktree.prototype.evict;
    let contractId = '';
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto' },
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Wrote the parser.' }] },
    }));
    IsolatedWorktree.prototype.evict = function (...args: Parameters<typeof evict>) {
      if (this.path === h.store.get(contractId)?.worktreePath) h.runner.cancel(contractId, 'stopped from the contract view');
      return evict.apply(this, args);
    };
    try {
      contractId = (await startContract(h)).contract.id;
      await waitFor(() => terminal(h, contractId), 'the contract to end', 15_000);
      await h.runner.join(contractId);
      const done = h.store.get(contractId)!;
      expect(done.status).toBe('cancelled');
      expect(done.commit?.status).toBe('committed');
      expect(done.statusLine).toContain('after its result was already published');
      expect(done.decisions.some((decision) => decision.action === 'committed')).toBe(true);
      expect(h.manager.getStatus(done.ownerAgentId)?.progress).toBe(done.statusLine);
    } finally {
      IsolatedWorktree.prototype.evict = evict;
    }
  }, 30_000);
});

describe('a stall seen mid-run', () => {
  test('is recorded while the agent works, and the completion check decides the unit', async () => {
    let h: Harness;
    const checksDone = (count: number) => () => waitFor(() => (h.store.list()[0]?.units[0]?.checks.length ?? 0) >= count, `${count} checks`);
    h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: {
        u1: () => [
          { tool: true, files: { 'src/csv.ts': 'v1\n' }, text: 'first version', after: checksDone(1) },
          { tool: true, files: { 'src/csv.ts': 'v2\n' }, text: 'broke it [unmet]', after: checksDone(2) },
          { tool: true, files: { 'src/csv.ts': 'v3\n' }, text: 'restored it', after: checksDone(3) },
          { tool: true, files: { 'src/csv.ts': 'v4\n' }, text: 'broke it again [unmet]', after: checksDone(4) },
          { files: { 'src/csv.ts': 'v5\n' }, text: 'restored the parser' },
        ],
      },
    }));
    const { contract } = await startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = h.store.get(contract.id)!;
    const u1 = done.units[0]!;
    expect(u1.checks.map((check) => [check.trigger, check.result])).toEqual([
      ['turn-end', 'recorded'], ['turn-end', 'nudge'], ['turn-end', 'recorded'], ['turn-end', 'stall'], ['completion', 'pass'],
    ]);
    expect(eventsOf(h, 'CONTRACT_STALLED')).toEqual([]);
    expect(done.status).toBe('passed');
  }, 30_000);
});

describe('a contract whose budget runs out', () => {
  test('fails naming the budget instead of leaving a unit blocked forever', async () => {
    const h = use(makeHarness({
      plan: twoUnitPlan(),
      scripts: {
        u1: () => [{ files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Wrote the parser.' }],
        u2: () => [{ files: { 'src/convert.ts': 'import { parse } from "./csv";\n' }, text: 'Wired convert.' }],
      },
    }));
    const { contract } = await startContract(h, { budget: { maxTokens: 50 } });
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.failureKind).toBe('budget');
    expect(done.error).toContain("the contract's budget is used up");
  }, 30_000);
});

describe('importing over a contract that runs here', () => {
  test('a forced import is refused while the contract runs, so the run keeps its own record', async () => {
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] },
    }));
    const { contract } = await startContract(h);
    await waitFor(() => h.store.get(contract.id)?.units[0]?.status === 'running', 'u1 to run');
    const live = h.store.get(contract.id);
    const snapshot = h.runner.serializeContract(contract.id)!;
    expect(h.runner.importContract(snapshot, true)).toBe(false);
    expect(h.store.get(contract.id)).toBe(live);
    h.runner.cancel(contract.id, 'test over');
  }, 15_000);
});

describe('what counts as a stop', () => {
  test('an abort-shaped error nobody asked for is not a stop', () => {
    const signal = new AbortController().signal;
    const error = Object.assign(new Error('the request was aborted'), { name: 'AbortError' });
    expect(isAbortError(error, signal)).toBe(false);
    const stopped = new AbortController();
    stopped.abort();
    expect(isAbortError(new Error('anything'), stopped.signal)).toBe(true);
  });
});

describe('a contract whose work has drained', () => {
  test('a worktree-mode contract hands its tree to the retention rules once, and a shared-mode contract has none to hand over', async () => {
    const released: { path: string; baseBranch?: string | undefined }[][] = [];
    const worktrees = { releaseEnded: async (targets: { path: string; baseBranch?: string | undefined }[]) => { released.push([...targets]); return {} as never; } };
    const tree = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'auto' }, worktrees,
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Wrote the parser.' }] } }));
    const { contract } = await startContract(tree);
    await waitFor(() => terminal(tree, contract.id), 'the contract to end', 15_000);
    await tree.runner.join(contract.id);
    await waitFor(() => released.length > 0, 'the worktree to be handed over');
    const done = tree.store.get(contract.id)!;
    expect(done.worktreePath).toBeDefined();
    // The input view captured for the contract is released with it, not left for a later sweep.
    expect(done.inputSnapshot).toBeDefined();
    expect(released).toEqual([[{ path: done.worktreePath!, baseBranch: done.baseBranch }, { path: contractInputPath(done.inputSnapshot!), baseBranch: done.baseBranch }]]);
  }, 30_000);

  test('a shared-mode contract hands over nothing', async () => {
    const released: unknown[] = [];
    const worktrees = { releaseEnded: async (targets: unknown) => { released.push(targets); return {} as never; } };
    const shared = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'shared' }, worktrees,
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Wrote the parser.' }] } }));
    const { contract } = await startContract(shared);
    await waitFor(() => terminal(shared, contract.id), 'the contract to end', 15_000);
    await shared.runner.join(contract.id);
    expect(released).toEqual([]);
  }, 30_000);
});

describe('a unit whose branch has nothing to merge', () => {
  test('a worktree that cannot be removed still lets the unit pass instead of waiting to merge forever', async () => {
    const { remove, integrate } = IsolatedWorktree.prototype;
    let contractId = '';
    const isItemTree = (tree: IsolatedWorktree): boolean => tree.path !== h.store.get(contractId)?.worktreePath;
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto' },
      scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' }, text: 'Wrote the parser.' }] },
    }));
    // The unit's branch reports nothing to merge, and its directory cannot be removed afterwards.
    IsolatedWorktree.prototype.integrate = async function (...args: Parameters<typeof integrate>) {
      return isItemTree(this) ? { status: 'empty' } as Awaited<ReturnType<typeof integrate>> : integrate.apply(this, args);
    };
    IsolatedWorktree.prototype.remove = async function (...args: Parameters<typeof remove>) {
      if (isItemTree(this)) throw new Error('the directory is locked');
      return remove.apply(this, args);
    };
    try {
      contractId = (await startContract(h)).contract.id;
      await waitFor(() => terminal(h, contractId), 'the contract to end', 15_000);
      await h.runner.join(contractId);
      const done = h.store.get(contractId)!;
      expect(done.units.map((unit) => unit.status)).not.toContain('held-merge');
      expect(done.units[0]!.status).toBe('passed');
    } finally {
      IsolatedWorktree.prototype.remove = remove;
      IsolatedWorktree.prototype.integrate = integrate;
    }
  }, 30_000);
});
