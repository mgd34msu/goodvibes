import { expect, test } from 'bun:test';
import type { SharedSessionRecord } from '../platform/src/platform/control-plane/index.ts';
import { SessionUnionCache, type LocalSessionReader, type WireSessionReader } from '../platform/src/platform/runtime/session-spine/index.ts';

function record(id: string, updatedAt: number): SharedSessionRecord {
  return { id, kind: 'tui', project: '/p', title: id, status: 'active', createdAt: 1, updatedAt, lastActivityAt: updatedAt, messageCount: 0, pendingInputCount: 0, routeIds: [], surfaceKinds: [], participants: [], metadata: {} };
}

test('a limit keeps the newest sessions, so local sessions newer than the wire rows are not dropped', async () => {
  const wireRows = Array.from({ length: 30 }, (_, index) => record(`wire-${index}`, 1_000 + index));
  const mine = record('mine-newest', 9_999);
  const local: LocalSessionReader = {
    listSessions: () => [mine],
    getSession: (id) => (id === mine.id ? mine : null),
  };
  const wire: WireSessionReader = { list: async () => wireRows };
  const cache = new SessionUnionCache({
    local,
    scheduler: { setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} },
    log: { debug: () => {} },
  });
  cache.activate(wire);
  await cache.refresh();
  const page = cache.listSessions(20);
  expect(page).toHaveLength(20);
  expect(page[0]?.id).toBe('mine-newest');
});
