/**
 * fleet-union.test.ts, the Agents modal shows everything running.
 *
 * The failure this guards is not a crash. It is a modal that shows half the
 * fleet and looks complete: this terminal's own agents present, the daemon's
 * scheduled work and observed agents silently absent, with nothing on screen
 * saying so. That is strictly worse than showing nothing, because a user reads
 * an empty-looking row list as "nothing else is running".
 *
 * So what is pinned here is the union and its precedence, local wins on a
 * shared id, because the local copy is live and actionable while the daemon's
 * arrives over a poll, plus the two degrade paths that must not lose rows.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createFleetUnionReadModel } from '../../runtime/client/fleet-union.ts';
import { createStaticFleetReadModel, buildFleetSnapshot } from '../../views/fleet-read-model.ts';
import type { ProcessNode } from '@goodvibes-jev/engine/platform/platform/runtime/fleet';

// 'thinking' is one of the states the read model counts as actively working
// (RUNNING_STATES in fleet-read-model.ts); 'running' is not one of them.
function node(id: string, label: string, state = 'thinking'): ProcessNode {
  return {
    id, kind: 'agent', label, state,
    elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: false, resumable: false, killable: false, steerable: false },
  } as unknown as ProcessNode;
}

function localModel(nodes: readonly ProcessNode[]) {
  return createStaticFleetReadModel(buildFleetSnapshot(nodes, 1_000));
}

/** A verb caller that answers exactly what the test hands it. */
function verbs(answer: (() => unknown) | { unavailable: string }) {
  const calls: string[] = [];
  if ('unavailable' in (answer as { unavailable?: string }) && typeof answer !== 'function') {
    return {
      calls,
      probe: () => ({ available: false as const, reason: (answer as { unavailable: string }).unavailable }),
      invoke: async () => { throw new Error('must not invoke when unavailable'); },
    };
  }
  return {
    calls,
    probe: () => ({ available: true as const, platformClient: {} as never }),
    invoke: async (methodId: string) => { calls.push(methodId); return (answer as () => unknown)(); },
  };
}

describe('the Agents modal reads local rows union the daemon\'s', () => {
  test('with no daemon configured the local view IS the fleet, unchanged', async () => {
    const union = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: verbs({ unavailable: 'the daemon is disabled' }) as never,
    });
    await union.refresh();
    expect(union.getSnapshot().rows.map((r) => r.node.id)).toEqual(['a1']);
    union.stop();
  });

  test('the daemon\'s rows are folded in alongside this terminal\'s', async () => {
    const union = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: verbs(() => ({ capturedAt: 2_000, nodes: [node('d1', 'scheduled job'), node('d2', 'observed agent')] })) as never,
    });
    await union.refresh();
    const ids = union.getSnapshot().rows.map((r) => r.node.id).sort();
    expect(ids).toEqual(['a1', 'd1', 'd2']);
    union.stop();
  });

  test('a capped daemon answer is labelled partial, and a complete one is not', async () => {
    const capped = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: verbs(() => ({ capturedAt: 2_000, nodes: [node('d1', 'job')], truncated: true, totalCount: 40 })) as never,
    });
    await capped.refresh();
    expect(capped.getSnapshot().daemonPartial).toEqual({ shown: 1, total: 40 });
    capped.stop();
    const whole = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: verbs(() => ({ capturedAt: 2_000, nodes: [node('d1', 'job')] })) as never,
    });
    await whole.refresh();
    expect(whole.getSnapshot().daemonPartial).toBeUndefined();
    whole.stop();
  });

  test('a row both halves carry is shown from the LOCAL copy', async () => {
    const union = createFleetUnionReadModel({
      local: localModel([node('shared', 'live local label')]),
      verbs: verbs(() => ({ capturedAt: 2_000, nodes: [node('shared', 'stale daemon label')] })) as never,
    });
    await union.refresh();
    const rows = union.getSnapshot().rows;
    // One row, not two, and the label from the half that is live and can be
    // interrupted, steered and killed from here.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.node.label).toBe('live local label');
    union.stop();
  });

  test('a failed refresh keeps the last known daemon rows rather than dropping them', async () => {
    let fail = false;
    const union = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: {
        probe: () => ({ available: true as const, platformClient: {} as never }),
        invoke: async () => {
          if (fail) throw new Error('connection reset');
          return { capturedAt: 2_000, nodes: [node('d1', 'scheduled job')] };
        },
      } as never,
    });
    await union.refresh();
    expect(union.getSnapshot().rows).toHaveLength(2);
    fail = true;
    await union.refresh();
    // Half the fleet must not blink out on one bad request. The snapshot's own
    // capturedAt is what discloses that the daemon half is stale.
    expect(union.getSnapshot().rows).toHaveLength(2);
    union.stop();
  });

  test('aggregates are computed over the WHOLE fleet, not summed from two halves', async () => {
    const union = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: verbs(() => ({ capturedAt: 2_000, nodes: [node('d1', 'daemon agent')] })) as never,
    });
    await union.refresh();
    // Rebuilt through the same builder the local view uses: one running count
    // over three-plus nodes, never two counts added together.
    expect(union.getSnapshot().runningCount).toBe(2);
    union.stop();
  });

  test('steering a daemon row refuses with a reason, never a bare false', async () => {
    const union = createFleetUnionReadModel({
      local: localModel([node('a1', 'local agent')]),
      verbs: verbs(() => ({ capturedAt: 2_000, nodes: [node('d1', 'daemon agent')] })) as never,
    });
    await union.refresh();
    const result = union.steer('d1', 'stop');
    // A bare `queued:false` with no reason reads as "the agent ignored you".
    // The refusal is the false branch of the union, so narrowing on the
    // discriminant is also the assertion that a reason is carried at all.
    expect(result.queued).toBe(false);
    if (result.queued === false) expect(result.reason).toContain('daemon');
    union.stop();
  });

  test('stop() ends the refresh timer', () => {
    const handle = { unref: () => {} };
    const started = spyOn(globalThis, 'setInterval').mockImplementation((() => handle) as unknown as typeof setInterval);
    const cleared = spyOn(globalThis, 'clearInterval').mockImplementation((() => {}) as unknown as typeof clearInterval);
    try {
      const union = createFleetUnionReadModel({
        local: localModel([]),
        verbs: verbs(() => ({ capturedAt: 2_000, nodes: [] })) as never,
        refreshIntervalMs: 5,
      });
      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]?.[1]).toBe(5);
      expect(cleared).not.toHaveBeenCalled();

      union.stop();

      expect(cleared).toHaveBeenCalledWith(handle);
    } finally {
      started.mockRestore();
      cleared.mockRestore();
    }
  });
});
