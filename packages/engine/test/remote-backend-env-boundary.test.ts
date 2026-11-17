/**
 * A remote command's payload cannot swap the program that runs under an
 * allowed name: environment variables that choose the program or what it
 * loads (PATH, LD_PRELOAD, NODE_OPTIONS, DOCKER_HOST, a proxy) are refused
 * before any backend sees them; an ordinary variable passes.
 *
 * The real payload reader every backend dispatch goes through.
 */
import { expect, test } from 'bun:test';
import { readBackendPayload } from '../platform/src/platform/runtime/remote/host/backend-host.js';

test('payload env that changes which program runs is refused; ordinary env passes', () => {
  for (const name of ['PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BUN_INSTALL', 'GIT_SSH_COMMAND', 'DOCKER_HOST', 'https_proxy']) {
    expect(() => readBackendPayload({ env: { [name]: '/tmp/elsewhere' } })).toThrow(name);
  }
  expect(readBackendPayload({ env: { GREETING: 'hello' } })?.env).toEqual({ GREETING: 'hello' });
});
