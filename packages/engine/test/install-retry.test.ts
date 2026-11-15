import { describe, expect, test } from 'bun:test';

import { installErrorCode, isTransientInstallFailure, retryTransientInstall } from '../scripts/install-retry.ts';

function commandError(message: string, output: { stderr?: string; stdout?: string; code?: string } = {}): Error {
  return Object.assign(new Error(message), output);
}

const options = { prefix: 'test', label: 'bun add', sleep: async () => {} };

describe('install retry', () => {
  test('the code npm prints or the spawn error carries decides', () => {
    expect(installErrorCode(commandError('spawn npm ENOENT', { code: 'ENOENT' }))).toBe('ENOENT');
    expect(installErrorCode(commandError('npm install', { stderr: 'npm ERR! code ETIMEDOUT\n' }))).toBe('ETIMEDOUT');
    for (const code of ['E503', 'E429', 'ECONNRESET', 'ERR_SOCKET_TIMEOUT']) {
      expect(isTransientInstallFailure(commandError('npm install', { stderr: `npm error code ${code}\n` }))).toBe(true);
    }
    expect(isTransientInstallFailure(commandError('npm install', { stderr: 'npm error code E404\n' }))).toBe(false);
  });

  test('a coded non-transient failure is thrown after one attempt', async () => {
    let calls = 0;
    const failure = commandError('npm install', { stderr: 'npm error code EINTEGRITY\n' });
    await expect(retryTransientInstall(() => { calls += 1; throw failure; }, options)).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test('a codeless failure is tried three times and the install error is thrown', async () => {
    let calls = 0;
    const failure = commandError('bun add', { stderr: 'error: ConnectionRefused downloading package manifest zod' });
    await expect(retryTransientInstall(() => { calls += 1; throw failure; }, options)).rejects.toBe(failure);
    expect(calls).toBe(3);
  });
});
