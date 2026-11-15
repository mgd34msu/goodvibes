/**
 * The observe read models stay usable when one input is bad: a subscriber that
 * throws, a reading with an unreadable time, an unnamed call in the volume
 * section, and an unreadable decision log behind the volume monitor.
 */
import { describe, expect, test } from 'bun:test';
import { EvalRegistry } from '../platform/src/platform/observe/eval-registry.ts';
import { readingDrift } from '../platform/src/platform/observe/drift.ts';
import { judgmentVolume, type JudgmentVolumeEntry } from '../platform/src/platform/observe/judgment-volume.ts';
import { UNNAMED, type LoggedReading } from '../platform/src/platform/observe/log-readings.ts';
import { captureJudgmentVolumeMonitorSettings, startJudgmentVolumeMonitor, type JudgmentVolumeAlert } from '../platform/src/platform/observe/judgment-volume-monitor.ts';
import type { EvalSuiteResult } from '../platform/src/platform/runtime/eval/types.ts';

describe('the eval registry', () => {
  const result = (suite: string): EvalSuiteResult => ({ suite, meanScore: 80 }) as unknown as EvalSuiteResult;

  test('a subscriber that throws does not starve the ones after it, and the failure is not hidden', () => {
    const registry = new EvalRegistry();
    let later = 0;
    registry.subscribe(() => { throw new Error('first subscriber failed'); });
    registry.subscribe(() => { later += 1; });
    expect(() => registry.push(result('core'))).toThrow('first subscriber failed');
    expect(later).toBe(1);
    expect(registry.getSuiteResults()).toHaveLength(1);
  });

  test('readers get a new array after each change', () => {
    const registry = new EvalRegistry();
    registry.push(result('core'));
    const before = registry.getSuiteResults();
    registry.push(result('safety'));
    expect(registry.getSuiteResults()).not.toBe(before);
    expect(before).toHaveLength(1);
  });
});

describe('drift', () => {
  const reading = (at: string): LoggedReading => ({
    decisionId: `d-${at}`, at, battery: 'test.drift', batteryVersion: 1, site: 'site', pattern: undefined, model: 'm-1',
    question: 'q', kind: 'yes-no', signal: 0.9, outcome: 'act', answer: 'yes', action: undefined,
  }) as unknown as LoggedReading;

  test('a reading with an unreadable time is skipped and counted, and the analysis completes', () => {
    const rows = readingDrift([reading('2026-03-01T00:00:00Z'), reading('not a time'), reading('2026-03-01T01:00:00Z')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skippedReadings).toBe(1);
    expect(rows[0]!.windows.reduce((sum, window) => sum + window.readings, 0)).toBe(2);
  });

  test('a decision whose every reading is unreadable reports no windows instead of failing', () => {
    const rows = readingDrift([reading('bad')]);
    expect(rows).toEqual([{ battery: 'test.drift', windows: [], changed: false, skippedReadings: 1 }]);
  });
});

describe('call volume', () => {
  test('an unnamed call is labelled the same way every other analysis labels it', () => {
    const entry = {
      id: 'e1', context: {},
      volume: { logicalRequestId: 'r1', targetAttempts: 1, wireAttempts: 1, unknownDispatchAttempts: 0, callsWithoutAttemptEvidence: 0 },
    } as unknown as JudgmentVolumeEntry;
    const volume = judgmentVolume([entry]);
    expect(volume.rows[0]!.battery).toBe(UNNAMED);
    expect(volume.rows[0]!.site).toBe(UNNAMED);
  });
});

describe('the volume monitor', () => {
  test('an unreadable log is reported with a cause that does not repeat its message, and is kept for a status read', () => {
    const alerts: JudgmentVolumeAlert[] = [];
    const failure = Object.assign(new Error('cannot open /private/path/decisions.db'), { code: 'SQLITE_BUSY' });
    using monitor = startJudgmentVolumeMonitor({
      log: { query: () => { throw failure; } },
      settings: captureJudgmentVolumeMonitorSettings({ budgets: [{ name: 'all', maxLogicalDecisions: 1 }] }),
      notify: (alert) => alerts.push(alert),
    });
    monitor.check();
    expect(alerts).toEqual([{ kind: 'unavailable', reason: 'SQLITE_BUSY' }]);
    expect(JSON.stringify(alerts)).not.toContain('/private/path');
    expect(monitor.lastAlert()).toEqual(alerts[0]);
  });
});
