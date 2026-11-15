import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

import { isTransientInstallFailure, retryTransientInstall } from '../scripts/install-retry.ts';
import { useFailureReadings } from './_helpers/failure-readings.ts';

function commandError(message: string, output: { stderr?: string; stdout?: string; code?: string } = {}): Error {
  return Object.assign(new Error(message), output);
}

describe('transient install codes', () => {
  const readings = useFailureReadings([]);

  test('npm registry HTTP failures and socket timeouts are transient', async () => {
    for (const code of ['E503', 'E502', 'E500', 'E429', 'ECONNABORTED', 'ERR_SOCKET_TIMEOUT']) {
      const error = commandError('Command failed: npm install', { stderr: `npm error code ${code}\n` });
      expect(await isTransientInstallFailure(error, 'test.install')).toBe(true);
    }
    expect(readings.requests).toHaveLength(0);
  });});

describe('a codeless install failure with no judgment port', () => {
  const savedKey = process.env['TYPESAFE_API_KEY'];
  let previous: ReturnType<typeof installJudgmentPort>;
  afterEach(() => {
    installJudgmentPort(previous);
    if (savedKey === undefined) delete process.env['TYPESAFE_API_KEY'];
    else process.env['TYPESAFE_API_KEY'] = savedKey;
  });

  test('a codeless failure with no judgment port is retried once, then reported as the install error', async () => {
    previous = installJudgmentPort(undefined);
    delete process.env['TYPESAFE_API_KEY'];
    let calls = 0;
    const sleeps: number[] = [];
    const options = { prefix: 'test', label: 'bun add', site: 'test.install', sleep: async (ms: number) => { sleeps.push(ms); } };
    await retryTransientInstall(() => {
      calls += 1;
      if (calls === 1) throw commandError('Command failed: bun add', { stderr: 'error: registry unreachable' });
    }, options);
    expect(calls).toBe(2);

    const failure = commandError('Command failed: bun add', { stderr: 'error: registry unreachable' });
    calls = 0;
    await expect(retryTransientInstall(() => { calls += 1; throw failure; }, options)).rejects.toBe(failure);
    expect(calls).toBe(2);
  });});
