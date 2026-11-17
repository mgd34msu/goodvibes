/**
 * trigger-supervision-store.test.ts, the supervision spine and the persisted
 * store's recovery housekeeping.
 *
 * The store half: persistence without recovery-time housekeeping does not fail
 * loudly, it silently serves stale state forever. These tests check the
 * reaping and bounding the sweep applies.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFailure,
  applySuccess,
  backoffDelayFor,
  boundEventLog,
  boundRecord,
  DEFAULT_BACKOFF_LADDER_MS,
  isDue,
  parseBackoffLadder,
  resetBreaker,
  resolveSupervisionPolicy,
  sweepTriggers,
  type TriggerEventLogEntry,
  type TriggerRecord,
  TriggerManager,
  type TriggerRetentionPolicy,
} from '../platform/src/platform/triggers/index.ts';
import { adaptWatcherTrigger } from '../platform/src/platform/runtime/fleet/adapters/watcher-trigger.ts';
import { adaptTrigger } from '../platform/src/platform/runtime/fleet/adapters/trigger.ts';

const roots: string[] = [];

function tempStore(): string {
  const root = join(tmpdir(), `gv-triggers-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return join(root, 'triggers.json');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    state: 'idle',
    observations: [],
    runs: [],
    ruleState: {},
    strikes: 0,
    backoffRung: 0,
    firedCount: 0,
    droppedLines: 0,
    updatedAt: 0,
    ...overrides,
    definition: {
      id: 'demo',
      label: 'Demo',
      spec: { kind: 'condition', probe: { kind: 'file', path: '/tmp/x' }, extract: { kind: 'raw' }, rule: { kind: 'change' } },
      action: { kind: 'agent-turn', prompt: 'look' },
      createdAt: 0,
      ...overrides.definition,
    },
  } as TriggerRecord;
}

const retention: TriggerRetentionPolicy = {
  observationRingSize: 3,
  runHistoryLimit: 3,
  runHistoryTtlMs: 10_000,
  eventLogLimit: 3,
  eventLogTtlMs: 10_000,
};

describe('backoff ladder', () => {
  test('the shipped ladder is 30s, 60s, 5m, 15m, 60m', () => {
    expect([...DEFAULT_BACKOFF_LADDER_MS]).toEqual([30_000, 60_000, 300_000, 900_000, 3_600_000]);
  });

  test('consecutive failures walk the ladder one rung at a time', () => {
    const policy = resolveSupervisionPolicy({});
    let current = { strikes: 0, backoffRung: 0 };
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = applyFailure(current, policy, 0);
      delays.push(outcome.delayMs);
      current = { strikes: outcome.strikes, backoffRung: outcome.backoffRung };
    }
    expect(delays).toEqual([30_000, 60_000, 300_000, 900_000]);
  });

  test('rungs past the end repeat the last one rather than growing without bound', () => {
    const policy = resolveSupervisionPolicy({});
    expect(backoffDelayFor(policy, 4)).toBe(3_600_000);
    expect(backoffDelayFor(policy, 99)).toBe(3_600_000);
  });

  test('a success resets both the strike count and the rung', () => {
    const reset = applySuccess(60_000, 1_000);
    expect(reset).toEqual({ state: 'idle', strikes: 0, backoffRung: 0, nextCheckAt: 61_000 });
  });

  test('a malformed ladder setting falls back rather than taking the supervisor down', () => {
    expect([...parseBackoffLadder('not,a,ladder')]).toEqual([...DEFAULT_BACKOFF_LADDER_MS]);
    expect([...parseBackoffLadder('')]).toEqual([...DEFAULT_BACKOFF_LADDER_MS]);
    expect([...parseBackoffLadder('1000,2000')]).toEqual([1_000, 2_000]);
  });
});

describe('five-strike breaker', () => {
  test('opens on the fifth consecutive failure, not before', () => {
    const policy = resolveSupervisionPolicy({});
    expect(policy.breakerStrikes).toBe(5);
    let current = { strikes: 0, backoffRung: 0 };
    const opened: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const outcome = applyFailure(current, policy, 0);
      opened.push(outcome.breakerOpened);
      current = { strikes: outcome.strikes, backoffRung: outcome.backoffRung };
    }
    expect(opened).toEqual([false, false, false, false, true]);
  });

  test('an open breaker parks the trigger and stops it coming due', () => {
    const policy = resolveSupervisionPolicy({ breakerStrikes: 1 });
    const outcome = applyFailure({ strikes: 0, backoffRung: 0 }, policy, 1_000);
    expect(outcome.state).toBe('circuit-open');
    expect(Number.isFinite(outcome.nextCheckAt)).toBe(false);

    const parked = record({ state: 'circuit-open', nextCheckAt: 0 });
    expect(isDue(parked, 999_999)).toBe(false);
  });

  test('the breaker closes only on an explicit operator reset', () => {
    const parked = record({ state: 'circuit-open', strikes: 7, backoffRung: 4, lastError: 'boom' });
    const reset = resetBreaker(parked, 5_000);
    expect(reset.state).toBe('idle');
    expect(reset.strikes).toBe(0);
    expect(reset.backoffRung).toBe(0);
    expect(reset.lastError).toBeUndefined();
    expect(isDue(reset, 5_000)).toBe(true);
  });

  test('a failure read as permanent opens the breaker on its first strike; a retryable one walks the ladder', () => {
    const policy = resolveSupervisionPolicy({});
    const permanent = applyFailure({ strikes: 0, backoffRung: 0 }, policy, 0, { failureClass: 'terminal' });
    expect(permanent.breakerOpened).toBe(true);
    expect(permanent.readAsPermanent).toBe(true);
    expect(permanent.state).toBe('circuit-open');
    const retryable = applyFailure({ strikes: 0, backoffRung: 0 }, policy, 0, { failureClass: 'retryable' });
    expect(retryable.breakerOpened).toBe(false);
    expect(retryable.state).toBe('backoff');
  });

  test('the breaker strike count is configurable', () => {
    const policy = resolveSupervisionPolicy({ breakerStrikes: 2 });
    expect(applyFailure({ strikes: 1, backoffRung: 0 }, policy, 0).breakerOpened).toBe(true);
  });
});

describe('bounding: count cap AND age TTL', () => {
  test('run history is capped by count and by age', () => {
    const now = 100_000;
    const withRuns = record({
      runs: [
        { at: now - 50_000, outcome: 'checked' },
        { at: now - 3_000, outcome: 'checked' },
        { at: now - 2_000, outcome: 'checked' },
        { at: now - 1_000, outcome: 'checked' },
        { at: now, outcome: 'checked' },
      ],
    });
    const bounded = boundRecord(withRuns, retention, now);
    // The 50s-old run is past the 10s TTL; the remaining four are capped to 3.
    expect(bounded.record.runs).toHaveLength(3);
    expect(bounded.runsReaped).toBe(2);
    expect(bounded.record.runs.every((run) => run.at >= now - retention.runHistoryTtlMs)).toBe(true);
  });

  test('the observation ring is capped and keeps the newest samples', () => {
    const withObs = record({
      observations: [1, 2, 3, 4, 5].map((n) => ({ at: n, value: n, text: String(n), numeric: n })),
    });
    const bounded = boundRecord(withObs, retention, 10);
    expect(bounded.record.observations.map((o) => o.numeric)).toEqual([3, 4, 5]);
    expect(bounded.observationsReaped).toBe(2);
  });

  test('the shared event log is capped by count and by age', () => {
    const now = 100_000;
    const log: TriggerEventLogEntry[] = [
      { at: now - 50_000, triggerId: 'a', kind: 'condition', event: 'fired', fingerprint: '1' },
      { at: now - 3, triggerId: 'b', kind: 'condition', event: 'fired', fingerprint: '2' },
      { at: now - 2, triggerId: 'c', kind: 'condition', event: 'fired', fingerprint: '3' },
      { at: now - 1, triggerId: 'd', kind: 'condition', event: 'fired', fingerprint: '4' },
      { at: now, triggerId: 'e', kind: 'condition', event: 'fired', fingerprint: '5' },
    ];
    const bounded = boundEventLog(log, retention, now);
    expect(bounded.eventLog).toHaveLength(3);
    expect(bounded.reaped).toBe(2);
    expect(bounded.eventLog.map((e) => e.triggerId)).toEqual(['c', 'd', 'e']);
  });
});

describe('recovery sweep: reap, disclose, and stay idempotent', () => {
  test('a trigger whose owning session is gone is reaped', () => {
    const live = record({ definition: { id: 'live', ownerSessionId: 'alive' } as never });
    const dead = record({ definition: { id: 'dead', ownerSessionId: 'gone' } as never });
    const swept = sweepTriggers({
      triggers: [live, dead],
      eventLog: [],
      policy: retention,
      now: 0,
      reason: 'startup',
      sessionIsLive: (id) => id === 'alive',
    });
    expect(swept.triggers.map((r) => r.definition.id)).toEqual(['live']);
    expect(swept.report.reapedIds).toEqual(['dead']);
    expect(swept.report.triggersReaped).toBe(1);
  });

  test('a one-shot on-exit trigger retires after it has fired', () => {
    const fired = record({
      definition: { id: 'build', spec: { kind: 'on-exit', command: 'make' } } as never,
      state: 'fired',
    });
    const stillRunning = record({
      definition: { id: 'build2', spec: { kind: 'on-exit', command: 'make' } } as never,
      state: 'running',
    });
    const swept = sweepTriggers({
      triggers: [fired, stillRunning],
      eventLog: [],
      policy: retention,
      now: 0,
      reason: 'sweep',
    });
    expect(swept.triggers.map((r) => r.definition.id)).toEqual(['build2']);
    expect(swept.report.reapedIds).toEqual(['build']);
  });

  test('a tracked process that is gone is reported as orphaned', () => {
    const withProcess = record({
      state: 'running',
      process: { processId: 'p1', pid: 4242, startedAt: 0, command: 'make', args: [], daemonBootId: 'b' },
    });
    const swept = sweepTriggers({
      triggers: [withProcess],
      eventLog: [],
      policy: retention,
      now: 0,
      reason: 'startup',
      processIsLive: () => false,
    });
    expect(swept.report.orphanedProcesses).toEqual(['p1']);
  });

  test('sweeping twice produces the same result: it is idempotent', () => {
    const input = [record({ definition: { id: 'a', ownerSessionId: 'gone' } as never }), record({ definition: { id: 'b' } as never })];
    const first = sweepTriggers({ triggers: input, eventLog: [], policy: retention, now: 0, reason: 'startup', sessionIsLive: () => false });
    const second = sweepTriggers({ triggers: first.triggers, eventLog: first.eventLog, policy: retention, now: 0, reason: 'sweep', sessionIsLive: () => false });
    expect(second.triggers.map((r) => r.definition.id)).toEqual(first.triggers.map((r) => r.definition.id));
    expect(second.report.triggersReaped).toBe(0);
  });
});

describe('trigger-family records surface in the fleet without colliding with workflow triggers', () => {
  test('supervision state maps to honest fleet states', () => {
    const cases: Array<[string, string]> = [
      ['idle', 'idle'],
      ['running', 'executing-tool'],
      ['backoff', 'retrying'],
      ['circuit-open', 'stalled'],
      ['fired', 'done'],
      ['cancelled', 'killed'],
      ['failed', 'failed'],
    ];
    for (const [triggerState, fleetState] of cases) {
      const node = adaptWatcherTrigger(record({ state: triggerState as never }), 5_000);
      expect(node.state).toBe(fleetState as never);
    }
  });

  test('a parked trigger is resumable: resuming it IS the explicit breaker reset', () => {
    const parked = adaptWatcherTrigger(record({ state: 'circuit-open', strikes: 5, lastError: 'ECONNREFUSED' }), 5_000);
    expect(parked.capabilities.resumable).toBe(true);
    expect(parked.capabilities.killable).toBe(true);
    expect(parked.currentActivity?.text).toContain('breaker open after 5 strikes');
  });

  test('dropped stream lines are surfaced on the node, not swallowed', () => {
    const node = adaptWatcherTrigger(record({ state: 'running', droppedLines: 12, firedCount: 3 }), 5_000);
    expect(node.currentActivity?.text).toContain('12 line(s) dropped');
  });

  test('a cancelled trigger is no longer killable', () => {
    expect(adaptWatcherTrigger(record({ state: 'cancelled' }), 5_000).capabilities.killable).toBe(false);
  });

  test('the kind alone tells it from a workflow hook action', () => {
    const familyNode = adaptWatcherTrigger(record(), 5_000);
    const workflowNode = adaptTrigger({ id: 'wf', event: 'push', action: 'build', enabled: true });
    expect(familyNode.kind).toBe('trigger');
    expect(workflowNode.kind).toBe('hook-action');
  });

  test('the label names which watcher kind it is', () => {
    expect(adaptWatcherTrigger(record(), 5_000).label).toContain('(condition)');
  });
});

describe('the trigger family is an OPTIONAL dependency for a hand-composed host', () => {
  // Regression: RuntimeServices.triggerManager shipped as a REQUIRED field, so
  // every host that builds its own services object literal (goodvibes-agent
  // does) crashed on daemon shutdown with
  //   TypeError: undefined is not an object (evaluating 'this.triggerManager.shutdown')
  // Absence must mean "this runtime has no triggers", never a crash; the facade side is
  // covered by daemon-without-trigger-family.test.ts.
  test('a manager with no process host still shuts down cleanly', () => {
    // shutdown() is called on every daemon stop, including one that never
    // started the family or never had a host wired.
    const manager = new TriggerManager({
      storePath: tempStore(),
      config: { enabled: false },
      actions: {
        runAgentTurn: () => Promise.resolve('unused'),
        runGrant: () => Promise.resolve('unused'),
      },
    });
    expect(() => { manager.shutdown(); }).not.toThrow();
  });
});
