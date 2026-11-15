import { expect, test } from 'bun:test';
import { createDaemonKnowledgeRefinementRouteHandlers } from '../daemon-api/src/knowledge-refinement-routes.js';
import { KnowledgeRefinementTaskRefusedError } from '../platform/src/platform/knowledge/store-conflict.js';
import type { DaemonKnowledgeRouteContext } from '../daemon-api/src/knowledge-route-types.js';

function handlers(cancel: (id: string) => Promise<unknown>) {
  const context = { requireAdmin: () => null, parseOptionalJsonBody: async () => ({}), knowledgeService: { cancelRefinementTask: cancel } };
  return createDaemonKnowledgeRefinementRouteHandlers(context as unknown as DaemonKnowledgeRouteContext);
}

test('cancelling a decided refinement task answers 409 with the state instead of success', async () => {
  const route = handlers(async id => { throw new KnowledgeRefinementTaskRefusedError(id, 'closed', 'knowledge refinement task is closed and cannot become cancelled; it is final'); });
  const response = await route.postKnowledgeCancelRefinementTask('task-1', new Request('http://daemon/x', { method: 'POST' }));
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).toContain('is closed');
});

test('cancelling a live refinement task still answers 200 with the task and an unknown task 404', async () => {
  const ok = await handlers(async () => ({ id: 'task-1', state: 'cancelled' })).postKnowledgeCancelRefinementTask('task-1', new Request('http://daemon/x', { method: 'POST' }));
  expect(ok.status).toBe(200);
  const missing = await handlers(async () => null).postKnowledgeCancelRefinementTask('nope', new Request('http://daemon/x', { method: 'POST' }));
  expect(missing.status).toBe(404);
});
