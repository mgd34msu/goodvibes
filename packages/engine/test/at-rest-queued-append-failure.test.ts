import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { AtRestLineWriter, clearAtRestCredentialReadings } from '../platform/src/platform/runtime/at-rest-persistence.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  clearAtRestCredentialReadings();
});
afterEach(() => {
  installJudgmentPort(previous);
  clearAtRestCredentialReadings();
});

const CREDENTIAL_SHAPED = 'key-rotation-policy-for-tenants';

test('flush rejects when a queued line could not be appended, once, and then recovers', async () => {
  const writer = new AtRestLineWriter('test.at-rest-queued-failure');
  const written: string[] = [];
  // The first line waits for a credential reading, so the second is queued behind it.
  writer.write(JSON.stringify({ body: CREDENTIAL_SHAPED }), (line) => written.push(line));
  writer.write('{"body":"plain"}', () => { throw new Error('disk full'); });
  await expect(writer.flush()).rejects.toThrow('1 queued line(s) could not be written');
  expect(written).toHaveLength(1);

  writer.write('{"body":"later"}', (line) => written.push(line));
  await writer.flush();
  expect(written).toHaveLength(2);
});
