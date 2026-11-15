import { describe, expect, test } from 'bun:test';
import { createDaemonFleetRowsPoller } from '../platform/src/platform/runtime/client/fleet-union.ts';
import type { DaemonVerbCaller } from '../platform/src/platform/runtime/client/daemon-verbs.ts';
import type { ProcessNode } from '../platform/src/platform/runtime/fleet/index.ts';

const quiet = { debug: () => {} };
const row = { id: 'd1', kind: 'agent', label: 'daemon job', state: 'thinking' } as unknown as ProcessNode;

describe('daemon fleet rows expire', () => {
  test('rows are dropped after repeated failed polls, and listeners are told', async () => {
    let fail = false;
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(): Promise<T> => {
        if (fail) throw new Error('connection refused');
        return { capturedAt: 1, nodes: [row] } as T;
      },
    } as DaemonVerbCaller;
    const poller = createDaemonFleetRowsPoller({ verbs, refreshIntervalMs: 60_000, log: quiet });
    await poller.refresh();
    let notified = 0;
    poller.subscribe(() => { notified += 1; });
    fail = true;
    await poller.refresh();
    await poller.refresh();
    expect(poller.rows()?.nodes).toHaveLength(1);
    await poller.refresh();
    expect(poller.rows()).toBeNull();
    expect(notified).toBe(1);
    poller.stop();
  });

  test('rows are dropped at once when no daemon is configured any more', async () => {
    let available = true;
    const verbs = {
      probe: () => (available ? { available: true } : { available: false, reason: 'the daemon is disabled' }),
      invoke: async <T,>(): Promise<T> => ({ capturedAt: 1, nodes: [row] }) as T,
    } as DaemonVerbCaller;
    const poller = createDaemonFleetRowsPoller({ verbs, refreshIntervalMs: 60_000, log: quiet });
    await poller.refresh();
    expect(poller.rows()).not.toBeNull();
    available = false;
    await poller.refresh();
    expect(poller.rows()).toBeNull();
    poller.stop();
  });
});
