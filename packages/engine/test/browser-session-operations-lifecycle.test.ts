import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserEngine } from '../platform/src/platform/browser/browser-engine.js';
import { BrowserSessionError, BrowserSessionManager } from '../platform/src/platform/browser/browser-sessions.js';
import { DRIVER_VERSION } from '../platform/src/platform/browser/browser-provision-io.js';
import type { BrowserProvisionIo } from '../platform/src/platform/browser/browser-types.js';
import { withTestTimeout } from './_helpers/test-timeout.js';

function deferred() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

async function fixture(operation: 'new-page' | 'title' | 'close-page' | 'context-close', options: {
  readonly origin?: 'attached' | 'launched'; readonly failPageCloseOnce?: boolean; readonly failContextCloseOnce?: boolean;
  readonly readNeedsDisconnect?: boolean;
  readonly closeNeedsDisconnect?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browser-operation-owner-'));
  const entered = deferred(), gate = deferred(), disconnected = deferred(), effects: string[] = [];
  let publish: ((page: Page) => void) | undefined, contextCloses = 0, createdCloses = 0;
  const makePage = (name: string): Page => {
    const listeners = new Set<() => void>();
    return {
      url() { effects.push(`url:${name}`); return 'about:blank'; },
      async title() {
        effects.push(`title:${name}`);
        if (operation === 'title') {
          entered.release();
          if (options.readNeedsDisconnect) await Promise.race([
            gate.pending, disconnected.pending.then(() => { throw new Error('Native debugger disconnected'); }),
          ]);
          else await gate.pending;
        }
        return 'Original page title';
      },
      on(event: string, listener: () => void) { if (event === 'close') listeners.add(listener); },
      async close() {
        effects.push(`page-close:${name}`);
        if (name === 'created' && ++createdCloses === 1 && options.failPageCloseOnce) throw new Error('Unconfirmed new page cleanup');
        if (operation === 'close-page') {
          entered.release();
          if (options.closeNeedsDisconnect) await Promise.race([
            gate.pending, disconnected.pending.then(() => { throw new Error('Native tab-close outcome unavailable after disconnect'); }),
          ]);
          else await gate.pending;
        }
        for (const listener of listeners) listener();
      },
    } as unknown as Page;
  };
  const original = makePage('original'), created = makePage('created');
  const context = {
    pages: () => operation === 'new-page' ? [] : [original],
    on(event: string, listener: (page: Page) => void) { if (event === 'page') publish = listener; },
    isClosed: () => false,
    async newPage() {
      effects.push('new-page'); entered.release(); await gate.pending;
      publish?.(created);
      return created;
    },
    async close() {
      effects.push('context-close'); contextCloses++;
      if (operation === 'context-close') { entered.release(); await gate.pending; }
      if (options.failContextCloseOnce && contextCloses === 1) throw new Error('Unconfirmed context cleanup');
    },
  } as unknown as BrowserContext;
  const browser = { contexts: () => [context], close: async () => { effects.push('user-browser-close'); },
    _connection: { close() { effects.push('transport-close'); disconnected.release(); } } } as unknown as Browser;
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/fixture', cliPath: '/fixture/cli.js', version: DRIVER_VERSION, error: null }),
    expectedExecutablePath: () => '/fixture/chromium', browsersPath: () => '/fixture/cache',
    pathExists: () => true, isExecutableFile: () => true, directoryWritable: () => true, removePath: () => {},
    runCommand: async () => ({ code: 0, stdout: 'Chromium 151', stderr: '', timedOut: false, spawnError: null }),
    systemBrowserCandidates: () => [], now: () => 0,
  };
  const manager = new BrowserSessionManager({ profileRoot: join(root, 'profiles'), surfaceRoot: 'test-surface', io,
    loadDriver: () => ({ chromium: { launchPersistentContext: async () => context, connectOverCDP: async () => browser } }),
    probeEndpoint: async () => ({ endpoint: 'http://127.0.0.1:9222', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/original' }),
  });
  const session = options.origin === 'launched' ? await manager.launch({}) : await manager.attach({ cdpEndpoint: '9222' });
  return { manager, session, root, entered, gate, effects,
    cleanup: async () => { gate.release(); try { await manager.shutdown(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

for (const method of ['page', 'newPage'] as const) for (const retirement of ['shutdown', 'release', 'close'] as const)
  test(`${method} owns a pending native tab through ${retirement} and closes only its exact late-created tab`, async () => {
    const f = await fixture('new-page', { origin: retirement === 'close' ? 'launched' : 'attached' });
    const pending = f.manager[method](f.session.sessionId), result = pending.catch((error: unknown) => error);
    let drained = false;
    try {
      await f.entered.pending;
      if (retirement === 'release') f.manager.release(f.session.sessionId);
      if (retirement === 'close') await f.manager.closeSession(f.session.sessionId);
      const closing = f.manager.shutdown();
      void closing.then(() => { drained = true; }, () => {});
      await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
      f.gate.release();
      expect(await result).toBeInstanceOf(BrowserSessionError);
      await closing;
      expect(f.effects.filter(effect => effect.startsWith('page-close:'))).toEqual(['page-close:created']);
      expect(f.effects).not.toContain('user-browser-close');
      expect(f.effects.filter(effect => effect === 'context-close')).toHaveLength(retirement === 'close' ? 1 : 0);
      expect(f.manager.list()).toEqual([]);
    } finally { f.gate.release(); await result; await f.cleanup(); }
  });

test('a failed late-created tab cleanup remains owned and is retried during shutdown', async () => {
  const f = await fixture('new-page', { failPageCloseOnce: true });
  const result = f.manager.newPage(f.session.sessionId).catch((error: unknown) => error);
  try {
    await f.entered.pending;
    const closing = f.manager.shutdown(); f.gate.release();
    expect(await result).toBeInstanceOf(AggregateError);
    await closing;
    expect(f.effects.filter(effect => effect.startsWith('page-close:'))).toEqual(['page-close:created', 'page-close:created']);
    expect(f.effects).not.toContain('context-close'); expect(f.effects).not.toContain('user-browser-close');
  } finally { f.gate.release(); await result; await f.cleanup(); }
});

for (const retirement of ['shutdown', 'release'] as const)
  test(`page listing drains its original title read after ${retirement} without publishing a stale result`, async () => {
    const f = await fixture('title');
    const result = f.manager.pageList(f.session.sessionId).catch((error: unknown) => error);
    let drained = false;
    try {
      await f.entered.pending;
      if (retirement === 'release') f.manager.release(f.session.sessionId);
      const closing = f.manager.shutdown(); void closing.then(() => { drained = true; }, () => {});
      await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
      f.gate.release();
      expect(await result).toBeInstanceOf(BrowserSessionError); await closing;
      expect(f.effects.filter(effect => effect.startsWith('url:'))).toEqual([]);
      expect(f.effects).not.toContain('page-close:original'); expect(f.effects).not.toContain('context-close');
    } finally { f.gate.release(); await result; await f.cleanup(); }
  });

test('shutdown disconnects a native title RPC before waiting for its completion', async () => {
  const f = await fixture('title', { readNeedsDisconnect: true });
  const result = f.manager.pageList(f.session.sessionId).catch((error: unknown) => error);
  try {
    await f.entered.pending;
    await withTestTimeout(f.manager.shutdown(), 2_000, 'Shutdown waited for a native read before disconnecting it');
    expect(await result).toBeInstanceOf(BrowserSessionError);
    expect(f.effects).toContain('transport-close');
    expect(f.effects).not.toContain('context-close'); expect(f.effects).not.toContain('user-browser-close');
  } finally { f.gate.release(); await result; await f.cleanup(); }
});

test('actual engine close-tab keeps native page closure owned through manager shutdown', async () => {
  const f = await fixture('close-page');
  const engine = new BrowserEngine(f.manager, { screenshotDirectory: join(f.root, 'screenshots'), untrusted: {
    rule: 'Fixture boundary', originOf: url => url,
    label() { throw new Error('Closing a tab must not label page content'); },
    recordIngest() { throw new Error('Closing a tab must not read page content'); },
    async evaluateOutwardEffect() { throw new Error('Closing a tab must not invent an outward decision'); },
  } });
  const page = await f.manager.page(f.session.sessionId);
  const result = engine.closeTab({ sessionId: f.session.sessionId }, { pageId: page.pageId }).catch((error: unknown) => error);
  let drained = false;
  try {
    await f.entered.pending;
    const closing = f.manager.shutdown(); void closing.then(() => { drained = true; }, () => {});
    await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    f.gate.release(); await result; await closing;
    expect(f.effects.filter(effect => effect.startsWith('page-close:'))).toEqual(['page-close:original']);
    expect(f.effects).not.toContain('context-close'); expect(f.effects).not.toContain('user-browser-close');
  } finally { f.gate.release(); await result; await f.cleanup(); }
});

test('an interrupted native tab-close RPC reports failed cleanup instead of deadlocking before disconnect', async () => {
  const f = await fixture('close-page', { closeNeedsDisconnect: true });
  const page = await f.manager.page(f.session.sessionId);
  const result = f.manager.closePage(f.session.sessionId, page.pageId).catch((error: unknown) => error);
  let failure: unknown;
  try {
    await f.entered.pending;
    failure = await withTestTimeout(f.manager.shutdown(), 2_000, 'Shutdown joined tab closure before disconnecting its RPC')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(await result).toBeInstanceOf(Error);
    expect(f.effects).toContain('transport-close'); expect(f.effects).not.toContain('user-browser-close');
  } finally {
    f.gate.release(); await result;
    try { await f.cleanup(); } catch (error) { expect(error).toBe(failure); }
  }
});

test('a pending explicit context close remains owned after its session leaves the live map', async () => {
  const f = await fixture('context-close', { origin: 'launched' });
  const result = f.manager.closeSession(f.session.sessionId);
  const settled = result.catch((error: unknown) => error);
  let drained = false;
  try {
    await f.entered.pending;
    expect(f.manager.list()).toEqual([]);
    const closing = f.manager.shutdown(); void closing.then(() => { drained = true; }, () => {});
    await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    f.gate.release(); await result; await closing;
    expect(f.effects.filter(effect => effect === 'context-close')).toHaveLength(1);
  } finally { f.gate.release(); await settled; await f.cleanup(); }
});

test('a failed explicit context close retains its native resource for shutdown retry', async () => {
  const f = await fixture('context-close', { origin: 'launched', failContextCloseOnce: true });
  const result = f.manager.closeSession(f.session.sessionId).catch((error: unknown) => error);
  try {
    await f.entered.pending; f.gate.release(); expect(await result).toBeInstanceOf(Error);
    await f.manager.shutdown();
    expect(f.effects.filter(effect => effect === 'context-close')).toHaveLength(2);
  } finally { f.gate.release(); await result; await f.cleanup(); }
});

test('native page events and new-page completion retain a single tab reference', async () => {
  const f = await fixture('new-page');
  const result = f.manager.newPage(f.session.sessionId);
  const settled = result.catch((error: unknown) => error);
  try {
    await f.entered.pending; f.gate.release(); const page = await result;
    const pages = await f.manager.pageList(f.session.sessionId);
    expect(pages).toHaveLength(1); expect(pages[0]?.pageId).toBe(page.pageId);
    expect(f.manager.info(f.session.sessionId).pageCount).toBe(1);
  } finally { f.gate.release(); await settled; await f.cleanup(); }
});
