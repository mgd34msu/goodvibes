import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError } from '@goodvibes-jev/engine/errors';
import { createDaemonIdentityProof, DAEMON_CHALLENGE_HEADER, DAEMON_PROOF_HEADER } from '../platform/src/platform/daemon/identity-proof.ts';
import { startHostServices, type HostServicesConfig } from '../platform/src/platform/runtime/bootstrap-services.ts';

function config(values: Record<string, boolean | number | string>): HostServicesConfig {
  return { get: (key) => values[key] ?? false };
}
function baseConfig(values: Record<string, boolean | number | string> = {}): HostServicesConfig {
  return config({
    'daemon.enabled': true, 'danger.httpListener': false,
    'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421,
    'httpListener.host': '127.0.0.1', 'httpListener.port': 3422,
    ...values,
  });
}
const runtimeBus = {} as never;
const hookDispatcher = {} as never;
const runtimeServices = { localUserAuthManager: {}, configManager: {} } as never;
const yieldOnce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the identity probe and the daemon token', () => {
  async function withStatusServer(respond: (authorization: string | null, request: Request) => Response, run: (port: number, seen: Array<string | null>) => Promise<void>): Promise<void> {
    const seen: Array<string | null> = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => { const header = request.headers.get('authorization'); seen.push(header); return respond(header, request); } });
    try { await run(server.port!, seen); } finally { await server.stop(true); }
  }
  const running = (): Response => Response.json({ status: 'running', version: '1.0.0' });

  test('the first request carries no token, and a daemon that answers without one never receives it', async () => {
    await withStatusServer(() => running(), async (port, seen) => {
      const handle = await startHostServices(baseConfig({ 'controlPlane.port': port }), runtimeBus, hookDispatcher, runtimeServices, {
        sharedDaemonToken: 'secret-token',
        isDaemonVersionCompatible: () => true,
        probeDaemonPortInUse: async () => true,
        spawnDetachedDaemon: () => { throw new Error('must not spawn'); },
      });
      expect(handle.daemonStatus.mode).toBe('external');
      expect(seen).toEqual([null]);
    });
  });

  /** What the real daemon does: refuse an unauthenticated request, proving it holds the token when challenged. */
  const daemon = (token: string) => (authorization: string | null, request: Request): Response => {
    if (authorization === `Bearer ${token}`) return running();
    const refusal = new Response('no', { status: 401 });
    const challenge = request.headers.get(DAEMON_CHALLENGE_HEADER);
    if (challenge) refusal.headers.set(DAEMON_PROOF_HEADER, createDaemonIdentityProof(token, challenge));
    return refusal;
  };
  const adopt = (port: number) => startHostServices(baseConfig({ 'controlPlane.port': port }), runtimeBus, hookDispatcher, runtimeServices, {
    sharedDaemonToken: 'secret-token',
    isDaemonVersionCompatible: () => true,
    probeDaemonPortInUse: async () => true,
    spawnDetachedDaemon: () => { throw new Error('must not spawn'); },
  });

  test('a daemon that proves it holds the token is retried once with the token', async () => {
    await withStatusServer(daemon('secret-token'), async (port, seen) => {
      const handle = await adopt(port);
      expect(handle.daemonStatus.mode).toBe('external');
      expect(seen).toEqual([null, 'Bearer secret-token']);
    });
  });

  test('a process on the port that answers 401 without proving it holds the token never receives the token', async () => {
    await withStatusServer(() => new Response('no', { status: 401 }), async (port, seen) => {
      const handle = await adopt(port);
      expect(handle.daemonStatus.mode).not.toBe('external');
      expect(seen).toEqual([null]);
    });
  });

  test('a daemon that predates identity proofs is refused with a reason that says to stop it', async () => {
    await withStatusServer(() => new Response('no', { status: 401 }), async (port) => {
      const handle = await adopt(port);
      expect(handle.daemonStatus.mode).toBe('blocked');
      expect(handle.daemonStatus.reason).toContain('older version');
      expect(handle.daemonStatus.reason).toContain('stop it');
    });
  });

  test('a process that answers with a proof made for a different token never receives the token', async () => {
    await withStatusServer(daemon('someone-elses-token'), async (port, seen) => {
      await adopt(port);
      expect(seen).toEqual([null]);
    });
  });
});

describe('starting the daemon', () => {
  test('two hosts started together spawn one daemon and both adopt it', async () => {
    let spawned = 0;
    const factories = {
      daemonRuntimeDir: mkdtempSync(join(tmpdir(), 'gv-spawn-lock-')),
      sleep: yieldOnce,
      isDaemonVersionCompatible: () => true,
      probeDaemonPortInUse: async () => spawned > 0,
      probeDaemonIdentity: async () => ({ kind: 'goodvibes' as const, status: 'running', version: '1.0.0' }),
      spawnDetachedDaemon: () => { spawned += 1; return { pid: 4242, unref() {} }; },
    };
    const [first, second] = await Promise.all([
      startHostServices(baseConfig(), runtimeBus, hookDispatcher, runtimeServices, factories),
      startHostServices(baseConfig(), runtimeBus, hookDispatcher, runtimeServices, factories),
    ]);
    expect(spawned).toBe(1);
    expect(first.daemonStatus.mode).toBe('external');
    expect(second.daemonStatus.mode).toBe('external');
  });

  test('an invalid setting is refused before any daemon is spawned', async () => {
    let spawned = 0;
    await expect(startHostServices(baseConfig({ 'danger.httpListener': 'yes' }), runtimeBus, hookDispatcher, runtimeServices, {
      daemonRuntimeDir: mkdtempSync(join(tmpdir(), 'gv-spawn-lock-')),
      probeDaemonPortInUse: async () => false,
      spawnDetachedDaemon: () => { spawned += 1; return { pid: 1, unref() {} }; },
    })).rejects.toBeInstanceOf(ConfigurationError);
    expect(spawned).toBe(0);
  });
});
