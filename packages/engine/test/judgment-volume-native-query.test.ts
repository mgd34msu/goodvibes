/** Native metadata projection regressions, UNRUN until coding is complete. */
import { expect, spyOn, test } from 'bun:test';
import { SqliteDecisionLog, isoTime, type JudgmentLineage, type NewDecisionEntry, type StateHash } from '@goodvibes-jev/judgment';
import { judgmentVolume, judgmentVolumeBreaches } from '../sdk/src/platform/observe/judgment-volume.ts';
import { startJudgmentVolumeMonitor, type JudgmentVolumeAlert } from '../sdk/src/platform/observe/judgment-volume-monitor.ts';

const at = new Date('2026-11-09T12:00:00.000Z');
function entry(lineage?: JudgmentLineage, site = 'native.volume'): NewDecisionEntry {
  return {
    at: isoTime(at), context: { battery: 'test.volume', site }, requestedModel: 'fixture', stateHash: 'a'.repeat(64) as StateHash,
    questions: { prompt: 'Questions excluded from counters '.repeat(5000) }, latencyMs: 1, requestId: undefined,
    status: 'answered', model: 'fixture', answers: { privateAnswer: 'Answers excluded from counters '.repeat(5000) },
    usage: { inputTokens: 1, outputTokens: 1 }, ...(lineage ? { lineage } : {}),
  };
}
const attempts: JudgmentLineage['attempts'] = [true, false, undefined].map((dispatched, index) => ({
  attempt: index + 1, endpointIndex: index, endpointKind: 'local', requestedModel: 'Private attempt model excluded from counters',
  latencyMs: 1, outcome: 'answered', requestId: 'Private attempt receipt excluded from counters',
  ...(dispatched === undefined ? {} : { dispatched }),
}));

test('actual native bounded counters preserve logical/dispatch accounting while no full-entry or note JSON is parsed in JavaScript', () => {
  using log = new SqliteDecisionLog(':memory:');
  const logical = { logicalRequestId: 'same-logical-reading', attempts, omittedAttempts: 2 };
  const first = log.record(entry(logical));
  log.record(entry(logical, 'second.site')); // Same reading recorded under another context.
  log.record(entry()); // Historical entry has unknown wire evidence.
  log.record(entry({ logicalRequestId: 'empty-reading', attempts: [] }));
  log.attach(first, { kind: 'action', action: 'Private action excluded from counters '.repeat(5000) });
  const expected = judgmentVolume(log.query());
  let projected: ReturnType<SqliteDecisionLog['queryVolume']>;
  const parse = spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('Full JSON materialization is forbidden in this native counter read'); });
  try { projected = log.queryVolume({ limit: 100 }); }
  finally { parse.mockRestore(); }
  expect(judgmentVolume(projected)).toEqual(expected);
  expect(judgmentVolume(projected)).toMatchObject({ logicalDecisions: 3, recordedEntries: 4,
    targetAttempts: 5, wireAttempts: 1, unknownDispatchAttempts: 3, callsWithoutAttemptEvidence: 2 });
  expect(judgmentVolumeBreaches(projected, [{ name: 'Exact site', site: 'second.site', maxLogicalDecisions: 0, maxWireAttempts: 0 }]))
    .toEqual(judgmentVolumeBreaches(log.query(), [{ name: 'Exact site', site: 'second.site', maxLogicalDecisions: 0, maxWireAttempts: 0 }]));
  const serialized = JSON.stringify(projected);
  for (const value of ['Questions excluded', 'Answers excluded', 'Private action', 'Private attempt', 'questions', 'answers', 'notes', 'stateHash', 'latencyMs']) {
    expect(serialized).not.toContain(value);
  }
  expect(projected.every(row => Object.isFrozen(row) && Object.isFrozen(row.context) && Object.isFrozen(row.volume))).toBe(true);
});

test('native query applies the same exact bound filters/order/limit and refuses unbounded limits', () => {
  using log = new SqliteDecisionLog(':memory:');
  log.record(entry({ logicalRequestId: 'one', attempts }));
  log.record(entry({ logicalRequestId: 'two', attempts }, 'another.site'));
  const query = { battery: 'test.volume', site: 'native.volume', since: '2026-11-09T11:59:59.000Z', until: '2026-11-09T12:00:01.000Z', limit: 1 };
  expect(log.queryVolume(query).map(row => row.id)).toEqual(log.query(query).map(row => row.id));
  expect(log.queryVolume({ site: "native.volume' OR 1=1 --" })).toEqual([]);
  for (const limit of [-1, 0, 1.5, Infinity, 100_002]) expect(() => log.queryVolume({ limit })).toThrow('bounded limit');
});

test('actual monitor uses native projection, preserves sentinel overflow and never calls the full-entry fallback', () => {
  using log = new SqliteDecisionLog(':memory:');
  log.record(entry({ logicalRequestId: 'one', attempts })); log.record(entry({ logicalRequestId: 'two', attempts }));
  const full = spyOn(log, 'query').mockImplementation(() => { throw new Error('Full log reads must not run'); });
  const alerts: JudgmentVolumeAlert[] = [];
  try {
    using monitor = startJudgmentVolumeMonitor({ log, settings: { budgets: [{ name: 'All', maxLogicalDecisions: 0 }],
      intervalMs: 1000, windowMs: 60_000, limit: 1 }, now: () => at.getTime() + 1, notify: alert => alerts.push(alert) });
    monitor.check(); expect(alerts).toEqual([{ kind: 'incomplete-window', limit: 1 }]);
    expect(full).not.toHaveBeenCalled();
  } finally { full.mockRestore(); }
});

test('malformed saved dispatch evidence cannot produce a healthy native volume result', () => {
  using log = new SqliteDecisionLog(':memory:');
  const malformed = { logicalRequestId: 'malformed', attempts: [{ ...attempts[0], dispatched: null }] } as unknown as JudgmentLineage;
  log.record(entry(malformed));
  expect(() => log.queryVolume()).toThrow('unavailable');
  const alerts: JudgmentVolumeAlert[] = [];
  using monitor = startJudgmentVolumeMonitor({ log, settings: { budgets: [{ name: 'All', maxLogicalDecisions: 100, maxWireAttempts: 100 }],
    intervalMs: 1000, windowMs: 60_000, limit: 10 }, now: () => at.getTime() + 1, notify: alert => alerts.push(alert) });
  monitor.check(); expect(alerts).toEqual([{ kind: 'unavailable' }]);
});

test('budget checks use exact counters without building/parsing unused per-site reports', () => {
  using log = new SqliteDecisionLog(':memory:');
  log.record(entry({ logicalRequestId: 'one', attempts }));
  const counters = log.queryVolume();
  let result: ReturnType<typeof judgmentVolumeBreaches>;
  const parse = spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('Counter-only budgets must not parse report groups'); });
  try { result = judgmentVolumeBreaches(counters, [{ name: 'All', maxLogicalDecisions: 0, maxWireAttempts: 0 }]); }
  finally { parse.mockRestore(); }
  expect(result).toEqual([{ budget: 'All', kind: 'logical-decisions', observed: 1, maximum: 0 },
    { budget: 'All', kind: 'wire-attempts', observed: 1, maximum: 0 },
    { budget: 'All', kind: 'incomplete-wire-evidence', observed: 1, maximum: 0 }]);
});
