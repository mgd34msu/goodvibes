import { expect, test } from 'bun:test';
import { BoundWorkLedgerModel } from '../terminal-shell/src/native/bound-work-ledger.ts';

test('a very large history page loads instead of failing the view', async () => {
  const count = 1_500_000;
  const events = Array.from({ length: count }, (_, index) => ({ type: 'note', sequence: index + 1, actorId: 'a', at: 1 }));
  const snapshot = { projectId: 'p', cursor: count } as never;
  const client = {
    projectId: 'p',
    readSnapshot: async () => snapshot,
    history: async () => events,
    subscribe: () => () => {},
    dispose: () => {},
  } as never;
  const settled = Promise.withResolvers<void>();
  const model: BoundWorkLedgerModel = new BoundWorkLedgerModel(() => {
    if (model.state.status === 'ready' || model.state.status === 'unavailable') settled.resolve();
  });
  model.open({ available: true, client } as never);
  await settled.promise;
  expect(model.state.status).toBe('ready');
  if (model.state.status === 'ready') {
    expect(model.state.history).toHaveLength(count);
    expect(model.state.cursor).toBe(count);
  }
  model.close();
});
