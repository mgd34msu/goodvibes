import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, install, interruptInstall, parseOptions, ready, stage, type InstallHooks, type Options, type ReadyTiming } from './install.ts';
import { COMMANDS, CommandError, assertOwnedFiles, atomicWrite, dataOwner, readInstallation, unitPath, uninstall, type Run } from './installation.ts';

let home: string;
let previousHome: string | undefined;
let options: Options;
let state: string;
let execute: Run;
let hooks: InstallHooks;
const COMMIT = 'a'.repeat(40);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jev-lifecycle-test-'));
  previousHome = process.env.HOME; process.env.HOME = home;
  options = parseOptions(['--no-service'], home);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  options.port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  state = 'inactive';
  execute = (command, args) => {
    if (command === 'systemctl') {
      if (args.includes('--property=FragmentPath')) return existsSync(unitPath(options)) ? unitPath(options) : '';
      if (args.includes('--property=ActiveState')) return state;
      if (args.includes('stop')) state = 'inactive';
      if (args.includes('start') || args.includes('restart')) state = 'active';
    }
    return '';
  };
  hooks = {
    execute, build: async () => COMMIT,
    stage: async (_root, release) => {
      mkdirSync(join(release, 'webui'), { recursive: true }); writeFileSync(join(release, 'webui/index.html'), '<html>test</html>');
      writeFileSync(join(release, 'payload'), 'binary');
    },
    renderUnit: async () => '[Service]\nExecStart=/owned/goodvibes-daemon serve\n',
    ready: async () => {},
  };
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const releasesOf = (): string[] => readdirSync(join(options.prefix, 'releases'));

describe('readiness check', () => {
  let server: ReturnType<typeof Bun.serve>;
  let health: { status: number; body: unknown };
  let page: string;
  let sleeps: number;
  let timing: ReadyTiming;
  const writeToken = (contents: unknown) => atomicWrite(join(options.dataDir, '.goodvibes/daemon/operator-tokens.json'), JSON.stringify(contents));
  beforeEach(() => {
    page = '<html>test</html>'; health = { status: 200, body: { network: { controlPlane: { ready: true } } } }; sleeps = 0;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response(page);
      if (path === '/api/health' && request.headers.get('authorization') === 'Bearer secret-token') return Response.json(health.body, { status: health.status });
      return new Response('unauthorized', { status: 401 });
    } });
    options.port = server.port!;
    // Time moves only when the code asks for it, so a loop that never sleeps still ends.
    let clock = 0;
    timing = { now: () => (clock += 100), sleep: async () => { sleeps++; }, timeoutMs: 5_000 };
    state = 'active';
    writeToken({ token: 'secret-token' });
  });
  afterEach(async () => { await server.stop(true); });

  test('succeeds when the service is active, serves the staged WebUI and reports the control plane ready', async () => {
    await ready(options, '<html>test</html>', execute, timing);
  });
  test('a different page body is not ready', async () => {
    page = '<html>other</html>';
    await expect(ready(options, '<html>test</html>', execute, timing)).rejects.toThrow('did not become ready');
    expect(sleeps).toBeGreaterThan(0);
  });
  test('a control plane that is not ready is not ready', async () => {
    health = { status: 200, body: { network: { controlPlane: { ready: false } } } };
    await expect(ready(options, '<html>test</html>', execute, timing)).rejects.toThrow('did not become ready');
  });
  test('a missing token file is not ready', async () => {
    rmSync(join(options.dataDir, '.goodvibes/daemon/operator-tokens.json'));
    await expect(ready(options, '<html>test</html>', execute, timing)).rejects.toThrow('did not become ready');
  });
  test('a token file without a token waits between checks instead of polling continuously', async () => {
    writeToken({});
    await expect(ready(options, '<html>test</html>', execute, timing)).rejects.toThrow('did not become ready');
    expect(sleeps).toBeGreaterThan(0);
  });
  test('a stopped service ends the wait with the journal command', async () => {
    state = 'failed';
    await expect(ready(options, '<html>test</html>', execute, timing)).rejects.toThrow('journalctl --user -u goodvibes-jev.service');
  });
});

describe('checkout build guards', () => {
  const calls: string[][] = [];
  const fake = (revisions: string[], dirty = false): Run => (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'rev-parse') return revisions.shift() ?? COMMIT;
    if (command === 'git' && args[0] === 'diff' && dirty) throw new CommandError('git', 1, undefined);
    return '';
  };
  beforeEach(() => { calls.length = 0; });
  test('refuses tracked changes before building anything', async () => {
    await expect(build(home, fake([COMMIT], true))).rejects.toThrow('Commit or stash tracked changes');
    expect(calls.some(call => call[0] === 'bun')).toBe(false);
  });
  test('refuses a checkout that has no exact commit', async () => {
    await expect(build(home, fake(['HEAD']))).rejects.toThrow('exact commit');
  });
  test('refuses a checkout whose commit moved during the build', async () => {
    await expect(build(home, fake([COMMIT, 'b'.repeat(40)]))).rejects.toThrow('Checkout changed during the build');
    expect(calls.some(call => call.includes('record'))).toBe(false);
  });
  test('returns the commit and records the artifact after a clean build', async () => {
    expect(await build(home, fake([COMMIT, COMMIT]))).toBe(COMMIT);
    expect(calls.some(call => call.includes('record') && call.includes(COMMIT))).toBe(true);
  });
});

describe('release staging', () => {
  const target = `linux-${process.arch}`;
  let root: string;
  let release: string;
  let runtimeDir: string;
  const touch = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, dirname(path)); };
  beforeEach(() => {
    root = join(home, 'checkout'); release = join(home, 'release'); runtimeDir = join(home, 'runtime');
    for (const [product, binary] of [['tui', 'goodvibes'], ['agent', 'goodvibes-agent']] as const) {
      for (const suffix of ['', '.bun', '.bun.json', '.bun.LICENSE.md']) touch(join(root, 'products', product, 'dist', `${binary}-${target}${suffix}`));
      touch(join(root, 'products', product, 'dist/lib/native.node'));
    }
    touch(join(root, 'products/webui/dist/index.html'));
    for (const product of ['daemon', 'tui', 'agent', 'webui']) touch(join(root, 'products', product, 'LICENSE'));
    touch(join(root, 'packages/engine/package.json')); writeFileSync(join(root, 'packages/engine/package.json'), '{}');
    touch(join(root, 'packages/engine/node_modules/playwright-core/index.js'));
    writeFileSync(join(root, 'packages/engine/node_modules/playwright-core/package.json'), '{"name":"playwright-core","version":"1.0.0","main":"index.js"}');
    mkdirSync(runtimeDir); writeFileSync(join(runtimeDir, 'bun'), 'bun'); writeFileSync(join(runtimeDir, 'node'), 'node');
    options = { ...options, runtimeDir, nodePath: join(runtimeDir, 'node') };
    mkdirSync(release);
    // The native installer step lays out the daemon; reproduce just the file stage reads back.
    execute = (command, args) => {
      if (command === 'bun' && args[0] === 'scripts/install-native.ts') touch(join(release, 'daemon', `goodvibes-daemon-${target}.bun.LICENSE.md`));
      return '';
    };
  });
  test('assembles daemon, clients, WebUI, browser driver, runtimes and licenses', async () => {
    await stage(root, release, options, COMMIT, execute);
    for (const path of [`tui/goodvibes-${target}`, `tui/goodvibes-${target}.bun.json`, 'tui/lib/native.node', `agent/goodvibes-agent-${target}.bun.LICENSE.md`,
      'webui/index.html', 'runtime/BUN-LICENSE.md', 'runtime/node', 'daemon/LICENSE', 'webui/LICENSE', 'tui/LICENSE', 'agent/LICENSE',
      'daemon/playwright-core/index.js', 'tui/playwright-core/index.js', 'agent/playwright-core/index.js']) {
      expect(existsSync(join(release, path))).toBe(true);
    }
    expect(statSync(join(release, 'runtime/bun')).mode & 0o111).not.toBe(0);
  });
  test('a WebUI build without index.html is refused', async () => {
    rmSync(join(root, 'products/webui/dist/index.html'));
    await expect(stage(root, release, options, COMMIT, execute)).rejects.toThrow('WebUI build did not produce index.html');
  });
  test('a missing client binary stops staging', async () => {
    rmSync(join(root, 'products/agent/dist', `goodvibes-agent-${target}.bun`));
    await expect(stage(root, release, options, COMMIT, execute)).rejects.toThrow();
  });
});

describe('releases kept for running programs', () => {
  test('a release kept for a running terminal is removed by a later update once nothing uses it', async () => {
    await install(options, hooks);
    const first = readInstallation(options.prefix)!.release;
    await install(options, { ...hooks, build: async () => 'b'.repeat(40), isReleaseInUse: () => true });
    const second = readInstallation(options.prefix)!.release;
    expect(releasesOf().sort()).toEqual([first, second].sort());
    await install(options, { ...hooks, build: async () => 'c'.repeat(40), isReleaseInUse: () => false });
    const third = readInstallation(options.prefix)!.release;
    expect(releasesOf()).toEqual([third]);
  });
  test('only releases that are still in use survive the sweep', async () => {
    await install(options, hooks);
    const first = readInstallation(options.prefix)!.release;
    await install(options, { ...hooks, build: async () => 'b'.repeat(40), isReleaseInUse: () => true });
    const second = readInstallation(options.prefix)!.release;
    await install(options, { ...hooks, build: async () => 'c'.repeat(40), isReleaseInUse: path => path.endsWith(first) });
    expect(releasesOf().sort()).toEqual([first, readInstallation(options.prefix)!.release].sort());
    expect(releasesOf()).not.toContain(second);
  });
});

describe('an update that is killed after publishing', () => {
  /** Run an update to the point of readiness, copy the prefix as it stands, let the update fail normally, and put the copy back: the state a SIGKILL would leave. */
  async function killedUpdate(): Promise<{ before: string; abandoned: string }> {
    options.service = true;
    await install(options, hooks);
    const before = readInstallation(options.prefix)!.release;
    const snapshot = join(home, 'snapshot');
    await expect(install(options, { ...hooks, build: async () => 'b'.repeat(40), ready: async () => {
      cpSync(options.prefix, snapshot, { recursive: true, verbatimSymlinks: true });
      throw new Error('killed');
    } })).rejects.toThrow('killed');
    rmSync(options.prefix, { recursive: true }); cpSync(snapshot, options.prefix, { recursive: true, verbatimSymlinks: true });
    const abandoned = releasesOf().find(name => name !== before)!;
    expect(() => assertOwnedFiles(readInstallation(options.prefix)!)).toThrow('current link has changed');
    return { before, abandoned };
  }
  test('uninstall restores the receipt release and completes', async () => {
    await killedUpdate();
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    expect(existsSync(unitPath(options))).toBe(false);
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
  });
  test('the next update recovers, then removes the abandoned release', async () => {
    const { before, abandoned } = await killedUpdate();
    await install(options, { ...hooks, build: async () => 'c'.repeat(40) });
    const receipt = readInstallation(options.prefix)!;
    expect(receipt.release).not.toBe(before);
    expect(receipt.release).not.toBe(abandoned);
    expect(releasesOf()).toEqual([receipt.release]);
    assertOwnedFiles(receipt);
  });
  test('a digest-only receipt from an earlier installer recovers without calling the new commands edited', async () => {
    await killedUpdate();
    const receipt = readInstallation(options.prefix)!;
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const previous = Object.fromEntries(COMMANDS.map(name => [name, digest(`previous ${name}`)]));
    writeFileSync(join(options.prefix, 'installation.json'), JSON.stringify({ ...receipt, schema: 1, wrappers: previous, unit: digest('previous unit') }));
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
  });
  test('a hang-up after the new receipt is saved leaves the committed update in place', async () => {
    options.service = true;
    await install(options, hooks);
    let code = -1;
    await install(options, { ...hooks, build: async () => 'b'.repeat(40), isReleaseInUse: () => { code = interruptInstall('SIGHUP'); return false; } });
    expect(code).toBe(129);
    const receipt = readInstallation(options.prefix)!;
    expect(receipt.sourceCommit).toBe('b'.repeat(40));
    expect(releasesOf()).toEqual([receipt.release]);
    assertOwnedFiles(receipt);
  });
  test('a hang-up rolls the update back and exits 129', async () => {
    options.service = true;
    await install(options, hooks);
    const before = readInstallation(options.prefix)!;
    let code = -1;
    await expect(install(options, { ...hooks, ready: async () => { code = interruptInstall('SIGHUP'); throw new Error('hung up'); } })).rejects.toThrow('hung up');
    expect(code).toBe(129);
    expect(readInstallation(options.prefix)).toEqual(before);
    assertOwnedFiles(before);
  });
});

describe('a first install that is killed outright', () => {
  test('is an ordinary receipt-owned installation that uninstall removes', async () => {
    options.service = true;
    const snapshot = join(home, 'snapshot');
    await expect(install(options, { ...hooks, ready: async () => {
      cpSync(options.prefix, snapshot, { recursive: true, verbatimSymlinks: true });
      throw new Error('killed');
    } })).rejects.toThrow('killed');
    // Put back what a SIGKILL inside the readiness wait leaves: the published release, its links and the unit.
    cpSync(snapshot, options.prefix, { recursive: true, verbatimSymlinks: true });
    for (const name of COMMANDS) symlinkSync(join(options.prefix, 'commands', name), join(options.binDir, name));
    writeFileSync(unitPath(options), readInstallation(options.prefix)!.unit);
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    expect(existsSync(unitPath(options))).toBe(false);
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
  });
  test('killed while staging, before its receipt, leaves only a release the next run removes; anything else is kept', async () => {
    const leftover = join(options.prefix, 'releases', `${'a'.repeat(40)}-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`);
    mkdirSync(join(leftover, 'daemon'), { recursive: true });
    writeFileSync(join(options.prefix, 'notes.txt'), 'mine');
    await expect(install(options, hooks)).rejects.toThrow('has no Jev installation receipt');
    expect(existsSync(leftover)).toBe(true);
    rmSync(join(options.prefix, 'notes.txt'));
    await install(options, hooks);
    expect(existsSync(leftover)).toBe(false);
    expect(readInstallation(options.prefix)).toBeDefined();
  });
});

describe('data that is already gone', () => {
  test('uninstall completes when the data directory was removed by hand', async () => {
    await install(options, hooks);
    rmSync(options.dataDir, { recursive: true });
    await uninstall(options.prefix, false, execute);
    expect(existsSync(options.prefix)).toBe(false);
    for (const name of COMMANDS) expect(existsSync(join(options.binDir, name))).toBe(false);
  });
  test('purge completes when the data directory is already gone', async () => {
    await install(options, hooks);
    rmSync(options.dataDir, { recursive: true });
    await uninstall(options.prefix, true, execute);
    expect(existsSync(options.prefix)).toBe(false);
  });
  test('an update recreates the owner marker for the same installation', async () => {
    await install(options, hooks);
    const id = readInstallation(options.prefix)!.id;
    rmSync(options.dataDir, { recursive: true });
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    expect(readInstallation(options.prefix)!.id).toBe(id);
    expect(JSON.parse(readFileSync(dataOwner(options), 'utf8')).id).toBe(id);
  });
  test('a data directory that exists without this installation marker is still refused', async () => {
    await install(options, hooks);
    rmSync(dataOwner(options));
    await expect(uninstall(options.prefix, true, execute)).rejects.toThrow('does not belong');
    expect(existsSync(options.dataDir)).toBe(true);
    expect(existsSync(options.prefix)).toBe(true);
  });
});

describe('credentials file on a repeat install', () => {
  let key: string | undefined;
  let warnings: string[];
  let warn: typeof console.warn;
  beforeEach(() => {
    key = process.env.TYPESAFE_API_KEY; warnings = []; warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  });
  afterEach(() => {
    console.warn = warn;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  });
  test('an exported key does not overwrite an existing file, and the install says so', async () => {
    delete process.env.TYPESAFE_API_KEY;
    await install(options, hooks);
    const file = join(options.dataDir, 'environment');
    const before = readFileSync(file, 'utf8');
    expect(before).not.toContain("TYPESAFE_API_KEY='");
    process.env.TYPESAFE_API_KEY = 'synthetic-new-value';
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(warnings.join('\n')).toContain(file);
    expect(warnings.join('\n')).not.toContain('synthetic-new-value');
  });
  test('a file that already has a key is not reported', async () => {
    delete process.env.TYPESAFE_API_KEY;
    await install(options, hooks);
    atomicWrite(join(options.dataDir, 'environment'), "TYPESAFE_API_KEY='kept'\n");
    process.env.TYPESAFE_API_KEY = 'synthetic-new-value';
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    expect(warnings.join('\n')).not.toContain('already exists');
  });
});

describe('uninstall.sh without a checkout or receipt', () => {
  /** Run a lone copy of uninstall.sh with a curl stand-in that records the address it was asked for. */
  function run(env: Record<string, string>): { status: number | null; stderr: string; requested: string } {
    const folder = join(home, 'lone'), bin = join(home, 'fake-bin'), seen = join(home, 'requested');
    mkdirSync(join(folder, 'scripts'), { recursive: true }); mkdirSync(bin, { recursive: true });
    copyFileSync(join(import.meta.dir, 'uninstall.sh'), join(folder, 'scripts/uninstall.sh'));
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nfor a in "$@"; do case "$a" in https://*) printf '%s' "$a" > '${seen}' ;; esac; done\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done\n`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', [join(folder, 'scripts/uninstall.sh')], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: home, ...env }, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr, requested: existsSync(seen) ? readFileSync(seen, 'utf8') : '' };
  }
  test('fetches the main script by default', () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.requested).toBe('https://raw.githubusercontent.com/mgd34msu/goodvibes/main/scripts/install.sh');
  });
  test('GOODVIBES_VERSION selects that release script', () => {
    const result = run({ GOODVIBES_VERSION: 'v3.2.0' });
    expect(result.status).toBe(0);
    expect(result.requested).toBe('https://raw.githubusercontent.com/mgd34msu/goodvibes/v3.2.0/scripts/install.sh');
  });
  test('a version that is not a release tag is refused before any download', () => {
    const result = run({ GOODVIBES_VERSION: 'main' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must look like v3.2.0');
    expect(result.requested).toBe('');
  });
});
