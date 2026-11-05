import { expect, test } from 'bun:test';
import { defineBattery, fanOut, readingsOf, SqliteDecisionLog, STAKES_BANDS, withDecisionLog, yesNo } from '../src/index.ts';
import { fakePort, noulAnswer } from '../src/testing/fake-port.ts';

const effect = defineBattery({
  name: 'test.selected-effect', version: 2, description: 'Selected effects', accuracyFloor: 1,
  items: { mutates: yesNo('Changes state?', STAKES_BANDS.medium.yesNo), optional: yesNo('Optional?', STAKES_BANDS.high.yesNo) },
  fixtures: [{ name: 'write', state: 'write', expect: { mutates: 'yes', optional: 'no' } }],
});
const boundary = defineBattery({
  name: 'test.selected-boundary', version: 3, description: 'Selected boundary', accuracyFloor: 1,
  items: { catastrophic: yesNo('Catastrophic?', STAKES_BANDS.high.yesNo) },
  fixtures: [{ name: 'ordinary', state: 'write', expect: { catastrophic: 'no' } }],
});

test('selected independent questions share one request and preserve originating battery versions', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort(name => noulAnswer(name === 'effect__mutates' ? 0.99 : 0.01));
  const run = await fanOut(withDecisionLog(fake.port, log), { operation: 'write' }, { effect, boundary }, {
    only: { effect: ['mutates'] }, site: 'test.shared-gate',
  });
  expect(fake.requests).toHaveLength(1);
  expect(Object.keys(fake.requests[0]!.questions)).toEqual(['effect__mutates', 'boundary__catastrophic']);
  expect(run.readings.effect.mutates.verdict).toBe('yes');
  expect(Object.hasOwn(run.readings.effect, 'optional')).toBe(false);
  expect(run.readings.boundary.catastrophic.verdict).toBe('no');
  expect(readingsOf(log.get(run.decisionId!)!)).toMatchObject({
    readings: { effect: { mutates: { verdict: 'yes' } }, boundary: { catastrophic: { verdict: 'no' } } },
    batteries: [
      { part: 'effect', name: effect.name, version: 2, questions: ['mutates'] },
      { part: 'boundary', name: boundary.name, version: 3, questions: ['catastrophic'] },
    ],
  });
  expect(log.query({ outcome: 'act' })).toHaveLength(1);
});

test('invalid subsets fail before any transmission', async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  for (const only of [{ effect: [] }, { effect: ['mutates', 'mutates'] }, { effect: ['unknown'] }, { absent: ['mutates'] }]) {
    await expect(fanOut(fake.port, 'state', { effect, boundary }, { only: only as never })).rejects.toBeInstanceOf(RangeError);
  }
  expect(fake.requests).toHaveLength(0);
});

test('cancellation prevents a late borrowed answer from becoming a recorded conclusion', async () => {
  const controller = new AbortController();
  const fake = fakePort(() => {
    controller.abort(new Error('cancelled while the borrowed transport answered'));
    return noulAnswer(0.99);
  });
  let readings = 0;
  await expect(fanOut({ ...fake.port, async ask(request) {
    const result = await fake.port.ask(request);
    return { ...result, decisionId: 'synthetic-decision' };
  }, recorder: { recordReadings() { readings++; }, recordAction() {} } }, 'state', { effect }, {
    only: { effect: ['mutates'] }, signal: controller.signal,
  })).rejects.toThrow('cancelled');
  expect(readings).toBe(0);
});
