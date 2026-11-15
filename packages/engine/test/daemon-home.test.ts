import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDaemonHomeDir,
  ensureDaemonHome,
  readDaemonSetting,
  writeDaemonSetting,
  operatorTokenPath,
  readOperatorTokenFile,
} from '../platform/src/platform/workspace/daemon-home.ts';
import { WorkspaceSwapManager } from '../platform/src/platform/workspace/workspace-swap-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-test-${suffix}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// resolveDaemonHomeDir
// ---------------------------------------------------------------------------

describe('resolveDaemonHomeDir', () => {
  test('uses daemonHomeArg when provided', () => {
    const arg = '/custom/daemon/home';
    expect(resolveDaemonHomeDir({ daemonHomeArg: arg })).toBe(arg);
  });

  test('uses GOODVIBES_DAEMON_HOME env when daemonHomeArg is absent', () => {
    const envPath = '/env/daemon/home';
    expect(resolveDaemonHomeDir({ env: { GOODVIBES_DAEMON_HOME: envPath } })).toBe(envPath);
  });

  test('prefers daemonHomeArg over env var', () => {
    const arg = '/cli/path';
    const env = { GOODVIBES_DAEMON_HOME: '/env/path' };
    expect(resolveDaemonHomeDir({ daemonHomeArg: arg, env })).toBe(arg);
  });

  test('falls back to ~/.goodvibes/daemon when nothing is configured', () => {
    const result = resolveDaemonHomeDir({ env: {} });
    // Should end with .goodvibes/daemon
    expect(result.endsWith('.goodvibes/daemon') || result.endsWith('.goodvibes\\daemon')).toBe(true);
  });

  // The tree root, not the login home. GOODVIBES_HOME relocates the whole
  // GoodVibes tree, settings, workspace state, every secret tier, and this
  // resolver used to call homedir() directly, so a daemon started under a
  // redirected root kept its identity files in the REAL home.
  test('derives the default from GOODVIBES_HOME when it names a tree root', () => {
    const root = '/redirected/tree/root';
    expect(resolveDaemonHomeDir({ env: { GOODVIBES_HOME: root } }))
      .toBe(join(root, '.goodvibes', 'daemon'));
  });

  test('GOODVIBES_DAEMON_HOME still names the identity directory outright, above GOODVIBES_HOME', () => {
    const env = { GOODVIBES_HOME: '/redirected/tree/root', GOODVIBES_DAEMON_HOME: '/elsewhere/identity' };
    expect(resolveDaemonHomeDir({ env })).toBe('/elsewhere/identity');
  });

  test('an explicit --daemon-home outranks both home variables', () => {
    const env = { GOODVIBES_HOME: '/redirected/tree/root', GOODVIBES_DAEMON_HOME: '/elsewhere/identity' };
    expect(resolveDaemonHomeDir({ daemonHomeArg: '/flag/identity', env })).toBe('/flag/identity');
  });

  test('a redirected tree root does not reach back into the login home', () => {
    const loginHome = '/login/home';
    const root = '/redirected/tree/root';
    const redirected = resolveDaemonHomeDir({ env: { HOME: loginHome, GOODVIBES_HOME: root } });
    expect(redirected.startsWith(root)).toBe(true);
    expect(redirected.startsWith(loginHome)).toBe(false);
  });

  test('without GOODVIBES_HOME the login home from the environment answers', () => {
    expect(resolveDaemonHomeDir({ env: { HOME: '/login/home' } }))
      .toBe(join('/login/home', '.goodvibes', 'daemon'));
  });
});

// ---------------------------------------------------------------------------
// ensureDaemonHome
// ---------------------------------------------------------------------------

describe('ensureDaemonHome', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('base');
    daemonHome = join(baseDir, 'daemon-home');
  });

  afterEach(() => {
    cleanup(baseDir);
  });

  test('freshInstall=true when daemon home does not exist yet', () => {
    const result = ensureDaemonHome(daemonHome);
    expect(result.freshInstall).toBe(true);
    expect(result.daemonHomeDir).toBe(daemonHome);
    expect(existsSync(daemonHome)).toBe(true);
  });

  test('freshInstall=false when daemon home already exists', () => {
    mkdirSync(daemonHome, { recursive: true });
    const result = ensureDaemonHome(daemonHome);
    expect(result.freshInstall).toBe(false);
  });

  test('creates daemon home directory when absent', () => {
    expect(existsSync(daemonHome)).toBe(false);
    ensureDaemonHome(daemonHome);
    expect(existsSync(daemonHome)).toBe(true);
  });

  test('does not import workspace-scoped operator-tokens.json', () => {
    const fakeWorkspace = join(baseDir, 'workspace');
    mkdirSync(join(fakeWorkspace, '.goodvibes'), { recursive: true });
    writeFileSync(join(fakeWorkspace, '.goodvibes', 'operator-tokens.json'), JSON.stringify({ tokens: ['tok1'] }));

    ensureDaemonHome(daemonHome);

    const dest = join(daemonHome, 'operator-tokens.json');
    expect(existsSync(dest)).toBe(false);
  });

  test('creates an empty daemon home without external source files', () => {
    expect(() => ensureDaemonHome(daemonHome)).not.toThrow();
    expect(existsSync(daemonHome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// operatorTokenPath / readOperatorTokenFile
// ---------------------------------------------------------------------------

describe('operator token path: global-only', () => {
  let daemonHome: string;

  beforeEach(() => { daemonHome = tempDir('op-token'); });
  afterEach(() => { cleanup(daemonHome); });

  test('operatorTokenPath returns <daemonHomeDir>/operator-tokens.json', () => {
    expect(operatorTokenPath(daemonHome)).toBe(join(daemonHome, 'operator-tokens.json'));
  });

  test('readOperatorTokenFile returns undefined when file does not exist', () => {
    expect(readOperatorTokenFile(daemonHome)).toBeUndefined();
  });

  test('readOperatorTokenFile returns content when file exists', () => {
    const content = '{"token":"gv_y","peerId":"q","createdAt":1}';
    writeFileSync(operatorTokenPath(daemonHome), content, { mode: 0o600 });
    expect(readOperatorTokenFile(daemonHome)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// readDaemonSetting / writeDaemonSetting
// ---------------------------------------------------------------------------

describe('daemon settings read/write', () => {
  let daemonHome: string;

  beforeEach(() => {
    daemonHome = tempDir('settings');
  });

  afterEach(() => {
    cleanup(daemonHome);
  });

  test('returns undefined for unknown key', () => {
    expect(readDaemonSetting(daemonHome, 'no.such.key')).toBeUndefined();
  });

  test('round-trips a setting', () => {
    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/some/path');
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe('/some/path');
  });

  test('overwrites an existing setting', () => {
    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/previous');
    writeDaemonSetting(daemonHome, 'runtime.workingDir', '/new');
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe('/new');
  });
});

// ---------------------------------------------------------------------------
// WorkspaceSwapManager: a change is saved for the next start
// ---------------------------------------------------------------------------

describe('WorkspaceSwapManager', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('swap-base');
    daemonHome = tempDir('swap-daemon');
  });

  afterEach(() => cleanup(baseDir, daemonHome));

  test('a change is saved, the running root stays, and the result says a restart applies it', async () => {
    const mgr = new WorkspaceSwapManager(baseDir, { runtimeBus: null, daemonHomeDir: daemonHome });
    const target = join(baseDir, 'next');
    const result = await mgr.requestSwap(target);
    expect(result.ok && result.restartRequired).toBe(true);
    expect(result.ok && result.requiresRestart.length).toBeGreaterThan(0);
    expect(mgr.getCurrentWorkingDir()).toBe(baseDir);
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe(target);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  test('requesting the running root cancels a saved change', async () => {
    const mgr = new WorkspaceSwapManager(baseDir, { runtimeBus: null, daemonHomeDir: daemonHome });
    await mgr.requestSwap(join(baseDir, 'next'));
    const result = await mgr.requestSwap(baseDir);
    expect(result.ok && result.restartRequired).toBe(false);
    expect(mgr.getPendingWorkingDir()).toBeNull();
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBe(baseDir);
  });

  test('a path that cannot be a directory changes nothing', async () => {
    const file = join(baseDir, 'a-file');
    writeFileSync(file, 'x');
    const mgr = new WorkspaceSwapManager(baseDir, { runtimeBus: null, daemonHomeDir: daemonHome });
    const result = await mgr.requestSwap(file);
    expect(result.ok ? null : result.code).toBe('INVALID_PATH');
    expect(readDaemonSetting(daemonHome, 'runtime.workingDir')).toBeUndefined();
  });

  test('a change that cannot be saved fails and is not reported as done', async () => {
    const fileAsHome = join(baseDir, 'home-is-a-file');
    writeFileSync(fileAsHome, 'x');
    const mgr = new WorkspaceSwapManager(baseDir, { runtimeBus: null, daemonHomeDir: fileAsHome });
    const result = await mgr.requestSwap(join(baseDir, 'next'));
    expect(result.ok ? null : result.code).toBe('REROOT_FAILED');
    expect(mgr.getPendingWorkingDir()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional test cases
// ---------------------------------------------------------------------------

describe('ensureDaemonHome: workspace-scoped token files are ignored', () => {
  let baseDir: string;
  let daemonHome: string;

  beforeEach(() => {
    baseDir = tempDir('no-ws-token');
    daemonHome = join(baseDir, 'daemon-home');
  });

  afterEach(() => cleanup(baseDir));

  test('does not import even valid workspace-scoped operator-tokens.json', () => {
    const oldTokenDir = join(baseDir, '.goodvibes');
    mkdirSync(oldTokenDir, { recursive: true });
    const tokenContent = JSON.stringify({ token: 'gv_x', peerId: 'p', createdAt: 0 });
    writeFileSync(join(oldTokenDir, 'operator-tokens.json'), tokenContent);

    ensureDaemonHome(daemonHome);

    const dest = join(daemonHome, 'operator-tokens.json');
    expect(existsSync(dest)).toBe(false);
  });
});
