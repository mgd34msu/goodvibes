import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ProcessOutputLog } from '../../core/process-output-log.ts';
import { makeProcessOutputReadingFixture } from '../helpers/process-output-reading.ts';

const logs: ProcessOutputLog[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(makeProcessOutputReadingFixture(['error TS2345: bad'], []).port); });
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.dispose())); installJudgmentPort(previous); });

test('settled readings of a long-running process keep one retained-authority check, not one per reading', async () => {
  const log = new ProcessOutputLog(() => {}, 0); logs.push(log);
  const stdout: string[] = []; const stderr: string[] = [];
  const records = new Map([['p', { stdout, stderr, done: false }]]);
  for (let round = 0; round < 6; round++) {
    stdout.push(`line ${round}\n`);
    log.poll(records, round);
    await log.whenSettled();
  }
  expect(log.lines('p')).toHaveLength(6);
  const entries = (log as unknown as { entries: Map<string, { authorities: Set<unknown> }> }).entries;
  expect(entries.get('p')!.authorities.size).toBe(1);
});
