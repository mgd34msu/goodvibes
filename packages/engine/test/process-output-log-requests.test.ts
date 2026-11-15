import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { ProcessOutputLog } from '../terminal-shell/src/process-output-log.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function countingOutage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake.requests;
}

test('a process whose view is not open costs no decision-model request, and its port is known at once', async () => {
  const requests = countingOutage();
  const log = new ProcessOutputLog(() => {}, 0);
  const stdout = ['  VITE ready\n', '  Local: http://localhost:5173/\n', ...Array.from({ length: 5_000 }, (_, i) => `line ${i}\n`)];
  const record = { stdout, stderr: [] as string[], done: false, identity: 'p:1' };
  log.poll(new Map([['p', record]]));
  expect(log.port('p')).toBe(5173);
  stdout.push('one more\n');
  log.poll(new Map([['p', record]]));
  await log.whenSettled();
  expect(requests).toHaveLength(0);
  expect(log.port('p')).toBe(5173);
  await log.dispose();
});

test('the open view reads its lines once; a later quiet window asks nothing again', async () => {
  const requests = countingOutage();
  const log = new ProcessOutputLog(() => {}, 0);
  const record = { stdout: ['compiling\n', 'Build failed: missing module\n'], stderr: [] as string[], done: false, identity: 'p:1' };
  log.poll(new Map([['p', record]]), Date.now(), 'p');
  await log.whenSettled();
  const asked = requests.length;
  log.poll(new Map([['p', record]]), Date.now(), 'p');
  await log.whenSettled();
  expect(requests).toHaveLength(asked);
  await log.dispose();
});

test('a failed process marks its stderr lines as errors and stops reporting a port', async () => {
  countingOutage();
  const log = new ProcessOutputLog(() => {}, 0);
  const stdout = ['listening on port 3000\n'];
  const stderr = ['Error: boom\n'];
  log.poll(new Map([['p', { stdout, stderr, done: false, identity: 'p:1' }]]));
  expect(log.port('p')).toBe(3000);
  log.poll(new Map([['p', { stdout, stderr, done: true, identity: 'p:1', failed: true }]]));
  expect(log.port('p')).toBeUndefined();
  expect(log.lines('p').find((line) => line.stream === 'stderr')?.error).toBe(true);
  await log.dispose();
});
