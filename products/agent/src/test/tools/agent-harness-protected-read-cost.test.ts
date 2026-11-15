import { afterAll, describe, expect, test } from 'bun:test';

// Count reads of object slots from before any product module loads: the protected-read
// guards keep the native descriptor readers they were loaded with.
const reads = new WeakMap<object, number>();
let routeSnapshots = 0, routeCount = -1;
const count = (target: unknown): void => {
  if (target !== null && (typeof target === 'object' || typeof target === 'function')) reads.set(target, (reads.get(target) ?? 0) + 1);
};
const readOne = Object.getOwnPropertyDescriptor, readAll = Object.getOwnPropertyDescriptors;
Object.getOwnPropertyDescriptor = ((target: object, key: PropertyKey) => { count(target); return readOne(target, key); }) as typeof Object.getOwnPropertyDescriptor;
Object.getOwnPropertyDescriptors = ((target: object) => {
  count(target);
  // The route selector's candidate list: one { id, content } pair per catalog route.
  if (Array.isArray(target) && target.length === routeCount && target[0] && Object.keys(target[0] as object).join() === 'id,content') routeSnapshots++;
  return readAll(target);
}) as typeof Object.getOwnPropertyDescriptors;

const { installJudgmentPort } = await import('@goodvibes-jev/engine/errors');
const { TASK_ROUTES } = await import('@goodvibes-jev/engine/platform/platform/routing');
const { AGENT_WORKSPACE_CATEGORIES } = await import('../../input/agent-workspace-categories.ts');
const { listWorkspaceActions } = await import('../../tools/agent-harness-workspace-actions.ts');
const { createAgentRouteTool } = await import('../../tools/agent-route-tool.ts');
const { taskRoutePort } = await import('../helpers/task-route-readings.ts');
const { fakeContext, taskRouteSources } = await import('../helpers/route-adapter-fixture.ts');
const { ordinaryResearchOwner, cleanupResearchScreeningFixtures } = await import('../helpers/research-screening.ts');
routeCount = TASK_ROUTES.length;

afterAll(cleanupResearchScreeningFixtures);

/** Every object of the static workspace declarations. */
const declarationNodes = (): object[] => [AGENT_WORKSPACE_CATEGORIES, ...AGENT_WORKSPACE_CATEGORIES.flatMap(category => [category, category.actions, ...category.actions])];
const totalReads = (nodes: readonly object[]): number => nodes.reduce((sum, node) => sum + (reads.get(node) ?? 0), 0);

describe('a protected read proves its snapshot current once', () => {
  test('the retained workspace guards re-read nothing at later boundaries', async () => {
    const guards: Array<() => void> = [];
    await listWorkspaceActions(fakeContext(), { limit: 1000 }, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) guard();
    const nodes = declarationNodes();
    const afterProof = totalReads(nodes);
    for (let boundary = 0; boundary < 200; boundary++) for (const guard of guards) guard();
    // The declarations are frozen, so after the first proof no boundary may walk them again.
    expect(totalReads(nodes)).toBe(afterProof);
  });

  test('a completed route plan verifies the route catalog a bounded number of times, not once per boundary', async () => {
    const query = 'check daemon health';
    const previous = installJudgmentPort(taskRoutePort({ [query]: { pick: 'host-runtime-diagnostics' } }).port);
    try {
      routeSnapshots = 0;
      const result = await createAgentRouteTool(fakeContext(), taskRouteSources).execute({ action: 'plan', query, includeParameters: false });
      expect(result.success).toBe(true);
      // Capture and the first proof; the plan crosses thousands of boundaries.
      expect(routeSnapshots).toBeGreaterThan(0);
      expect(routeSnapshots).toBeLessThanOrEqual(4);
    } finally { installJudgmentPort(previous); }
  });
});
