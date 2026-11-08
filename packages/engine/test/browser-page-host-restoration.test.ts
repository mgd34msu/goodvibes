/** Exercise the shipped Node-host protocol and the actual manager fallback.
 * Only Playwright's native browser is scripted; the host process, target
 * selection, private remote page mapping and retirement are the real code. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserSessionManager } from '../sdk/src/platform/browser/browser-sessions.js';
import { captureBrowserPageConnection } from '../sdk/src/platform/browser/browser-page-connection-data.js';
import { DRIVER_VERSION } from '../sdk/src/platform/browser/browser-provision-io.js';
import type { BrowserProvisionIo } from '../sdk/src/platform/browser/browser-types.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(change?: 'target' | 'context' | 'document') {
  const root = makeProjectTempDir('browser-host-original-page'), scriptPath = join(root, 'host.mjs');
  const eventsPath = join(root, 'events.json');
  const endpoint = 'ws://127.0.0.1:9222/devtools/browser/retained?private=fixture';
  writeFileSync(scriptPath, readFileSync(new URL('../sdk/src/platform/browser/browser-host.mjs', import.meta.url)));
  const moduleRoot = join(root, 'node_modules', 'playwright-core'); mkdirSync(moduleRoot, { recursive: true });
  writeFileSync(join(moduleRoot, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.62.0', main: 'index.cjs' }));
  const pages = [
    [{ targetId: 'other-target', browserContextId: 'other-context', loaderId: 'other-document' }],
    [{ targetId: change === 'target' ? 'replacement-target' : 'retained-target',
      browserContextId: change === 'context' ? 'replacement-context' : 'retained-context', loaderId: change === 'document' ? 'replacement-document' : 'retained-document' }],
  ];
  // These pages deliberately have the same URL/title. Neither can be used as
  // a substitute for the target/context named by the retained native record.
  writeFileSync(join(moduleRoot, 'index.cjs'), `
    const { writeFileSync } = require('node:fs');
    const events = [], output = ${JSON.stringify(eventsPath)};
    const record = value => { events.push(value); writeFileSync(output, JSON.stringify(events)); };
    const contexts = ${JSON.stringify(pages)}.map(entries => {
      const pages = entries.map(source => ({ source, on() {}, url() { return 'https://merchant.example/checkout'; }, async title() { return 'Checkout'; } }));
      return { pages() { return pages; }, on() {}, async newPage() { record('forbidden-new-page'); throw new Error('No substitute page'); },
        async newCDPSession(page) {
          record('cdp-open:' + page.source.targetId);
          return { async send(method) { record(method + ':' + page.source.targetId);
            return method === 'Target.getTargetInfo' ? { targetInfo: { type: 'page', targetId: page.source.targetId, browserContextId: page.source.browserContextId } }
              : { frameTree: { frame: { id: page.source.targetId, loaderId: page.source.loaderId } } };
          }, async detach() { record('cdp-detach:' + page.source.targetId); } };
        } };
    });
    module.exports = { chromium: { async connectOverCDP(endpoint) {
      if (endpoint !== ${JSON.stringify(endpoint)}) throw new Error('Wrong endpoint');
      record('connected-original-endpoint'); return { contexts() { return contexts; } };
    } } };
  `);
  const io: BrowserProvisionIo = {
    resolveDriver: () => ({ available: true, packageDirectory: '/fixture', cliPath: '/fixture/cli', version: DRIVER_VERSION, error: null }),
    expectedExecutablePath: () => '/fixture/browser', browsersPath: () => '/fixture/cache', pathExists: () => true,
    isExecutableFile: () => true, directoryWritable: () => true, removePath() {},
    runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }), systemBrowserCandidates: () => [], now: () => 0,
  };
  const manager = new BrowserSessionManager({ profileRoot: join(root, 'profiles'), surfaceRoot: 'fixture', io, host: { scriptPath },
    loadDriver: () => ({ chromium: { connectOverCDP: async () => { throw new Error('Exercise native Node fallback'); },
      launchPersistentContext: async () => { throw new Error('No replacement browser'); } } }),
    probeEndpoint: async () => { throw new Error('Recovery must not rediscover a debugger'); },
  });
  cleanup.push(() => manager.shutdown());
  const source = captureBrowserPageConnection({ version: 1, endpoint, targetId: 'retained-target', browserContextId: 'retained-context',
    frames: [{ id: 'retained-target', loaderId: 'retained-document', parentId: null }] });
  const events = (): string[] => JSON.parse(readFileSync(eventsPath, 'utf8')) as string[];
  return { manager, source, events };
}

test('Node-host restoration selects the original target in a later context and exposes no private endpoint', async () => {
  const f = fixture(), restored = await f.manager.restorePage(f.source, {});
  const observed = await f.manager.pageConnection(restored.sessionId, restored.pageId);
  expect(observed).toEqual(f.source);
  expect(f.events()[0]).toBe('connected-original-endpoint');
  expect(f.events()).toContain('cdp-open:other-target');
  expect(f.events()).toContain('cdp-detach:retained-target');
  expect(f.events()).not.toContain('forbidden-new-page');
  expect(JSON.stringify(f.manager.list())).not.toContain('private=fixture');
  const closing = restored.release(); expect(restored.release()).toBe(closing); await closing;
  expect(f.manager.list()).toEqual([]); expect(restored.assertCurrent).toThrow();
});

test.each(['target', 'context', 'document'] as const)('Node-host restoration refuses changed %s and retires the helper', async change => {
  const f = fixture(change);
  await expect(f.manager.restorePage(f.source, {})).rejects.toThrow('unavailable');
  expect(f.manager.list()).toEqual([]);
  expect(f.events()).not.toContain('forbidden-new-page');
  // shutdown must join the actual helper, including a failed attach before a
  // session ID was published, rather than report a metadata-only retirement.
  await f.manager.shutdown();
});
