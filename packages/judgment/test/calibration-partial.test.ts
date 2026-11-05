import { expect, test } from 'bun:test';
import { calibrate, defineBattery, SqliteDecisionLog, STAKES_BANDS, truthOf, withDecisionLog, yesNo, type DecisionLog } from '../src/index.ts';
import { fakePort, noulAnswer } from '../src/testing/fake-port.ts';

const battery = defineBattery({
  name: 'test.partial-calibration', version: 1, description: 'Retain completed fixture observations', accuracyFloor: 1,
  items: { supported: yesNo('Is the fixture supported?', STAKES_BANDS.medium.yesNo) },
  fixtures: ['first', 'second', 'third'].map(name => ({ name, state: name, expect: { supported: 'yes' as const } })),
});
const endpoint = { kind: 'test', baseURL: 'https://calibration.test' };

test('a later fixture failure preserves earlier checks and truth without passing calibration', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((_name, _question, state) => {
    if (state === 'second') throw new Error('synthetic provider failure');
    return noulAnswer(0.99);
  });
  const report = await calibrate(withDecisionLog(fake.port, log), [battery], { endpoint, log });
  const decision = report.decisions[0]!;
  expect(report.passed).toBe(false);
  expect(decision.passed).toBe(false);
  expect(decision.accuracy).toBe(1);
  expect(decision.checks).toHaveLength(1);
  expect(decision.checks[0]).toMatchObject({ fixture: 'first', correct: true });
  expect(decision.truthRecorded).toBe(1);
  if (decision.error === undefined) throw new Error('Expected the failed fixture to disclose its error');
  expect(decision.fixtureExecutions).toEqual([
    { fixture: 'first', status: 'completed' },
    { fixture: 'second', status: 'failed', error: decision.error },
    { fixture: 'third', status: 'not-run' },
  ]);
  const first = log.query({ status: 'answered' })[0]!;
  expect(truthOf(first)).toEqual({ source: 'fixture', checks: decision.checks });
  expect(fake.requests).toHaveLength(2);
});

test('cancellation preserves only completed fixtures and never sends later fixtures', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const controller = new AbortController();
  const fake = fakePort((_name, _question, state) => {
    if (state === 'second') {
      controller.abort(new Error('synthetic cancellation'));
      throw controller.signal.reason;
    }
    return noulAnswer(0.99);
  });
  const report = await calibrate(withDecisionLog(fake.port, log), [battery], { endpoint, log, signal: controller.signal });
  const decision = report.decisions[0]!;
  expect(report.passed).toBe(false);
  expect(decision.passed).toBe(false);
  expect(decision.checks.map(check => check.fixture)).toEqual(['first']);
  expect(decision.fixtureExecutions?.map(fixture => [fixture.fixture, fixture.status])).toEqual([
    ['first', 'completed'], ['second', 'cancelled'], ['third', 'not-run'],
  ]);
  expect(decision.truthRecorded).toBe(1);
  expect(fake.requests).toHaveLength(2);
});

test('already cancelled fixture runs report every fixture without transmitting', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancel before fixture execution'));
  const fake = fakePort(() => noulAnswer(0.99));
  const report = await calibrate(fake.port, [battery], { endpoint, signal: controller.signal });
  expect(report.passed).toBe(false);
  expect(report.decisions[0]?.fixtureExecutions?.map(fixture => fixture.status)).toEqual(['cancelled', 'not-run', 'not-run']);
  expect(fake.requests).toHaveLength(0);
});

test('a fixture-truth write failure preserves observations and fails without retrying retention', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let truthWrites = 0;
  const failingTruthLog: DecisionLog = {
    record: entry => log.record(entry),
    get: id => log.get(id),
    query: query => log.query(query),
    attach(id, note) {
      if (note.kind === 'truth') { truthWrites++; throw new Error('synthetic truth write failure'); }
      log.attach(id, note);
    },
  };
  const fake = fakePort(() => noulAnswer(0.99));
  const report = await calibrate(withDecisionLog(fake.port, failingTruthLog), [battery], { endpoint, log: failingTruthLog });
  expect(report.passed).toBe(false);
  expect(report.decisions[0]).toMatchObject({ passed: false, accuracy: 1, error: 'Error: synthetic truth write failure' });
  expect(report.decisions[0]?.checks).toHaveLength(3);
  expect(report.decisions[0]?.truthRecorded).toBeUndefined();
  expect(truthWrites).toBe(1);
  expect(fake.requests).toHaveLength(3);
});
