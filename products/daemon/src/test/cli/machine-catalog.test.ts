import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_COMMANDS } from '../../cli/command-catalog.ts';
import { renderDaemonCliCatalog } from '../../cli/help.ts';
import { WEBUI_BINDING_QUERY, WEBUI_BINDING_RESULT } from '../../cli/machine-contracts.ts';
import { parseDaemonCli } from '../../cli/parser.ts';
import { runDaemonCli } from '../../cli/run.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';
import { NATIVE_READER_REQUIREMENT_FILE } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { VERSION } from '../../version.js';

async function invoke(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  const stdout: string[] = []; const stderr: string[] = [];
  const code = await runDaemonCli(args, { env, cwd, stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); } });
  return { code, stdout, stderr };
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      result[path] = readFileSync(path, 'utf8');
    }
  }
  return result;
}

describe('machine help is the canonical CLI capability contract', () => {
  test('catalog exactly projects producer command and query identities', () => {
    expect(JSON.parse(renderDaemonCliCatalog())).toEqual({
      schema: 'goodvibes.daemon.cli-catalog', schemaVersion: 1,
      commands: DAEMON_COMMANDS.map(({ name, subcommands, machineQueries = [] }) => ({ name, subcommands, machineQueries })),
    });
    expect(DAEMON_COMMANDS.find((command) => command.name === 'webui')?.machineQueries).toEqual([WEBUI_BINDING_QUERY]);
  });

  for (const args of [['--help', '--json'], ['help', '--json']]) {
    test(`${args.join(' ')} emits only one JSON document without acquiring config`, async () => {
      const env = new Proxy({}, { ownKeys() { throw new Error('must not acquire config'); } });
      const parsed = parseDaemonCli(args);
      expect(parsed.errors).toEqual([]); expect(parsed.command).toBe('help'); expect(parsed.flags.json).toBe(true);
      expect(await invoke(args, env)).toEqual({ code: 0, stdout: [renderDaemonCliCatalog()], stderr: [] });
    });
  }

  test('JSON does not become a serve flag, and topic JSON does not masquerade as a catalog', async () => {
    expect(parseDaemonCli(['serve', '--json']).errors.length).toBeGreaterThan(0);
    expect(parseDaemonCli(['--json']).errors.length).toBeGreaterThan(0);
    const result = await invoke(['help', 'webui', '--json']);
    expect(result.code).toBe(2); expect(result.stdout).toEqual([]);
  });

  test('ordinary top-level and command help remain prose', async () => {
    for (const args of [['--help'], ['help', 'webui']]) {
      const result = await invoke(args);
      expect(result.code).toBe(0); expect(result.stdout[0]).toStartWith('Usage: goodvibes-daemon');
      expect(result.stderr).toEqual([]);
    }
  });
});

describe('release reader inspection never initializes settings or a runtime', () => {
  test('an installation without new data requirements permits its early reader without creating files', async () => {
    const root = makeOwnedTempDir('daemon-reader-inspect-empty'); const before = files(root);
    let constructions = 0; const stdout: string[] = []; const stderr: string[] = [];
    const env = new Proxy({}, { ownKeys() { throw new Error('Reader inspection must not acquire configuration'); } });
    const code = await runDaemonCli(['check-install-reader', join(root, 'goodvibes-daemon')], {
      env, cwd: root, stdout: line => stdout.push(line), stderr: line => stderr.push(line),
      async createRuntime() { constructions++; throw new Error('Reader inspection must not construct a runtime'); },
    });
    expect(code).toBe(0); expect(constructions).toBe(0); expect(stderr).toEqual([]);
    expect(stdout).toEqual([JSON.stringify({ schema: 'goodvibes.install.reader-check', schemaVersion: 1, readerVersion: VERSION })]);
    expect(files(root)).toEqual(before); expect(readdirSync(root)).toEqual([]);
  });

  test.each([['3.1.2', 0], ['3.2.0', 2]] as const)('the actual reader checks floor %s and emits no false success', async (minimumReader, code) => {
    const root = makeOwnedTempDir('daemon-reader-inspect-floor');
    writeFileSync(join(root, NATIVE_READER_REQUIREMENT_FILE), JSON.stringify({ schema: 1, minimumReader, formats: ['payment-retained-holds-v2'] }));
    const before = files(root); const output = await invoke(['check-install-reader', join(root, 'goodvibes-daemon')], { HOME: root }, root);
    expect(output.code).toBe(code); expect(files(root)).toEqual(before);
    if (code === 0) expect(JSON.parse(output.stdout[0] ?? '{}')).toMatchObject({ readerVersion: VERSION });
    else { expect(output.stdout).toEqual([]); expect(output.stderr.join('')).toContain('requires GoodVibes 3.2.0'); }
  });

  test('malformed stored content stays private and intact', async () => {
    const root = makeOwnedTempDir('daemon-reader-inspect-damaged');
    const original = 'private original data not valid JSON'; writeFileSync(join(root, NATIVE_READER_REQUIREMENT_FILE), original);
    const before = files(root); const output = await invoke(['check-install-reader', join(root, 'goodvibes-daemon')], { HOME: root }, root);
    expect(output.code).toBe(2); expect(output.stdout).toEqual([]); expect(output.stderr.join('')).not.toContain(original);
    expect(files(root)).toEqual(before);
  });

  test.each([[], ['relative'], ['/tmp/target', 'extra'], ['--help']].map(args => ({ args })))('invalid reader arguments $args cannot fall through to runtime activation', async ({ args }) => {
    const root = makeOwnedTempDir('daemon-reader-inspect-invalid');
    const output = await invoke(['check-install-reader', ...args], { HOME: root }, root);
    expect(output.code).toBe(2); expect(output.stdout).toEqual([]); expect(readdirSync(root)).toEqual([]);
  });
});

describe('machine WebUI discovery never initializes or migrates settings', () => {
  test('inspection and invalid commands never construct the service runtime', async () => {
    const root = makeOwnedTempDir('daemon-inspection-no-runtime');
    const env = { HOME: root, GOODVIBES_HOME: root, GOODVIBES_DAEMON_HOME: join(root, 'daemon') };
    let constructions = 0;
    for (const [args, expected] of [
      [['--help', '--json'], 0], [['version'], 0], [['webui', 'status', '--json'], 0], [['install-servce'], 2],
    ] as const) {
      expect(await runDaemonCli(args, { env, cwd: root, stdout() {}, stderr() {},
        async createRuntime() { constructions++; throw new Error('Inspection must not construct a runtime'); },
      })).toBe(expected);
    }
    expect(constructions).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  test('an empty home stays empty, with an explicitly configured endpoint receipt', async () => {
    const root = makeOwnedTempDir('daemon-webui-machine-empty');
    const home = join(root, 'home'); const daemon = join(root, 'daemon'); const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    const result = await invoke(['webui', 'status', '--json'], { HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemon }, cwd);
    expect(result.code).toBe(0); expect(result.stderr).toEqual([]); expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({ ...WEBUI_BINDING_RESULT, host: '127.0.0.1', port: 3423 });
    expect(readdirSync(home)).toEqual([]); expect(readdirSync(cwd)).toEqual([]); expect(existsSync(daemon)).toBe(false);
  });

  test('configured daemon tier wins while every settings byte remains unchanged', async () => {
    const root = makeOwnedTempDir('daemon-webui-machine-settings');
    const home = join(root, 'home'); const daemon = join(root, 'daemon'); const cwd = join(root, 'work');
    mkdirSync(join(home, '.goodvibes', 'tui'), { recursive: true }); mkdirSync(daemon); mkdirSync(cwd);
    writeFileSync(join(home, '.goodvibes', 'tui', 'settings.json'), JSON.stringify({ web: { port: 44323 }, features: { obsolete: true } }));
    writeFileSync(join(daemon, 'settings.json'), JSON.stringify({
      web: { enabled: true, hostMode: 'custom', host: '127.0.0.2', port: 44324, publicBaseUrl: 'https://fixture.example' },
      controlPlane: { hostMode: 'local', port: 44321, webui: { serve: true } },
    }));
    const before = files(root);
    const result = await invoke(['webui', 'status', '--json'], { HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemon }, cwd);
    expect(result.code).toBe(0); expect(result.stderr).toEqual([]);
    expect(JSON.parse(result.stdout[0]!)).toEqual({ ...WEBUI_BINDING_RESULT, enabled: true,
      hostMode: 'custom', configuredHost: '127.0.0.2', host: '127.0.0.2', port: 44324, url: 'https://fixture.example' });
    expect(files(root)).toEqual(before);
  });

  test.each([
    ['enable', '--json', '--bundle-dir', '/fixture/bundle'], ['disable', '--json'],
    ['status', '--json', '--lan'], ['status', '--json', '--loopback'],
    ['status', '--json', '--bundle-dir', '/fixture/bundle'], ['status', '--json', '--unknown'],
  ].map((args) => ({ args })))('refused machine invocations never initialize settings: %j', async ({ args }) => {
    const root = makeOwnedTempDir('daemon-webui-machine-refusal');
    const home = join(root, 'home'); const daemon = join(root, 'daemon'); const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(cwd);
    const result = await invoke(['webui', ...args], { HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemon }, cwd);
    expect(result.code).toBe(2); expect(result.stdout).toEqual([]);
    expect(readdirSync(home)).toEqual([]); expect(readdirSync(cwd)).toEqual([]); expect(existsSync(daemon)).toBe(false);
  });

  test('corrupt settings refuse without replacing or migrating them', async () => {
    const root = makeOwnedTempDir('daemon-webui-machine-corrupt');
    const home = join(root, 'home'); const daemon = join(root, 'daemon'); const cwd = join(root, 'work');
    mkdirSync(home); mkdirSync(daemon); mkdirSync(cwd);
    const path = join(daemon, 'settings.json');
    writeFileSync(path, 'not valid JSON');
    const before = files(root);
    const result = await invoke(['webui', 'status', '--json'], { HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemon }, cwd);
    expect(result.code).not.toBe(0); expect(result.stdout).toEqual([]);
    expect(files(root)).toEqual(before); expect(readdirSync(daemon)).toEqual(['settings.json']);
    expect(readdirSync(home)).toEqual([]); expect(readdirSync(cwd)).toEqual([]);
  });
});
