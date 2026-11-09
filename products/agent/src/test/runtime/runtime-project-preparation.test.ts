import { afterEach, expect, test } from 'bun:test';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import type { RuntimeServices } from '../../runtime/services.ts';

const acquired = new Set<RuntimeServices>();
afterEach(async () => {
  resetTestRuntimeServices();
  const outcomes = await Promise.allSettled([...acquired].map(async services => {
    await services.close();
    await services.workspaceCheckpointManager.drain();
  }));
  acquired.clear();
  const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Prepared Agent fixture teardown failed');
});

test('concurrent fixture acquisition prepares and publishes one real Agent graph', async () => {
  resetTestRuntimeServices();
  const [first, second] = await Promise.all([getTestRuntimeServices(), getTestRuntimeServices()]);
  acquired.add(first);
  expect(second).toBe(first);
  expect(await getTestRuntimeServices()).toBe(first);
  expect(first.knowledgeService).toBe(first.agentKnowledgeService);
  const status = await first.agentKnowledgeService.getStatus({ includeAllSpaces: true });
  expect(status.sourceCount).toBe(0);
  expect(status.nodeCount).toBe(0);
});

test('reset retires in-flight preparation and a fresh acquisition owns its own graph', async () => {
  resetTestRuntimeServices();
  const retired = getTestRuntimeServices();
  // Observe the retired promise immediately, including its eventual rejection.
  const retiredResult = retired.then(() => 'published', error => error);
  resetTestRuntimeServices();
  const current = await getTestRuntimeServices();
  acquired.add(current);
  const failure = await retiredResult;
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Retired preparation published a graph');
  expect(failure.message).toBe('Test runtime preparation was reset');
  expect(await getTestRuntimeServices()).toBe(current);
  expect(current.agentKnowledgeService).toBe(current.knowledgeService);
});
