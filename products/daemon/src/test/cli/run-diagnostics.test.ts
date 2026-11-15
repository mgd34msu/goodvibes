import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDaemonCli, type DaemonCliOptions } from '../../cli/run.js';
import { DAEMON_COMMANDS } from '../../cli/command-catalog.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(argv: readonly string[], options: DaemonCliOptions = {}) {
  const root = makeOwnedTempDir('daemon-run-diagnostics'); roots.push(root);
  const stdout: string[] = []; const stderr: string[] = [];
  const env = { HOME: join(root, 'home'), GOODVIBES_HOME: join(root, 'tree'), GOODVIBES_DAEMON_HOME: join(root, 'daemon') };
  const code = await runDaemonCli(argv, { env, cwd: root, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), ...options });
  return { code, stdout, stderr };
}
const composedRuntime = { inboxFactory: () => { throw new Error('unused'); } } as unknown as NonNullable<DaemonCliOptions['runtime']>;

describe('a refused service activation says why and what to do', () => {
  test('an installation ownership guard prints a fixed reason and next step', async () => {
    const result = await run(['install-service'], {
      runtime: composedRuntime,
      resolveServiceExecutable: () => { throw new Error('Running daemon does not own the installed native version'); },
    });
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe('Daemon command failed');
    expect(result.stderr[1]).toContain('INSTALLATION_NOT_OWNED');
    expect(result.stderr[1]).toContain('installer');
  });

  test.each([
    ['Original compiled Darwin daemon selection is unavailable', 'INSTALLATION_NOT_OWNED'],
    ['Running Darwin daemon does not own a complete verified installation', 'INSTALLATION_NOT_OWNED'],
    ['Darwin daemon reader profile differs from its actual compiled readers', 'INSTALLATION_UNAVAILABLE'],
    ['Darwin daemon installation has an unfinished transaction', 'INSTALLATION_UNSETTLED'],
  ])('the macOS guard "%s" prints %s', async (message, code) => {
    const result = await run(['install-service'], {
      runtime: composedRuntime,
      resolveServiceExecutable: () => { throw new Error(message); },
    });
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe('Daemon command failed');
    expect(result.stderr[1]).toContain(code);
  });

  test('any other exception text stays out of the output', async () => {
    const result = await run(['install-service'], {
      runtime: composedRuntime,
      resolveServiceExecutable: () => { throw new Error('PRIVATE_CONFIG_VALUE'); },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual(['Daemon command failed']);
  });
});

describe('help is true of the binary it describes', () => {
  test('a composed binary does not claim it cannot serve', async () => {
    const composed = await run(['--help'], { runtime: composedRuntime });
    expect(composed.stdout.join('\n')).not.toContain('Serving requires');
    const partial = await run(['--help']);
    expect(partial.stdout.join('\n')).toContain('Serving requires');
  });

  test('every passthrough command answers the --help its page advertises', async () => {
    const passthrough = DAEMON_COMMANDS.filter((spec) => spec.passthrough);
    expect(passthrough.length).toBeGreaterThan(0);
    for (const { name, passthroughFlags } of passthrough) {
      const page = await run(['help', name]);
      // A command that does not answer --help is not told to the reader as if it did.
      expect(page.stdout.join('\n').includes(`${name} --help`)).toBe(passthroughFlags?.some((flag) => flag.tokens.includes('--help')) === true);
      if (name === 'check-install-reader') continue;
      const direct = await run([name, '--help']);
      expect(direct.code).toBe(0);
      expect(direct.stdout.join('\n')).toContain('Usage:');
    }
  });
});

test('install-service refuses an endpoint flag and names the supported way to set the binding', async () => {
  const result = await run(['install-service', '--port', '4000']);
  expect(result.code).toBe(2);
  expect(result.stderr.join('\n')).toContain('config set controlPlane.host');
});
