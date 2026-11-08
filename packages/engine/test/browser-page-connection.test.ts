import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.js';
import { BrowserEngine } from '../sdk/src/platform/browser/browser-engine.js';
import { remotePage, type BrowserHostClient } from '../sdk/src/platform/browser/browser-host-client.js';
import { observeBrowserPageConnection } from '../sdk/src/platform/browser/browser-page-connection.js';
import { captureBrowserPageConnection } from '../sdk/src/platform/browser/browser-page-connection-data.js';
import { DRIVER_VERSION } from '../sdk/src/platform/browser/browser-provision-io.js';
import type { BrowserProvisionIo } from '../sdk/src/platform/browser/browser-types.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { createUntrustedContentPort, UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { withSecurityReadings } from './helpers/security-readings.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const endpoint = 'ws://127.0.0.1:9222/devtools/browser/original-browser?private=fixture-only';
const target = { targetInfo: { targetId: 'native-tab', type: 'page', browserContextId: 'native-context', url: 'https://merchant.example/private', title: 'Do not retain this page text' } };
const documents = { frameTree: { frame: { id: 'native-tab', loaderId: 'original-document', url: 'https://merchant.example/private' },
  childFrames: [{ frame: { id: 'child-frame', loaderId: 'original-child-document', parentId: 'native-tab', url: 'https://card.example/private' } }] } };
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
function nativeContext(options: { readonly send?: (method: string) => Promise<unknown>; readonly detach?: () => Promise<void> } = {}) {
  const effects: string[] = [];
  const frame = { async evaluate() { return [{ documentUrl: 'https://merchant.example/checkout', tag: 'button', role: 'button', name: 'Place order',
    selector: '#original-submit', value: null, disabled: false, checked: null, depth: 1, submits: true }]; } };
  const page = { url: () => 'https://merchant.example/checkout', title: async () => 'Original checkout',
    frames: () => [frame], mainFrame: () => frame, on() {} } as unknown as Page;
  const context = { pages: () => [page], on() {},
    async newCDPSession(selected: Page) {
      expect(selected).toBe(page); effects.push('cdp-open');
      return { async send(method: string) { effects.push(method); return options.send ? options.send(method) : method === 'Target.getTargetInfo' ? target : documents; },
        async detach() { effects.push('cdp-detach'); await options.detach?.(); } };
    },
  } as unknown as BrowserContext;
  return { context, page, effects };
}
async function attached(options: Parameters<typeof nativeContext>[0] = {}) {
  const f = nativeContext(options), root = makeProjectTempDir('browser-page-connection');
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/synthetic', cliPath: '/synthetic/cli', version: DRIVER_VERSION, error: null }),
    expectedExecutablePath: () => '/synthetic/browser', browsersPath: () => '/synthetic/cache', pathExists: () => true,
    isExecutableFile: () => true, directoryWritable: () => true, removePath() {},
    runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }), systemBrowserCandidates: () => [], now: () => 0,
  };
  const browser = { contexts: () => [f.context], _connection: { close() { f.effects.push('transport-detach'); } } } as unknown as Browser;
  const manager = new BrowserSessionManager({ profileRoot: join(root, 'profiles'), surfaceRoot: 'synthetic', io,
    loadDriver: () => ({ chromium: { connectOverCDP: async (actual: string) => { expect(actual).toBe(endpoint); return browser; },
      launchPersistentContext: async () => { throw new Error('Recovery must not launch a substitute browser'); } } }),
    probeEndpoint: async () => ({ endpoint: 'http://127.0.0.1:9222', webSocketDebuggerUrl: endpoint }),
  });
  cleanup.push(() => manager.shutdown());
  const session = await manager.attach({ cdpEndpoint: 'http://127.0.0.1:9222' });
  if (!session.activePageId) throw new Error('Missing original page');
  return { ...f, manager, session, pageId: session.activePageId };
}
function engineFor(manager: BrowserSessionManager): BrowserEngine {
  return new BrowserEngine(manager, { screenshotDirectory: makeProjectTempDir('browser-source-screenshots'),
    untrusted: createUntrustedContentPort({ surface: 'web-page', toolName: 'browser-source-fixture', ledger: new UntrustedContentLedger() }) });
}

test('the actual session/engine retain the originally selected browser endpoint and native tab/documents privately', async () => {
  const f = await attached(), engine = engineFor(f.manager);
  const source = await engine.capturePageConnection({ sessionId: f.session.sessionId, pageId: f.pageId }, {});
  expect(source).toMatchObject({ version: 1, endpoint, targetId: 'native-tab', browserContextId: 'native-context' });
  expect(source?.frames).toEqual([
    { id: 'child-frame', loaderId: 'original-child-document', parentId: 'native-tab' },
    { id: 'native-tab', loaderId: 'original-document', parentId: null },
  ]);
  expect(f.effects).toEqual(['cdp-open', 'Target.getTargetInfo', 'Page.getFrameTree', 'cdp-detach']);
  expect(JSON.stringify(f.manager.list())).not.toContain('private=fixture-only');
  expect(JSON.stringify(source)).not.toContain('merchant.example'); expect(JSON.stringify(source)).not.toContain('Do not retain');
  expect(Object.isFrozen(source?.frames)).toBe(true);
});

test('actual native snapshot and protocol observations are retained together through the serving engine', async () => {
  await withSecurityReadings({}, async requests => {
    const f = await attached(), engine = engineFor(f.manager), target = { sessionId: f.session.sessionId, pageId: f.pageId };
    const snapshot = await engine.snapshot(target);
    const recovery = await engine.captureCheckoutRecovery(target, ['e1'], {});
    expect(recovery?.connection.endpoint).toBe(endpoint);
    expect(recovery?.controls.snapshotId).toBe(snapshot['snapshotId']);
    expect(recovery?.controls.controls[0]).toMatchObject({ ref: 'e1', selector: '#original-submit',
      metadata: { name: 'Place order', documentUrl: 'https://merchant.example/checkout' } });
    expect(requests).toEqual([]);
  });
});

test('a replacement snapshot during native protocol capture cannot replace the originally selected controls', async () => {
  await withSecurityReadings({}, async () => {
    const entered = barrier(), release = barrier();
    const f = await attached({ send: async method => { if (method === 'Target.getTargetInfo') { entered.release(); await release.wait; return target; } return documents; } });
    cleanup.push(release.release);
    const engine = engineFor(f.manager), selected = { sessionId: f.session.sessionId, pageId: f.pageId };
    await engine.snapshot(selected);
    const pending = engine.captureCheckoutRecovery(selected, ['e1'], {}).catch(error => error as unknown);
    await entered.wait; await engine.snapshot(selected); release.release();
    expect(await pending).toBeInstanceOf(Error);
    expect(f.effects.at(-1)).toBe('cdp-detach');
  });
});

test('native reading uses the Node host original page mapping, not a serialized page id', async () => {
  const calls: Array<{ command: string; params: unknown }> = [];
  const client = { async call(command: string, params: unknown) { calls.push({ command, params }); return { target, documents }; } } as unknown as BrowserHostClient;
  const page = remotePage(client, 'host-original-page', 'https://merchant.example/checkout');
  const source = await observeBrowserPageConnection({ newCDPSession() { throw new Error('Do not use a local CDP context for a remote page'); } } as unknown as BrowserContext, page, endpoint, () => {});
  expect(calls).toEqual([{ command: 'pageConnection', params: { pageId: 'host-original-page' } }]);
  expect(source.targetId).toBe('native-tab');
});

test('retiring while protocol I/O is pending discards the result and drains native detach before shutdown returns', async () => {
  const entered = barrier(), answer = barrier(), detachEntered = barrier(), detach = barrier();
  const f = await attached({ send: async method => { if (method === 'Target.getTargetInfo') { entered.release(); await answer.wait; return target; } return documents; },
    detach: async () => { detachEntered.release(); await detach.wait; } });
  cleanup.push(answer.release, detach.release);
  const reading = f.manager.pageConnection(f.session.sessionId, f.pageId).catch(error => error as unknown);
  await entered.wait; let drained = false; const closing = f.manager.shutdown().then(() => { drained = true; });
  answer.release(); await detachEntered.wait; expect(drained).toBe(false);
  detach.release(); const failure = await reading; await closing;
  expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain('fixture-only');
  expect(f.effects).not.toContain('Page.getFrameTree'); expect(drained).toBe(true);
});

test('an owner changed during detach cannot publish an otherwise successful observation', async () => {
  let current = true;
  const f = nativeContext({ detach: async () => { current = false; } });
  await expect(observeBrowserPageConnection(f.context, f.page, endpoint, () => { if (!current) throw new Error('Retired owner'); })).rejects.toThrow('unavailable');
  expect(f.effects.at(-1)).toBe('cdp-detach');
});

test('private connection parsing rejects disconnected/cyclic frame graphs and accessors without authority or page I/O', async () => {
  const f = nativeContext(), source = await observeBrowserPageConnection(f.context, f.page, endpoint, () => {});
  expect(() => captureBrowserPageConnection({ ...source, frames: [...source.frames, { id: 'foreign', loaderId: 'loader', parentId: 'absent' }] })).toThrow('unavailable');
  expect(() => captureBrowserPageConnection({ ...source, frames: [{ id: 'root', loaderId: 'loader', parentId: null },
    { id: 'a', loaderId: 'loader-a', parentId: 'b' }, { id: 'b', loaderId: 'loader-b', parentId: 'a' }] })).toThrow('unavailable');
  let getter = false;
  expect(() => captureBrowserPageConnection({ ...source, get endpoint() { getter = true; return endpoint; } })).toThrow();
  expect(getter).toBe(false);
});
