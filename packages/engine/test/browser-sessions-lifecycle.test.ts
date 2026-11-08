import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserSessionError, BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.js';
import { DRIVER_VERSION } from '../sdk/src/platform/browser/browser-provision-io.js';
import type { BrowserProvisionIo } from '../sdk/src/platform/browser/browser-types.js';

function deferred() {
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  return { pending, release };
}
function fixture(phase: 'probe' | 'connect' | 'launch' | 'provision', failCloseOnce = false) {
  const root = mkdtempSync(join(tmpdir(), 'browser-lifetime-'));
  const entered = deferred(), gate = deferred(), effects: string[] = [];
  let signal: AbortSignal | undefined, closes = 0;
  const context = {
    pages: () => [], on() {}, isClosed: () => false,
    async close() { effects.push('context-close'); closes++; if (failCloseOnce && closes === 1) throw new Error('Unconfirmed context cleanup'); },
  } as unknown as BrowserContext;
  const browser = {
    contexts() { effects.push('contexts'); return [context]; },
    async close() { effects.push('user-browser-close'); },
    _connection: { close() { effects.push('transport-close'); } },
  } as unknown as Browser;
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/fixture', cliPath: '/fixture/cli.js', version: DRIVER_VERSION, error: null }),
    expectedExecutablePath: () => '/fixture/chromium', browsersPath: () => '/fixture/cache',
    pathExists: () => true, isExecutableFile: () => true, directoryWritable: () => true, removePath: () => {},
    async runCommand(_command, _args, options) {
      if (phase === 'provision') { signal = options.signal; entered.release(); await gate.pending; }
      return { code: 0, stdout: 'Chromium 151', stderr: '', timedOut: false, spawnError: null };
    },
    systemBrowserCandidates: () => [], now: () => 0,
  };
  const manager = new BrowserSessionManager({ profileRoot: join(root, 'profiles'), surfaceRoot: 'test-surface', io,
    probeEndpoint: async (_candidates, owner) => {
      if (phase === 'probe') { signal = owner; entered.release(); await gate.pending; }
      return { endpoint: 'http://127.0.0.1:9222', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/original' };
    },
    loadDriver: () => ({ chromium: {
      async connectOverCDP() { entered.release(); await gate.pending; return browser; },
      async launchPersistentContext() { entered.release(); await gate.pending; return context; },
    } }),
  });
  return { manager, root, entered, gate, effects, signal: () => signal };
}

test.each(['probe', 'connect', 'launch', 'provision'] as const)(
  'shutdown owns an admitted %s until its actual dependency settles and cannot publish its late result', async phase => {
    const f = fixture(phase);
    const pending = phase === 'provision' ? f.manager.provision() : phase === 'launch' ? f.manager.launch({}) : f.manager.attach({ cdpEndpoint: '9222' });
    const handled = pending.catch(error => error as unknown);
    try {
      await f.entered.pending;
      let reentered: Promise<void> | undefined;
      f.signal()?.addEventListener('abort', () => { reentered = f.manager.shutdown(); }, { once: true });
      const closing = f.manager.shutdown(); expect(f.manager.shutdown()).toBe(closing);
      let drained = false; void closing.then(() => { drained = true; });
      await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
      if (phase === 'probe' || phase === 'provision') { expect(f.signal()?.aborted).toBe(true); expect(reentered).toBe(closing); }
      await expect(f.manager.launch({})).rejects.toBeInstanceOf(BrowserSessionError);
      await expect(f.manager.attach({ cdpEndpoint: '9222' })).rejects.toBeInstanceOf(BrowserSessionError);
      await expect(f.manager.provision()).rejects.toBeInstanceOf(BrowserSessionError);
      f.gate.release();
      expect(await handled).toBeInstanceOf(BrowserSessionError);
      await closing;
      expect(f.effects).toEqual(phase === 'connect' ? ['transport-close'] : phase === 'launch' ? ['context-close'] : []);
      expect(f.manager.list()).toEqual([]); expect(f.manager.hasSessions()).toBe(false);
    } finally { f.gate.release(); await handled; await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
  },
);

test('a failed retirement of an unpublished launched context remains owned for shutdown cleanup', async () => {
  const f = fixture('launch', true), pending = f.manager.launch({}), handled = pending.catch(error => error as unknown);
  try {
    await f.entered.pending;
    const closing = f.manager.shutdown(); f.gate.release();
    expect(await handled).toBeInstanceOf(AggregateError);
    await closing;
    expect(f.effects).toEqual(['context-close', 'context-close']); expect(f.manager.list()).toEqual([]);
  } finally { f.gate.release(); await handled; await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
});

test('a retained context page event cannot publish a page after the session owner retires', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-page-retirement-'));
  let publish: ((page: Page) => void) | undefined;
  const context = { pages: () => [], on(_name: string, listener: (page: Page) => void) { publish = listener; }, async close() {} } as unknown as BrowserContext;
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/fixture', cliPath: '/fixture/cli.js', version: DRIVER_VERSION, error: null }),
    expectedExecutablePath: () => '/fixture/chromium', browsersPath: () => '/fixture/cache',
    pathExists: () => true, isExecutableFile: () => true, directoryWritable: () => true, removePath: () => {},
    runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }), systemBrowserCandidates: () => [], now: () => 0,
  };
  const manager = new BrowserSessionManager({ profileRoot: join(root, 'profiles'), surfaceRoot: 'test-surface', io,
    loadDriver: () => ({ chromium: { async launchPersistentContext() { return context; }, async connectOverCDP() { return { contexts: () => [context] } as unknown as Browser; } } }),
    probeEndpoint: async () => ({ endpoint: 'http://127.0.0.1:9222', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/original' }),
  });
  try {
    await manager.attach({ cdpEndpoint: '9222' }); await manager.shutdown();
    let observed = false;
    publish?.({ on() { observed = true; }, url: () => 'about:blank' } as unknown as Page);
    expect(observed).toBe(false); expect(manager.list()).toEqual([]);
  } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
