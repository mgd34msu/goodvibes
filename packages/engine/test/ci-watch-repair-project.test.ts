// Proves: A CI watch's repair works in the project of the push that made the watch, and a watch that names no project starts a repair in no folder.
// Red when: The watch minted at a push stops recording the project of the turn that pushed, or the repair's automation job stops being made in the watch's project, so the repair edits another project or the daemon's own folder; or a watch with no project starts a repair anyway.
/**
 * The real watch minter (the push seam), watch service and watch store, the real seeded-session recipe that starts a
 * repair, and the real automation manager that runs it; the stand-ins are GitHub (the status source `gh` answers
 * through) and the agent runtime, which records the folder each repair is handed.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { CiWatchAutoMinter } from '../platform/src/platform/ci-watch/auto-watch.ts';
import { CiWatchService } from '../platform/src/platform/ci-watch/service.ts';
import { CiWatchStore } from '../platform/src/platform/ci-watch/subscriptions.ts';
import { startCiFixSession } from '../platform/src/platform/control-plane/routes/seeded-sessions.ts';
import type { CiJob, CiStatusSource } from '../platform/src/platform/ci-watch/types.ts';

const roots: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a repair of a watch made at a push in one project is spawned in that project, and a watch with no project starts none', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-ci-repair-project-')));
  roots.push(root);
  const alpha = join(root, 'projects', 'alpha');
  const beta = join(root, 'projects', 'beta');
  const own = join(root, 'daemon-home', 'own-folder');
  for (const folder of [alpha, beta, own]) mkdirSync(folder, { recursive: true });
  const nameOf = (folder: string | undefined): string => folder === alpha ? 'alpha' : folder === beta ? 'beta' : folder === own ? 'the daemon\'s own folder' : String(folder);

  const configManager = new ConfigManager({ surfaceRoot: 'daemon', workingDir: own, configDir: join(root, 'config') });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({
    store: new PersistentStore(join(root, 'sessions.json')) as never,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  cleanups.push(() => sessionBroker.stop());
  const repairedIn: string[] = [];
  const manager = new AutomationManager({
    configManager, routeBindings, sessionBroker,
    spawnTask: (input: { readonly workingDirectory?: string | undefined }): string => { repairedIn.push(nameOf(input.workingDirectory)); return `agent-${repairedIn.length}`; },
    cancelTask: () => {},
    agentStatusProvider: { getStatus: () => null },
  });
  cleanups.push(() => manager.stop());

  // GitHub: every watched commit has one failing GitHub Actions job.
  const failing: CiJob = { headSha: 'a'.repeat(40), runId: '11', jobId: '22', name: 'build', status: 'completed', conclusion: 'failure' };
  const source: CiStatusSource = { fetchJobs: async () => [failing] };
  const service = new CiWatchService({
    store: new CiWatchStore(join(root, 'ci-watches.json')),
    source,
    notifier: async () => 'note-1',
    // The production composition's repair: the seeded session started from the brief the watch composed.
    autonomousRepair: (request) => startCiFixSession(manager, request.brief),
  });
  const minter = new CiWatchAutoMinter({
    service, workingDirectory: own,
    resolveRepoSlug: async (cwd) => (cwd.startsWith(alpha) ? 'acme/alpha' : 'acme/beta'),
    resolveCurrentBranch: async () => 'main',
  });
  const pushedMint = async (project: string): Promise<void> => {
    minter.onToolExecuted('exec', { commands: ['git push origin main'] }, true, { project });
    await (minter as unknown as { readonly mintQueue: Promise<unknown> }).mintQueue;
  };
  await pushedMint(alpha);
  await pushedMint(beta);
  // A turn in the daemon's own folder makes no watch at all (it is no project).
  await pushedMint(own);
  const watches = await service.listWatches();

  // A watch made with no project (not at a push): its repair has no folder to work in.
  const bare = await service.createWatch({ repo: 'acme/bare', ref: 'main', deliveryChannel: 'web' });

  const outcomes: string[] = [];
  for (const watch of [...watches.filter((entry) => entry.repo === 'acme/alpha'), ...watches.filter((entry) => entry.repo === 'acme/beta')]) {
    const result = await service.checkWatch(watch.id);
    outcomes.push(`${watch.repo} (project ${nameOf(watch.project)}): ${result.fixSessionTriggered ? 'repair started' : `no repair: ${result.fixSessionError ?? ''}`}`);
  }
  const bareResult = await service.checkWatch(bare.id);

  expect(watches.map((watch) => `${watch.repo}: ${nameOf(watch.project)}`).sort()).toEqual(['acme/alpha: alpha', 'acme/beta: beta']);
  expect(outcomes).toEqual(['acme/alpha (project alpha): repair started', 'acme/beta (project beta): repair started']);
  expect(repairedIn).toEqual(['alpha', 'beta']);
  expect(bareResult.fixSessionTriggered).toBe(false);
  expect(bareResult.fixSessionError).toContain('names no project');
  expect(repairedIn).toEqual(['alpha', 'beta']);
});
