// Proves: A remote command's payload swaps the program that runs under an allowed name (PATH, LD_PRELOAD, NODE_OPTIONS, a proxy).
// Red when: A program-choosing variable is passed through to a backend.
// Proves: A backend with a command list runs a command that is not on it, or the payload's directory supplies the program.
// Red when: The local-process backend stops checking the executable against its list, or finds the program from the payload's directory instead of the registered one.
/**
 * A remote command's payload cannot swap the program that runs under an
 * allowed name: environment variables that choose the program or what it
 * loads (PATH, LD_PRELOAD, NODE_OPTIONS, DOCKER_HOST, a proxy) are refused
 * before any backend sees them; an ordinary variable passes.
 *
 * The real payload reader every backend dispatch goes through.
 *
 * A local-process backend runs on the daemon's host, outside the exec sandbox,
 * so its command list is the whole boundary: the real backend host over a temp
 * registry refuses a command that is not on the list, and finds a listed
 * program in the registered directory even when the payload names another
 * directory holding a program of the same name.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteBackendHost, readBackendPayload } from '../platform/src/platform/runtime/remote/host/backend-host.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('payload env that changes which program runs is refused; ordinary env passes', () => {
  for (const name of ['PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BUN_INSTALL', 'GIT_SSH_COMMAND', 'DOCKER_HOST', 'https_proxy']) {
    expect(() => readBackendPayload({ env: { [name]: '/tmp/elsewhere' } })).toThrow(name);
  }
  expect(readBackendPayload({ env: { GREETING: 'hello' } })?.env).toEqual({ GREETING: 'hello' });
});

test('a backend runs only the commands on its list, and finds them where it was registered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-backend-list-'));
  dirs.push(root);
  const program = (dir: string, body: string): void => {
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'report'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, 'tools', 'report'), 0o755);
  };
  const registered = join(root, 'registered'), payloadDir = join(root, 'payload');
  program(registered, 'echo registered-report');
  program(payloadDir, `touch ${join(root, 'payload-program-ran')}`);
  const quiet = { info() {}, warn() {}, error() {} };
  const host = createRemoteBackendHost({ workingDirectory: join(root, 'project'), homeDirectory: root, credentials: { resolveRef: async () => null }, logger: quiet });
  try {
    await host.register({ peerId: 'builder', backendKind: 'local-process', backendConfig: { cwd: registered, allowedCommands: ['tools/report'] } });
    const unlisted = await host.invoke({ peerId: 'builder', command: `touch ${join(root, 'unlisted-ran')}` }).then(() => 'ran', (error: { code?: string }) => error.code);
    const listed = await host.invoke({ peerId: 'builder', command: 'tools/report', payload: { cwd: payloadDir } });
    expect({ unlisted, unlistedRan: existsSync(join(root, 'unlisted-ran')), stdout: listed.stdout.trim(), payloadProgramRan: existsSync(join(root, 'payload-program-ran')) })
      .toEqual({ unlisted: 'REMOTE_BACKEND_COMMAND_DENIED', unlistedRan: false, stdout: 'registered-report', payloadProgramRan: false });
  } finally { await host.close(); }
});
