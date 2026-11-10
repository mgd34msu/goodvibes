/** The built TUI in a real PTY: passive historical records survive a process restart. */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService, prepareConfiguredProjectContext, createConfiguredPlanningStore } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { readPlanningSourceSnapshots } from '../helpers/planning-source-snapshot.ts';
import { closeE2EFixture, inputAreaVisible, launchTui, makeHome, screenText, startStubModel, type TuiSession } from './harness.ts';

const goal = 'Retained PTY retry history';
const question = 'Which saved retry helper belonged in scope?';

test('built terminal history refresh, native view and restart retain saved questions and approval without model input', async () => {
  const model = startStubModel(() => ({ text: 'Unexpected historical model request' }));
  let ownedHome: Awaited<ReturnType<typeof makeHome>> | null = null;
  let failure: { error: unknown } | undefined;
  let tui: TuiSession | undefined;
  let store: ReturnType<typeof createConfiguredPlanningStore> | undefined;
  try {
    const home = await makeHome(model); ownedHome = home;
    const config = new TuiConfigManager({ configDir: join(home.home, '.goodvibes', 'tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
    seedProviderMetadataCacheFixture({ configManager: config, homeDirectory: home.home, workingDirectory: home.workspace });
    const context = await prepareConfiguredProjectContext(config, home.workspace, 'knowledge-wiki.sqlite', { activate: true });
    if (!context.projectId) throw new Error('Missing activated project context');
    store = createConfiguredPlanningStore(config);
    const dbPath = store.storagePath; const projectId = context.projectId;
    const service = new ProjectPlanningService(store);
    await service.upsertState({ projectId, state: {
      goal, scope: 'Historical fixture only', executionApproved: true,
      openQuestions: [{ id: 'saved-question', prompt: question, status: 'open' }],
      answeredQuestions: [{ id: 'saved-answer', prompt: 'Retain the original answer?', answer: 'Yes, retain it exactly.', status: 'answered', answeredAt: 123 }],
      metadata: { approvedAt: 456, approvedFrom: 'saved-operator', active: true, opaque: 'exact-pty-history' },
      tasks: [{ id: 'saved-task', title: 'Historical task claim', status: 'completed' }],
    } });
    await store.close();
    // TUI startup creates/reconciles unrelated bootstrap knowledge_schedules.
    // Retain every raw column and native generation of the planning source set
    // instead of freezing the entire multi-owner SQLite file. This catches raw
    // JSON/provenance changes, replacement, deletion, and added planning rows.
    const sources = await readPlanningSourceSnapshots(dbPath, projectId);
    expect(sources).toHaveLength(2);
    for (const snapshot of sources) {
      expect(snapshot.source).not.toBeNull(); expect(snapshot.raw).not.toBeNull();
      expect(snapshot.generation).toMatch(/^kr-[0-9a-f]{32}$/);
      expect(snapshot.raw?.id).toBe(snapshot.source?.id);
      expect(snapshot.generation).toBe(`kr-${snapshot.raw?.gv_revision}`);
      expect(snapshot.raw?.canonical_uri).toBe(snapshot.source?.canonicalUri);
      expect(JSON.parse(String(snapshot.raw?.metadata))).toEqual(snapshot.source?.metadata);
    }
    const assertSavedPlanning = async () => { expect(await readPlanningSourceSnapshots(dbPath, projectId)).toEqual(sources); };
    for (let generation = 0; generation < 2; generation++) {
      tui = launchTui(home, { cols: 180, rows: 45 });
      await tui.waitForScreen('the input area', inputAreaVisible, 45_000);
      await assertSavedPlanning();
      tui.type('/project-plan history'); tui.key('Enter');
      const history = await tui.waitForScreen('saved passive planning history', screen => screen.includes('Historical planning') && screenText(screen).includes(question), 15_000);
      expect(screenText(history)).toContain(goal);
      expect(screenText(history)).toContain('historical approval yes');
      expect(screenText(history)).toContain('r refresh');
      expect(screenText(history)).not.toContain('approve historical plan');
      expect(screenText(history)).not.toContain('submit answer');
      tui.key('Enter'); tui.key('Enter'); tui.type('r');
      await tui.waitForScreen('refreshed passive planning history', screen => screenText(screen).includes(question) && !screen.includes('Loading historical planning records'), 15_000);
      await assertSavedPlanning();
      tui.key('Escape');
      await tui.waitForScreen('history closed', screen => !screen.includes('Historical planning') && inputAreaVisible(screen), 10_000);
      await assertSavedPlanning();
      tui.type('/project-plan'); tui.key('Enter');
      const native = await tui.waitForScreen('the native work view', screen => screen.includes('Native Work') && screen.includes('No native host data'), 15_000);
      expect(native).not.toContain(goal); expect(native).not.toContain(question);
      tui.key('Escape');
      await tui.waitForScreen('native view closed', screen => !screen.includes('Native Work') && inputAreaVisible(screen), 10_000);
      await assertSavedPlanning();
      expect(tui.alive()).toBe(true); await tui.stop(); tui = undefined;
      await assertSavedPlanning();
      const reopened = new KnowledgeStore({ dbPath }); await reopened.init();
      try {
        // The complete source records, raw values, and native generations were checked above;
        // retain explicit user-facing approval checks after each process exit.
        const saved = await new ProjectPlanningService(reopened).getState({ projectId });
        expect(saved.state?.executionApproved).toBe(true);
        expect(saved.state?.metadata).toEqual({ approvedAt: 456, approvedFrom: 'saved-operator', active: true, opaque: 'exact-pty-history' });
      } finally { await reopened.close(); }
    }
    expect(model.requests).toEqual([]);
  } catch (error) { failure = { error }; throw error; }
  finally {
    try { await closeE2EFixture(ownedHome, () => tui?.stop(), () => store?.close(), () => model.stop()); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure.error, cleanup], 'Planning history assertion/setup and cleanup failed');
      throw cleanup;
    }
  }
}, 150_000);
