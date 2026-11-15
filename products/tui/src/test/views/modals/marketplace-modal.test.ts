import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMarketplaceModalSurface } from '../../../views/modals/marketplace-modal.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../../../runtime/ui-read-models.ts';
import type { EcosystemCatalogEntry, EcosystemCatalogPathOptions, EcosystemEntryKind } from '@/runtime/index.ts';
import { actionCtx, captureCommands, findAction, open, tabRows, tabText } from './modal-surface-test-helpers.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.95)).port); });
afterEach(() => { installJudgmentPort(previousPort); });
async function openReviewed(surface: ConfigModalSurface) {
  await new Promise<void>(resolve => { surface.onOpen?.(resolve); });
  return surface.buildView();
}

function fixedReadModel(snapshot: UiMarketplaceSnapshot): UiReadModel<UiMarketplaceSnapshot> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}
function makeEntry(kind: EcosystemEntryKind, id: string, name: string, sourcePath: string): EcosystemCatalogEntry {
  return { id, kind, name, summary: `${name} summary`, source: sourcePath, tags: [], provenance: 'local', version: '1.0.0' };
}
function seedCatalog(entriesByKind: Partial<Record<EcosystemEntryKind, EcosystemCatalogEntry[]>>): { paths: EcosystemCatalogPathOptions; cleanup: () => void } {
  const root = makeProjectTempDir('gv-marketplace-modal');
  const catalogRoot = join(root, 'ecosystem');
  mkdirSync(catalogRoot, { recursive: true });
  const plural: Record<EcosystemEntryKind, string> = { plugin: 'plugins', skill: 'skills', 'hook-pack': 'hook-packs', 'policy-pack': 'policy-packs' };
  for (const [kind, entries] of Object.entries(entriesByKind)) {
    writeFileSync(join(catalogRoot, `${plural[kind as EcosystemEntryKind]}.json`), JSON.stringify({ version: 1, entries }));
  }
  return { paths: { cwd: root, homeDir: root, projectCatalogRoot: catalogRoot, userCatalogRoot: join(root, 'user-ecosystem') }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('marketplace modal surface', () => {
  test('surface identity', () => {
    expect(createMarketplaceModalSurface({}).name).toBe('marketplace-modal');
  });

  test('honest empty-state copy is byte-preserved (local publish/import catalog, not a remote store)', () => {
    const { paths, cleanup } = seedCatalog({}); // roots wired, catalog empty
    try {
      const view = open(createMarketplaceModalSurface({ ecosystemPaths: paths }));
      const labels = tabRows(view, 'catalog').map((r) => r.label);
      // Byte-for-byte: the exact locked copy (straight quotes, em-dash separators, alignment spacing).
      expect(labels).toContain('This is your local plugin, skill, hook-pack, and policy-pack catalog; not a remote store.');
      expect(labels).toContain("It's empty because nothing has been published or imported into this workspace yet. Entries appear here once you publish a local component or import a bundle.");
      expect(labels).toContain('Populate it');
      expect(labels).toContain('/marketplace publish <kind> <path>  — publish local plugins/skills into the catalog');
      expect(labels).toContain('/marketplace bundle import <path>   — import a catalog bundle from disk');
      expect(labels).toContain('/marketplace catalog review         — inspect the current local catalog posture');
      // No stale "curated" framing survives.
      expect(tabText(view, 'catalog')).not.toContain('No curated marketplace entries found yet');
    } finally { cleanup(); }
  });

  test('degraded (no catalog roots) states roots are not wired', () => {
    const view = open(createMarketplaceModalSurface({ readModel: fixedReadModel({ startupIssues: [], recommendations: [] }) }));
    expect(tabText(view, 'catalog')).toContain("aren't wired into this session");
    // No selectable catalog rows.
    expect(tabRows(view, 'catalog').every((r) => r.selectable === false)).toBe(true);
  });

  test('populated catalog lists entries with install posture and folded compat/risk detail', async () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const view = await openReviewed(createMarketplaceModalSurface({ ecosystemPaths: paths }));
      const text = tabText(view, 'catalog');
      expect(text).toContain('Formatter');
      expect(text).toContain('local');
      expect(text).toContain('catalog 1'); // posture header
      expect(text).toContain('compat'); // folded selection-detail
      expect(tabRows(view, 'catalog').some((r) => r.id === 'plugin:formatter')).toBe(true);
    } finally { cleanup(); }
  });

  test('install routes to the /marketplace command path; uninstall on an un-installed entry is a no-op', async () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const surface = createMarketplaceModalSurface({ ecosystemPaths: paths });
      await openReviewed(surface);
      const row = { id: 'plugin:formatter', label: '' };
      const install = captureCommands();
      surface.onAction?.('install', actionCtx(row, install.extra));
      expect(install.calls).toEqual([['marketplace', ['install', 'plugin', 'formatter']]]);
      // enabledFor gates uninstall off an un-installed entry.
      expect(findAction(surface, 'uninstall')?.enabledFor?.(row, 'catalog')).toBe(false);
      const uninstall = captureCommands();
      surface.onAction?.('uninstall', actionCtx(row, uninstall.extra));
      expect(uninstall.calls).toEqual([]);
    } finally { cleanup(); }
  });

  test('install: the row reads INSTALLED and install is disabled only after the command settles', async () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const surface = createMarketplaceModalSurface({ ecosystemPaths: paths });
      // The hook registered at open stays the surface's render hook, so renders after the command settles are observable.
      let renders = 0;
      await new Promise<void>((resolve) => { surface.onOpen?.(() => { renders++; resolve(); }); });
      const row = { id: 'plugin:formatter', label: '' };
      expect(tabText(surface.buildView(), 'catalog')).not.toContain('INSTALLED');
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const statuses: string[] = [];
      surface.onAction?.('install', actionCtx(row, {
        setStatus: (m: string) => statuses.push(m),
        executeCommand: async () => {
          await gate;
          const dir = join(paths.projectCatalogRoot!, 'installed');
          mkdirSync(dir, { recursive: true });
          const entry = makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x');
          writeFileSync(join(dir, 'plugin-formatter.json'), JSON.stringify({
            version: 1, id: 'plugin-formatter', kind: 'plugin', installedAt: 1, scope: 'project', entry,
            sourcePath: '/tmp/x', targetPath: '/tmp/y', provenanceSummary: 'local',
            runtimeFit: { appVersion: '1', status: 'supported', reasons: [] },
            compatibility: { appVersion: '1', status: 'supported', reasons: [] },
          }));
          return true;
        },
      }));
      // Command still running: nothing changed yet.
      expect(tabText(surface.buildView(), 'catalog')).not.toContain('INSTALLED');
      const rendersBeforeFinish = renders;
      finish();
      for (let i = 0; i < 200 && !statuses.some((m) => m.startsWith('Done')); i++) await nextEventLoop();
      // Only the refresh run after Done may re-read the receipt; the test never re-opens the surface.
      for (let i = 0; i < 200 && renders === rendersBeforeFinish; i++) await nextEventLoop();
      expect(renders).toBeGreaterThan(rendersBeforeFinish);
      expect(tabText(surface.buildView(), 'catalog')).toContain('INSTALLED');
      expect(findAction(surface, 'install')?.enabledFor?.(row, 'catalog')).toBe(false);
      expect(findAction(surface, 'uninstall')?.enabledFor?.(row, 'catalog')).toBe(true);
    } finally { cleanup(); }
  });

  test('read-model recommendations and startup issues surface in the view', async () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const snapshot: UiMarketplaceSnapshot = {
        startupIssues: ['plugin foo failed to load'],
        recommendations: [{ id: 'rec1', title: 'Install bar', reason: 'used often', kind: 'plugin', entry: makeEntry('plugin', 'bar', 'Bar', '/tmp/bar'), command: '/marketplace install plugin bar' }],
      };
      const text = tabText(await openReviewed(createMarketplaceModalSurface({ ecosystemPaths: paths, readModel: fixedReadModel(snapshot) })), 'catalog');
      expect(text).toContain('plugin foo failed to load');
      expect(text).toContain('Install bar');
      expect(text).toContain('/marketplace install plugin bar');
    } finally { cleanup(); }
  });
});

function deferredReviewPort() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const held = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let signal: AbortSignal | undefined;
  const base = fakePort(() => noulAnswer(0.95)).port;
  installJudgmentPort({ ...base, ask: async request => { signal = request.signal; began(); await held; return base.ask(request); } });
  return { started, release, reject, signal: () => signal };
}
const nextEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

describe('marketplace review lifecycle', () => {
  test('pending review cannot install, and close cancels the actual read without a late repaint', async () => {
    const entry = { ...makeEntry('plugin', 'one', 'One', '/synthetic/plugin'), trustNotes: 'Review this synthetic note.' };
    const { paths, cleanup } = seedCatalog({ plugin: [entry] });
    try {
      const held = deferredReviewPort();
      const surface = createMarketplaceModalSurface({ ecosystemPaths: paths });
      let renders = 0;
      surface.onOpen?.(() => { renders++; });
      await held.started;
      expect(tabText(surface.buildView(), 'catalog')).toContain('Reading local catalog');
      const command = captureCommands();
      surface.onAction?.('install', actionCtx({ id: 'plugin:one', label: '' }, command.extra));
      expect(command.calls).toEqual([]);
      surface.onClose?.();
      expect(held.signal()?.aborted).toBe(true);
      held.release(); await nextEventLoop();
      expect(renders).toBe(0);
    } finally { cleanup(); }
  });

  test('a refresh supersedes an old rejected review and keeps only the new catalog', async () => {
    const old = { ...makeEntry('plugin', 'one', 'Old entry', '/synthetic/plugin'), trustNotes: 'Old synthetic note.' };
    const { paths, cleanup } = seedCatalog({ plugin: [old] });
    try {
      const held = deferredReviewPort();
      const surface = createMarketplaceModalSurface({ ecosystemPaths: paths });
      let painted!: () => void;
      let nextPaint = new Promise<void>(resolve => { painted = resolve; });
      surface.onOpen?.(() => painted()); await held.started;
      writeFileSync(join(paths.projectCatalogRoot!, 'plugins.json'), JSON.stringify({ version: 1, entries: [makeEntry('plugin', 'two', 'Current entry', '/synthetic/plugin-two')] }));
      surface.onAction?.('refresh', actionCtx(null)); await nextPaint;
      expect(held.signal()?.aborted).toBe(true);
      expect(tabText(surface.buildView(), 'catalog')).toContain('Current entry');
      held.reject(new Error('old review failed')); await nextEventLoop();
      expect(surface.buildView().degraded).toBeUndefined();
      expect(tabText(surface.buildView(), 'catalog')).not.toContain('Old entry');
    } finally { cleanup(); }
  });

  test('current review failure clears former rows and exposes unavailable state', async () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'one', 'Former entry', '/synthetic/plugin')] });
    try {
      const surface = createMarketplaceModalSurface({ ecosystemPaths: paths });
      await openReviewed(surface);
      expect(tabText(surface.buildView(), 'catalog')).toContain('Former entry');
      writeFileSync(join(paths.projectCatalogRoot!, 'plugins.json'), JSON.stringify({ version: 1, entries: [{ ...makeEntry('plugin', 'one', 'Former entry', '/synthetic/plugin'), trustNotes: 'Read the current synthetic note.' }] }));
      installJudgmentPort(fakePort(() => { throw new Error('current review unavailable'); }).port);
      surface.onAction?.('refresh', actionCtx(null)); await nextEventLoop();
      expect(surface.buildView().degraded).toBe('Catalog load failed: current review unavailable');
      expect(tabRows(surface.buildView(), 'catalog')).toHaveLength(0);
      expect(findAction(surface, 'install')?.enabledFor?.({ id: 'plugin:one', label: '' }, 'catalog')).toBe(false);
    } finally { cleanup(); }
  });
});
