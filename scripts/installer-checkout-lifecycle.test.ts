// Proves: The readiness check that decides between keeping and rolling back an update is real, an incomplete release is not published, an update killed half-way can be recovered, and an update never rewrites the credentials file.
// Red when: The readiness check accepts a failed daemon or refuses a running one, a release missing a program is published, an update killed after publishing cannot be recovered, or an update rewrites or prints the credentials.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { install, parseOptions, ready, stage, type InstallHooks, type Options, type ReadyTiming } from './install.ts';
import { assertOwnedFiles, atomicWrite, readInstallation, unitPath, type Run } from './installation.ts';

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
  let timing: ReadyTiming;
  const writeToken = (contents: unknown) => atomicWrite(join(options.dataDir, '.goodvibes/daemon/operator-tokens.json'), JSON.stringify(contents));
  beforeEach(() => {
    page = '<html>test</html>'; health = { status: 200, body: { network: { controlPlane: { ready: true } } } };
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response(page);
      if (path === '/api/health' && request.headers.get('authorization') === 'Bearer secret-token') return Response.json(health.body, { status: health.status });
      return new Response('unauthorized', { status: 401 });
    } });
    options.port = server.port!;
    // Time moves only when the code asks for it, so a loop that never sleeps still ends.
    let clock = 0;
    timing = { now: () => (clock += 100), sleep: async () => {}, timeoutMs: 5_000 };
    state = 'active';
    writeToken({ token: 'secret-token' });
  });
  afterEach(async () => { await server.stop(true); });

  test('succeeds when the service is active, serves the staged WebUI and reports the control plane ready', async () => {
    await ready(options, '<html>test</html>', execute, timing);
  });
  test('a stopped service is not ready', async () => {
    state = 'failed';
    await expect(ready(options, '<html>test</html>', execute, timing)).rejects.toThrow();
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
  test('a missing client binary stops staging', async () => {
    rmSync(join(root, 'products/agent/dist', `goodvibes-agent-${target}.bun`));
    await expect(stage(root, release, options, COMMIT, execute)).rejects.toThrow();
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
  test('the next update recovers, then removes the abandoned release', async () => {
    const { before, abandoned } = await killedUpdate();
    await install(options, { ...hooks, build: async () => 'c'.repeat(40) });
    const receipt = readInstallation(options.prefix)!;
    expect(receipt.release).not.toBe(before);
    expect(receipt.release).not.toBe(abandoned);
    expect(releasesOf()).toEqual([receipt.release]);
    assertOwnedFiles(receipt);
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
  test('an exported key does not overwrite an existing credentials file and is never printed', async () => {
    delete process.env.TYPESAFE_API_KEY;
    await install(options, hooks);
    const file = join(options.dataDir, 'environment');
    const before = readFileSync(file, 'utf8');
    expect(before).not.toContain("TYPESAFE_API_KEY='");
    process.env.TYPESAFE_API_KEY = 'synthetic-new-value';
    await install(options, { ...hooks, build: async () => 'b'.repeat(40) });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(warnings.join('\n')).not.toContain('synthetic-new-value');
  });
});
