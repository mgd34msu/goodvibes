/**
 * Acknowledged events leave the replay queue so a long session does not keep them.
 */
import { describe, expect, test } from 'bun:test';
import { EventReplayQueue } from '../platform/src/platform/core/event-replay.ts';

describe('EventReplayQueue acknowledged events', () => {
  test('are removed on the next turn and still counted in the stats', () => {
    const queue = new EventReplayQueue(3, 0);
    const ids = [1, 2, 3].map((n) => queue.enqueue('AGENT_COMPLETED', { id: `agent-${n}`, result: { output: 'x'.repeat(1000) } }));

    const replayed = queue.onTurnComplete();
    expect(replayed).toHaveLength(3);
    for (const id of ids) queue.acknowledge(id);
    queue.onTurnComplete();

    const stats = queue.getStats();
    expect(stats.queued).toBe(0);
    expect(stats.acknowledged).toBe(3);
    expect(queue.onTurnComplete()).toEqual([]);
  });

  test('unacknowledged events stay queued and keep replaying', () => {
    const queue = new EventReplayQueue(3, 0);
    const keep = queue.enqueue('CONTRACT_PASSED', { contractId: 'c1' });
    const done = queue.enqueue('CONTRACT_PASSED', { contractId: 'c2' });
    queue.acknowledge(done);

    const replayed = queue.onTurnComplete();

    expect(replayed.map((event) => event.id)).toEqual([keep]);
    expect(queue.getStats()).toMatchObject({ queued: 1, acknowledged: 1, pending: 1 });
  });

  test('clear resets the running acknowledged total', () => {
    const queue = new EventReplayQueue(3, 0);
    queue.acknowledge(queue.enqueue('AGENT_FAILED', { id: 'a' }));
    queue.onTurnComplete();
    queue.clear();

    expect(queue.getStats().acknowledged).toBe(0);
  });
});
