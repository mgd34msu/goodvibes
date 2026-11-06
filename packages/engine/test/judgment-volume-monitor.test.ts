import { expect, test } from 'bun:test';
import { SqliteDecisionLog, createSystemOnePort, withDecisionLog, noul } from '@goodvibes-jev/judgment';
import {
  captureJudgmentVolumeMonitorSettings,
  startJudgmentVolumeMonitor,
  type JudgmentVolumeAlert,
} from '../sdk/src/platform/observe/judgment-volume-monitor.ts';

const settings = captureJudgmentVolumeMonitorSettings({
  budgets: [{ name: 'classification window', maxLogicalDecisions: 0 }],
  windowMs: 60_000,
});
async function fixture() {
  const log = new SqliteDecisionLog(':memory:');
  const port = withDecisionLog(
    createSystemOnePort({
      timeoutMs: 1000,
      retry: {},
      model: 'jev-latest',
      endpoint: { kind: 'local', baseURL: 'http://localhost:19', authentication: 'none', apiKey: '' },
      fetch: async () =>
        Response.json({ model: 'jev-latest', answers: { ok: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
    }),
    log,
  );
  const begin = Date.now();
  await port.ask({
    state: 'synthetic secret payload must not enter an alert',
    questions: { ok: noul('Is this a fixture?') },
    signal: new AbortController().signal,
    context: { site: 'monitor.fixture', battery: 'test.monitor' },
  });
  return { log, begin };
}
test('recurring checks alert once per incident, recover with the rolling window, and stop before log closure', async () => {
  const { log, begin } = await fixture();
  const alerts: JudgmentVolumeAlert[] = [];
  let now = Date.now() + 1,
    reads = 0;
  using monitor = startJudgmentVolumeMonitor({
    log: {
      query: (query) => {
        reads++;
        return log.query(query);
      },
    },
    settings,
    now: () => now,
    notify: (alert) => alerts.push(alert),
  });
  monitor.check();
  monitor.check();
  expect(alerts.map((alert) => alert.kind)).toEqual(['budget-exceeded']);
  expect(JSON.stringify(alerts)).not.toContain('synthetic secret');
  now = begin + 120_000;
  monitor.check();
  monitor.check();
  expect(alerts.map((alert) => alert.kind)).toEqual(['budget-exceeded', 'recovered']);
  monitor.dispose();
  const before = reads;
  log[Symbol.dispose]();
  monitor.check();
  expect(reads).toBe(before);
});
test('incomplete windows and unavailable storage cannot produce a healthy budget report', async () => {
  const { log } = await fixture();
  const entries = log.query();
  const alerts: JudgmentVolumeAlert[] = [];
  let fail = false;
  using monitor = startJudgmentVolumeMonitor({
    settings: { ...settings, limit: 1 },
    log: {
      query: () => {
        if (fail) throw new Error('synthetic secret');
        return [...entries, ...entries];
      },
    },
    notify: (alert) => alerts.push(alert),
  });
  monitor.check();
  fail = true;
  monitor.check();
  expect(alerts.map((alert) => alert.kind)).toEqual(['incomplete-window', 'unavailable']);
  expect(JSON.stringify(alerts)).not.toContain('synthetic secret');
  log[Symbol.dispose]();
});
test('observer reentrancy is bounded and failed alert delivery retries on the next check', async () => {
  const { log } = await fixture();
  let reads = 0,
    deliveries = 0;
  using monitor = startJudgmentVolumeMonitor({
    settings,
    log: {
      query: (query) => {
        reads++;
        return log.query(query);
      },
    },
    now: () => Date.now() + 1,
    notify: () => {
      deliveries++;
      monitor.check();
      if (deliveries === 1) throw new Error('unavailable sink');
    },
  });
  monitor.check();
  monitor.check();
  expect(reads).toBe(2);
  expect(deliveries).toBe(2);
  log[Symbol.dispose]();
});
test('monitoring settings reject empty/unbounded budgets and timer overflow', () => {
  for (const value of [
    { budgets: [] },
    { budgets: settings.budgets, intervalMs: Infinity },
    { budgets: settings.budgets, intervalMs: 2 ** 31 },
    { budgets: settings.budgets, limit: 0 },
    { budgets: settings.budgets, accuracyFloor: 0.95 },
  ])
    expect(() => captureJudgmentVolumeMonitorSettings(value)).toThrow();
});

test('the recurring timer runs without manual checks and stops with disposal', async () => {
  let reads = 0;
  let observed: (() => void) | undefined;
  const tick = new Promise<void>(resolve => { observed = resolve; });
  using monitor = startJudgmentVolumeMonitor({ settings: { ...settings, intervalMs: 1000 }, log: {query: () => {reads++;observed?.();return [];}}, notify: () => {} });
  await Promise.race([tick, Bun.sleep(2500).then(() => {throw new Error('The recurring monitor did not run.');})]);
  monitor.dispose(); const before = reads;
  await Bun.sleep(1100);
  expect(reads).toBe(before);
}, 5000);
