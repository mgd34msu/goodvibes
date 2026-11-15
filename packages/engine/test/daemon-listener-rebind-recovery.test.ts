/**
 * A binding change that cannot be bound must never leave a listener down for
 * good: the daemon keeps serving on its previous address, and a corrected
 * setting rebinds. The secondary HTTP listener must also never leave a
 * settled restart published, which made every later waitForRestart() spin.
 *
 * Every listener here is a Bun.serve stand-in; no socket is opened.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon } from '../platform/src/platform/daemon/boot.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { HttpListener } from '../platform/src/platform/daemon/http-listener.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(prefix: string): string { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir; }

/** A serve stand-in that refuses the ports in `refused` and records the ones it bound. */
function serveStandIn(refused: Set<number>) {
  const bound: number[] = [];
  /** Bind and release events in the order they happened. */
  const events: string[] = [];
  const factory = ((options: { port: number; hostname: string }) => {
    if (refused.has(options.port)) throw new Error(`fixture: address ${options.hostname}:${options.port} is in use`);
    bound.push(options.port);
    events.push(`bind:${options.port}`);
    return { port: options.port, hostname: options.hostname, stop: () => { events.push(`stop:${options.port}`); return Promise.resolve(); }, requestIP: () => null, upgrade: () => false };
  }) as unknown as typeof Bun.serve;
  return { factory, bound, events };
}

async function bootFixture(refused: Set<number>) {
  const home = root('rebind-recovery-');
  const work = join(home, 'work'); mkdirSync(work);
  seedBenchmarkCache(home, 'goodvibes');
  const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes', ownsDaemonTier: true });
  const serve = serveStandIn(refused);
  const daemon = await withTestTimeout(bootDaemon({ homeDirectory: home, workingDir: work, daemonHomeDir: join(home, 'daemon'),
    host: '127.0.0.1', port: 47_100, token: 'rebind-recovery-fixture', configManager, serveFactory: serve.factory }));
  return { daemon, configManager, serve };
}

test('an unbindable control-plane port keeps the previous listener serving, and a corrected port rebinds', async () => {
  const refused = new Set([47_101]);
  const { daemon, configManager, serve } = await bootFixture(refused);
  try {
    expect(serve.bound).toEqual([47_100]);
    configManager.set('controlPlane.port', 47_101);
    await withTestTimeout(daemon.server.waitForRestart());
    expect(daemon.server.isRunning).toBe(true);
    expect(daemon.server.boundPort).toBe(47_100);
    configManager.set('controlPlane.port', 47_102);
    await withTestTimeout(daemon.server.waitForRestart());
    expect(daemon.server.isRunning).toBe(true);
    expect(daemon.server.boundPort).toBe(47_102);
  } finally { await daemon.stop(); }
}, 60_000);

test('a changed address is bound before the serving listener is released', async () => {
  const { daemon, configManager, serve } = await bootFixture(new Set());
  try {
    configManager.set('controlPlane.port', 47_121);
    await withTestTimeout(daemon.server.waitForRestart());
    expect(serve.events).toEqual(['bind:47100', 'bind:47121', 'stop:47100']);
    expect(daemon.server.boundPort).toBe(47_121);
  } finally { await daemon.stop(); }
}, 60_000);

test('a refused new address leaves the serving listener untouched, with no release and no rebind', async () => {
  const { daemon, configManager, serve } = await bootFixture(new Set([47_131]));
  try {
    configManager.set('controlPlane.port', 47_131);
    await withTestTimeout(daemon.server.waitForRestart());
    expect(serve.events).toEqual(['bind:47100']);
    expect(daemon.server.isRunning).toBe(true);
    expect(daemon.server.boundPort).toBe(47_100);
  } finally { await daemon.stop(); }
}, 60_000);

test('when neither address can be bound, a later corrected setting still brings the listener back', async () => {
  const refused = new Set<number>();
  const { daemon, configManager, serve } = await bootFixture(refused);
  try {
    expect(serve.bound).toEqual([47_100]);
    // The same address cannot be bound twice, so a rebind of it releases first; it is then refused.
    refused.add(47_100);
    configManager.set('controlPlane.port', 47_100);
    await withTestTimeout(daemon.server.waitForRestart());
    expect(daemon.server.isRunning).toBe(false);
    configManager.set('controlPlane.port', 47_112);
    await withTestTimeout(daemon.server.waitForRestart());
    expect(daemon.server.isRunning).toBe(true);
    expect(daemon.server.boundPort).toBe(47_112);
  } finally { await daemon.stop(); }
}, 60_000);

function httpListenerFixture(refused: Set<number>) {
  const dir = root('http-listener-rebind-');
  const configManager = new ConfigManager({ configDir: dir });
  configManager.set('httpListener.port', 47_200);
  const serve = serveStandIn(refused);
  const listener = new HttpListener({
    configManager, serveFactory: serve.factory,
    userAuth: new UserAuthManager({ users: [], bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap-credential') }),
  });
  listener.enable({ httpListener: true });
  return { listener, configManager, serve };
}

test('a failed HTTP listener restart with a queued change settles its waiters and accepts a corrected binding', async () => {
  const { listener, configManager, serve } = httpListenerFixture(new Set([47_201]));
  await listener.start();
  try {
    // Two keys in one synchronous batch: the second is queued behind the first.
    configManager.set('httpListener.port', 47_201);
    configManager.set('httpListener.host', '127.0.0.2');
    await withTestTimeout(listener.waitForRestart());
    expect(listener.isRunning).toBe(false);
    configManager.set('httpListener.port', 47_202);
    await withTestTimeout(listener.waitForRestart());
    expect(listener.isRunning).toBe(true);
    expect(serve.bound.at(-1)).toBe(47_202);
  } finally { await listener.stop(); }
});

test('stopping a listener that is down after a failed restart detaches its config watcher', async () => {
  const { listener, configManager, serve } = httpListenerFixture(new Set([47_211]));
  await listener.start();
  configManager.set('httpListener.port', 47_211);
  await withTestTimeout(listener.waitForRestart());
  await listener.stop();
  const binds = serve.bound.length;
  configManager.set('httpListener.port', 47_212);
  await withTestTimeout(listener.waitForRestart());
  expect(serve.bound).toHaveLength(binds);
  expect(listener.isRunning).toBe(false);
});

test('a restarted HTTP listener sweeps its rate limiters again', async () => {
  const live = new Set<unknown>();
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = ((handler: () => void, delay?: number) => { const id = realSet(handler, delay); live.add(id); return id; }) as typeof setInterval;
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
  try {
    const { listener, configManager } = httpListenerFixture(new Set());
    const baseline = live.size;
    await listener.start();
    configManager.set('httpListener.port', 47_221);
    await withTestTimeout(listener.waitForRestart());
    expect(listener.isRunning).toBe(true);
    // Both limiters (general and login) have a running sweep after the restart, and none leaks.
    expect(live.size).toBe(baseline);
    await listener.stop();
  } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
});
