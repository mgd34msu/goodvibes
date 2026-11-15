import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserEngine } from '../platform/src/platform/browser/browser-engine.js';
import { BrowserHostClient, browserHostScriptPath, refreshRemotePages, remoteContext, remotePage } from '../platform/src/platform/browser/browser-host-client.js';
import { BrowserSessionManager } from '../platform/src/platform/browser/browser-sessions.js';
import { DRIVER_VERSION } from '../platform/src/platform/browser/browser-provision-io.js';
import type { BrowserProvisionIo, OutwardEffectDecision, UntrustedContentEnvelope, UntrustedContentPort } from '../platform/src/platform/browser/browser-types.js';

// playwright-core's own types are not resolvable from test/, so the context type comes from the module under test.
type BrowserContext = ReturnType<typeof remoteContext>;

type Call = (command: string, params?: Record<string, unknown>) => Promise<unknown>;

/** A client whose host is a script in this process. */
function scriptedClient(handler: Call): BrowserHostClient {
  const client = new BrowserHostClient();
  (client as unknown as { call: Call }).call = handler;
  return client;
}

describe('a host-backed page after an action that navigates', () => {
  test('reports the new address and frames, not the ones it had before the click', async () => {
    let address = 'https://shop.example/cart';
    let frames = [{ chain: [] as string[], url: address, main: true }];
    const client = scriptedClient(async (command, params) => {
      if (command === 'locator') {
        address = 'https://shop.example/checkout';
        frames = [{ chain: [], url: address, main: true }, { chain: ['iframe#pay'], url: 'https://pay.example/', main: false }];
        return { value: undefined };
      }
      if (command === 'frames') return { frames };
      if (command === 'pageCall' && params?.['method'] === 'url') return { value: address };
      return { value: undefined };
    });
    const page = remotePage(client, 'hp1', 'https://shop.example/cart');
    await page.locator('#go').click();
    expect(page.url()).toBe('https://shop.example/checkout');
    expect(page.frames()).toHaveLength(2);
  });
});

describe('tabs the host opens and closes on its own', () => {
  test('are reflected when the session lists tabs, and a closed tab stops being tracked', async () => {
    let hostPages = [{ pageId: 'hp1', url: 'https://a.example/' }];
    const client = scriptedClient(async (command) => {
      if (command === 'pages') return { pages: hostPages };
      return { value: undefined };
    });
    const context = remoteContext(client, hostPages);
    expect(refreshRemotePages(context)).not.toBeNull();
    const io: BrowserProvisionIo = {
      resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: DRIVER_VERSION, error: null }),
      expectedExecutablePath: () => '/cache/chrome', browsersPath: () => '/cache', pathExists: () => true,
      isExecutableFile: () => true, directoryWritable: () => true, removePath: () => undefined,
      runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
      systemBrowserCandidates: () => [], now: () => 0,
    };
    const manager = new BrowserSessionManager({
      profileRoot: join(tmpdir(), 'gv-host-state-profiles'), surfaceRoot: 'test-surface', io,
      loadDriver: () => ({ chromium: { launchPersistentContext: async () => context, connectOverCDP: async () => { throw new Error('unused'); } } }) as never,
    });
    try {
      const session = await manager.launch({ headless: true });
      expect((await manager.pageList(session.sessionId)).map((entry) => entry.url)).toEqual(['https://a.example/']);

      hostPages = [...hostPages, { pageId: 'hp2', url: 'https://opened-by-site.example/' }];
      expect((await manager.pageList(session.sessionId)).map((entry) => entry.url)).toEqual(['https://a.example/', 'https://opened-by-site.example/']);

      hostPages = hostPages.filter((entry) => entry.pageId !== 'hp1');
      const remaining = await manager.pageList(session.sessionId);
      expect(remaining.map((entry) => entry.url)).toEqual(['https://opened-by-site.example/']);
      expect(remaining[0]?.active).toBe(true);
    } finally {
      await manager.shutdown();
    }
  });
});

class QuietPort implements UntrustedContentPort {
  readonly rule = 'rule';
  originOf(url: string): string { return new URL(url).origin; }
  label(input: { readonly origin: string; readonly text: string }): UntrustedContentEnvelope {
    return { trust: 'untrusted', surface: 'web-page', origin: input.origin, retrievedAt: '', text: input.text, truncated: false, rule: this.rule };
  }
  recordIngest(): void { /* not under test */ }
  async evaluateOutwardEffect(): Promise<OutwardEffectDecision> { return { allowed: true, reason: null, fix: null, untrustedOrigins: [] }; }
}

describe('what the engine holds for a session or tab that is gone', () => {
  const ELEMENT = { tag: 'button', role: 'button', name: 'Go', selector: '#go', value: null, disabled: false, checked: null, depth: 1, submits: false };
  function hostFor(pages: () => { pageId: string; url: string }[]): Call {
    return async (command, params) => {
      if (command === 'pages') return { pages: pages() };
      if (command === 'frames') return { frames: [{ chain: [], url: 'https://a.example/', main: true }] };
      if (command === 'pageCall') return { value: params?.['method'] === 'title' ? 'Page' : 'https://a.example/' };
      if (command === 'evaluate') {
        const arg = params?.['arg'];
        if (typeof arg === 'number') return { value: [ELEMENT] };
        if (arg && typeof arg === 'object' && 'identityOnly' in arg) {
          return { value: { url: 'https://a.example/', title: 'Page', elements: [{ ...ELEMENT, value: null, documentUrl: 'https://a.example/', control: { type: '', autocomplete: '', name: '', id: '', placeholder: '', ariaLabel: '', label: '' } }] } };
        }
        return { value: 'text' };
      }
      return { value: undefined };
    };
  }
  function managerFor(context: BrowserContext, closes: { fail: boolean }): BrowserSessionManager {
    // Same object, so its host-backed page tracking stays attached to it.
    const wrapped = Object.assign(context as unknown as object, {
      close: async () => { if (closes.fail) throw new Error('close failed'); },
    }) as unknown as BrowserContext;
    const io: BrowserProvisionIo = {
      resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: DRIVER_VERSION, error: null }),
      expectedExecutablePath: () => '/cache/chrome', browsersPath: () => '/cache', pathExists: () => true,
      isExecutableFile: () => true, directoryWritable: () => true, removePath: () => undefined,
      runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
      systemBrowserCandidates: () => [], now: () => 0,
    };
    return new BrowserSessionManager({
      profileRoot: join(tmpdir(), 'gv-host-state-profiles'), surfaceRoot: 'test-surface', io,
      loadDriver: () => ({ chromium: { launchPersistentContext: async () => wrapped, connectOverCDP: async () => { throw new Error('unused'); } } }) as never,
    });
  }

  test('snapshots of a tab the person closed are dropped when tabs are listed', async () => {
    let hostPages = [{ pageId: 'hp1', url: 'https://a.example/' }, { pageId: 'hp2', url: 'https://a.example/' }];
    const client = scriptedClient(hostFor(() => hostPages));
    const context = remoteContext(client, hostPages);
    const manager = managerFor(context, { fail: false });
    const engine = new BrowserEngine(manager, { screenshotDirectory: join(tmpdir(), 'gv-host-state-shots'), untrusted: new QuietPort() });
    try {
      const { session } = (await engine.launch({ headless: true })) as { session: { sessionId: string } };
      const [first] = (await manager.pageList(session.sessionId)).map((entry) => entry.pageId);
      const snapshot = await engine.snapshot({ sessionId: session.sessionId, pageId: first });
      const snapshotId = snapshot.snapshotId as string;
      expect(() => engine.assertSnapshotCurrent(session.sessionId, first, snapshotId)).not.toThrow();
      hostPages = hostPages.filter((entry) => entry.pageId !== 'hp1');
      await engine.tabs({ sessionId: session.sessionId });
      expect(() => engine.assertSnapshotCurrent(session.sessionId, first, snapshotId)).toThrow();
    } finally {
      await manager.shutdown();
    }
  });

  test('a close that fails leaves the session listed so it can be closed again', async () => {
    const client = scriptedClient(hostFor(() => [{ pageId: 'hp1', url: 'https://a.example/' }]));
    const closes = { fail: true };
    const manager = managerFor(remoteContext(client, [{ pageId: 'hp1', url: 'https://a.example/' }]), closes);
    const engine = new BrowserEngine(manager, { screenshotDirectory: join(tmpdir(), 'gv-host-state-shots'), untrusted: new QuietPort() });
    try {
      const { session } = (await engine.launch({ headless: true })) as { session: { sessionId: string } };
      await expect(engine.close(session.sessionId)).rejects.toThrow('close failed');
      expect(manager.list().map((entry) => entry.sessionId)).toEqual([session.sessionId]);
      closes.fail = false;
      await expect(engine.close(session.sessionId)).resolves.toMatchObject({ closed: { sessionId: session.sessionId } });
      expect(manager.list()).toEqual([]);
    } finally {
      await manager.shutdown();
    }
  });

  test('status reads a failed provision again once the machine is fixed', async () => {
    let installed = false;
    const io: BrowserProvisionIo = {
      resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: DRIVER_VERSION, error: null }),
      expectedExecutablePath: () => '/cache/chromium-1/chrome', browsersPath: () => '/cache',
      pathExists: () => installed, isExecutableFile: () => installed, directoryWritable: () => true, removePath: () => undefined,
      runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
      systemBrowserCandidates: () => [], now: () => 0,
    };
    const manager = new BrowserSessionManager({ profileRoot: join(tmpdir(), 'gv-host-state-profiles'), surfaceRoot: 'test-surface', io });
    const engine = new BrowserEngine(manager, { screenshotDirectory: join(tmpdir(), 'gv-host-state-shots'), untrusted: new QuietPort() });
    const before = await engine.status();
    expect(before['browserAvailable']).toBe(false);
    installed = true;
    const after = await engine.status();
    expect(after['browserAvailable']).toBe(true);
    expect(after).not.toHaveProperty('problem');
    await manager.shutdown();
  });
});

describe('the setup receipt', () => {
  test('is returned by the first call that did setup and not repeated on later calls', async () => {
    let driverInstalled = false;
    const page = { url: () => 'about:blank', title: async () => '', on: () => undefined, close: async () => undefined, goto: async () => null };
    const context = { pages: () => [page], on: () => undefined, newPage: async () => page, close: async () => undefined } as unknown as BrowserContext;
    const io: BrowserProvisionIo = {
      resolveDriver: () => driverInstalled
        ? { available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: DRIVER_VERSION, error: null }
        : { available: false, packageDirectory: null, cliPath: null, version: null, error: 'not installed' },
      installDriver: async () => { driverInstalled = true; return { code: 0, stdout: 'installed the driver', stderr: '', timedOut: false, spawnError: null }; },
      managedDriverRoot: () => '/managed',
      expectedExecutablePath: () => '/cache/chrome', browsersPath: () => '/cache', pathExists: () => true,
      isExecutableFile: () => true, directoryWritable: () => true, removePath: () => undefined,
      runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
      systemBrowserCandidates: () => [], now: () => 0,
    };
    const manager = new BrowserSessionManager({
      profileRoot: join(tmpdir(), 'gv-host-state-profiles'), surfaceRoot: 'test-surface', io,
      loadDriver: () => ({ chromium: { launchPersistentContext: async () => context, connectOverCDP: async () => { throw new Error('unused'); } } }) as never,
    });
    const engine = new BrowserEngine(manager, { screenshotDirectory: join(tmpdir(), 'gv-host-state-shots'), untrusted: new QuietPort() });
    try {
      const first = await engine.navigate({}, { url: 'https://example.org/' });
      expect(first['setup']).toEqual(expect.stringContaining('driver'));
      const second = await engine.navigate({}, { url: 'https://example.org/next' });
      expect(second).not.toHaveProperty('setup');
    } finally { await manager.shutdown(); }
  });
});

describe('the host script and the driver it loads', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function attachFixture(driverVersion: string) {
    const root = mkdtempSync(join(tmpdir(), 'gv-host-driver-'));
    roots.push(root);
    const scriptPath = join(root, 'host', 'browser-host.mjs');
    mkdirSync(join(root, 'host'), { recursive: true });
    copyFileSync(browserHostScriptPath(), scriptPath);
    // The driver sits in a managed directory the host script cannot resolve on its own.
    const driver = join(root, 'managed', 'node_modules', 'playwright-core');
    mkdirSync(driver, { recursive: true });
    const marker = join(root, 'driver-loaded');
    writeFileSync(join(driver, 'package.json'), JSON.stringify({ name: 'playwright-core', version: driverVersion, main: 'index.js' }));
    writeFileSync(join(driver, 'index.js'), `
      const page = { on() {}, url: () => 'about:blank', title: async () => 'Managed', close: async () => undefined };
      const context = { pages: () => [page], on() {} };
      exports.chromium = { connectOverCDP: async () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); return { contexts: () => [context], on() {}, close: async () => undefined }; } };
    `);
    const io: BrowserProvisionIo = {
      resolveDriver: () => ({ available: true, packageDirectory: driver, cliPath: join(driver, 'cli.js'), version: DRIVER_VERSION, error: null }),
      expectedExecutablePath: () => '/cache/chrome', browsersPath: () => '/cache', pathExists: () => true,
      isExecutableFile: () => true, directoryWritable: () => true, removePath: () => undefined,
      runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
      systemBrowserCandidates: () => [], now: () => 0,
    };
    const manager = new BrowserSessionManager({
      profileRoot: join(root, 'profiles'), surfaceRoot: 'test-surface', io, host: { scriptPath },
      probeEndpoint: async () => ({ endpoint: 'http://127.0.0.1:9222', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }),
      loadDriver: () => ({ chromium: {
        launchPersistentContext: async () => { throw new Error('no launch'); },
        connectOverCDP: async () => { throw new Error('Exercise the Node host'); },
      } }),
    });
    return { manager, marker };
  }

  test('attach loads the driver from the directory the parent resolved', async () => {
    const { manager, marker } = attachFixture(DRIVER_VERSION);
    try {
      await expect(manager.attach({ cdpEndpoint: '9222' })).resolves.toMatchObject({ origin: 'attached' });
      expect(existsSync(marker) && readFileSync(marker, 'utf8')).toBe('loaded');
    } finally { await manager.shutdown(); }
  }, 30_000);

  test('attach refuses a driver whose version is not the one this build requires, and names both', async () => {
    const { manager } = attachFixture('1.0.0');
    try {
      await expect(manager.attach({ cdpEndpoint: '9222' })).rejects.toThrow(new RegExp(`1\\.0\\.0.*${DRIVER_VERSION.replaceAll('.', '\\.')}`));
    } finally { await manager.shutdown(); }
  }, 30_000);
});
