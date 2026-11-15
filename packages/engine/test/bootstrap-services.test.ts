import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { startHostServices, type HostServicesConfig } from '../platform/src/platform/runtime/bootstrap-services.ts';

function config(values: Record<string, boolean | number | string>): HostServicesConfig {
  return {
    get: (key) => values[key] ?? false,
  };
}

function baseConfig(values: Record<string, boolean | number | string> = {}): HostServicesConfig {
  return config({
    'daemon.enabled': true,
    'danger.httpListener': false,
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'httpListener.host': '127.0.0.1',
    'httpListener.port': 3422,
    ...values,
  });
}

function createFakeService(events: string[]) {
  return {
    enable: () => {
      events.push('enable');
      return true;
    },
    start: async () => {
      events.push('start');
    },
    stop: async () => {
      events.push('stop');
    },
  };
}

const hookDispatcher = {} as never;
const runtimeServices = {
  localUserAuthManager: {},
  configManager: {},
} as never;

/**
 * The daemon is a separate product. A client host adopts one that is already
 * running and otherwise reports why it did not; it never constructs or starts
 * one (the module reaches `platform/daemon` neither statically nor dynamically,
 * asserted at the bottom of this file).
 */
describe('startHostServices daemon adoption', () => {
  test('adopts a verified external daemon, probing with the shared token', async () => {
    const handle = await startHostServices(baseConfig(), hookDispatcher, runtimeServices, {
      sharedDaemonToken: 'shared-token',
      isDaemonVersionCompatible: () => true,
      probeDaemonPortInUse: async () => true,
      probeDaemonIdentity: async (host, port, token) => {
        expect(host).toBe('127.0.0.1');
        expect(port).toBe(3421);
        expect(token).toBe('shared-token');
        return { kind: 'goodvibes' as const, status: 'running', version: '0.26.4' };
      },
    });

    expect(handle.daemonStatus).toMatchObject({
      mode: 'external',
      host: '127.0.0.1',
      port: 3421,
      baseUrl: 'http://127.0.0.1:3421',
      status: 'running',
      version: '0.26.4',
      authenticated: true,
    });
  });

  test('refuses to adopt a verified GoodVibes daemon whose version is incompatible', async () => {
    const handle = await startHostServices(baseConfig(), hookDispatcher, runtimeServices, {
      localDaemonVersion: '1.0.0',
      probeDaemonPortInUse: async () => true,
      probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '2.0.0' }),
    });

    expect(handle.daemonStatus.mode).toBe('incompatible');
    expect(handle.daemonStatus.version).toBe('2.0.0');
    expect(handle.daemonStatus.reason).toContain('2.0.0');
    expect(handle.daemonStatus.reason).toContain('1.0.0');
  });

  test('reports blocked daemon status when an occupied port is not verified as GoodVibes', async () => {
    const handle = await startHostServices(baseConfig(), hookDispatcher, runtimeServices, {
      probeDaemonPortInUse: async () => true,
      probeDaemonIdentity: async () => ({ kind: 'unknown' as const, reason: 'Identity probe returned HTTP 404' }),
    });

    expect(handle.daemonStatus.mode).toBe('blocked');
    expect(handle.daemonStatus.reason).toBe('Identity probe returned HTTP 404');
  });

  test('a free port is reported unavailable with the command that installs the daemon', async () => {
    let identityProbed = false;
    const handle = await startHostServices(baseConfig(), hookDispatcher, runtimeServices, {
      probeDaemonPortInUse: async () => false,
      probeDaemonIdentity: async () => { identityProbed = true; return { kind: 'unknown' as const, reason: 'unused' }; },
    });

    expect(identityProbed).toBe(false);
    expect(handle.daemonStatus.mode).toBe('unavailable');
    expect(handle.daemonStatus.reason).toContain('goodvibes-daemon install-service');
  });

  test('daemon.enabled:false leaves the daemon off without probing', async () => {
    let probed = false;
    const handle = await startHostServices(baseConfig({ 'daemon.enabled': false }), hookDispatcher, runtimeServices, {
      probeDaemonPortInUse: async () => { probed = true; return false; },
    });

    expect(probed).toBe(false);
    expect(handle.daemonStatus.mode).toBe('disabled');
  });

  test('reports HTTP listener blocked status using the listener host and port', async () => {
    const handle = await startHostServices(
      baseConfig({ 'daemon.enabled': false, 'danger.httpListener': true, 'controlPlane.port': 3450, 'httpListener.port': 3451 }),
      hookDispatcher,
      runtimeServices,
      { probeHttpListenerPortInUse: async () => true },
    );

    expect(handle.httpListener).toBeNull();
    expect(handle.httpListenerStatus).toMatchObject({
      mode: 'blocked',
      host: '127.0.0.1',
      port: 3451,
      baseUrl: 'http://127.0.0.1:3451',
    });
  });

  test('rejects invalid host service ports before probing', async () => {
    await expect(startHostServices(
      baseConfig({ 'controlPlane.port': { nested: true } as never }),
      hookDispatcher,
      runtimeServices,
      { probeDaemonPortInUse: async () => false },
    )).rejects.toThrow('Expected controlPlane.port to be an integer TCP port');
  });
});

describe('startHostServices HTTP listener composition', () => {
  test('enabled with no injected factory reports unavailable naming the daemon product', async () => {
    // The HttpListener class belongs to `goodvibes-daemon`. A client host that
    // cannot build one must not report the listener as merely off, because the
    // setting says it is on, it reports why it did not start.
    const handle = await startHostServices(
      baseConfig({ 'daemon.enabled': false, 'danger.httpListener': true }),
      hookDispatcher,
      runtimeServices,
      {
        probeHttpListenerPortInUse: async () => false,
      },
    );

    expect(handle.httpListener).toBeNull();
    expect(handle.httpListenerStatus.mode).toBe('unavailable');
    expect(handle.httpListenerStatus.reason).toContain('goodvibes-daemon');
    expect(handle.httpListenerStatus.port).toBe(3422);
  });

  test('an injected factory is still started and reported embedded', async () => {
    const events: string[] = [];
    const handle = await startHostServices(
      baseConfig({ 'daemon.enabled': false, 'danger.httpListener': true }),
      hookDispatcher,
      runtimeServices,
      {
        probeHttpListenerPortInUse: async () => false,
        createHttpListener: () => createFakeService(events),
      },
    );

    expect(events).toEqual(['enable', 'start']);
    expect(handle.httpListener).not.toBeNull();
    expect(handle.httpListenerStatus.mode).toBe('embedded');

    await handle.stop();
    expect(events).toEqual(['enable', 'start', 'stop']);
  });
});

describe('client bootstrap cannot reach daemon composition code', () => {
  /**
   * Source-level, on purpose. A behavioural test cannot see this: an
   * `await import('../daemon/server.js')` on a branch nothing takes still makes
   * a bundler pull `platform/daemon`, and everything it imports, into a client
   * bundle, and wrap the shared platform modules in lazy initializers to do it.
   * That is what left module constants uninitialized when hoisted turn-engine
   * functions read them (`ACTION_VERBS` undefined, every turn dead). The daemon
   * product composes DaemonServer/HttpListener with direct static imports in its
   * own entrypoint; this module must have no path to them at all.
   */
  const MODULE_PATH = new URL('../platform/src/platform/runtime/bootstrap-services.ts', import.meta.url);
  const source = readFileSync(MODULE_PATH, 'utf8');

  /** Every module specifier the file names: static, dynamic, side-effect and require forms. */
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  // The identity proof is a pure HMAC helper (node:crypto only): the host needs it to verify a daemon it did not start, and it composes nothing.
  const DAEMON_LEAF_MODULES = new Set(['../daemon/identity-proof.js']);
  const reachesDaemon = (specifier: string): boolean => !DAEMON_LEAF_MODULES.has(specifier) && /(^|\/)daemon(\/|\.js$|\.ts$|$)/.test(specifier);

  test('the scan sees this module\'s imports and recognises daemon paths', () => {
    expect(specifiers.length).toBeGreaterThan(5);
    for (const probe of ['../daemon/server.js', '../daemon.js', './daemon', '../platform/daemon/http-listener.js']) {
      expect(reachesDaemon(probe)).toBe(true);
    }
    expect(reachesDaemon('../runtime/daemon-status.js')).toBe(false);
  });

  test('no static, dynamic, side-effect or require import reaches platform/daemon', () => {
    expect(specifiers.filter(reachesDaemon)).toEqual([]);
  });

  test('the daemon composition classes are neither bound nor constructed here', () => {
    // Naming them in a comment is fine, reaching them is not.
    expect(source).not.toMatch(/new\s+DaemonServer\b/);
    expect(source).not.toMatch(/new\s+HttpListener\b/);
    expect(source).not.toMatch(/\{\s*DaemonServer[\s,}]/);
    expect(source).not.toMatch(/\{\s*HttpListener[\s,}]/);
  });
});
