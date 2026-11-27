// Proves: A piece of work or a scheduled run acts in another project than the one it was asked in, or in no project (the daemon's own folder) when its request names none.
// Red when: The daemon serves a Work request that names no project instead of refusing it, serves it in another project than its body or its caller's call context names, or spawns a schedule's run without the project its job was made in, or places a schedule 3.5.0 kept with no project in its own folder instead of the folder its 3.5.0 self ran it in.

/**
 * The daemon keeps Work per project (control-plane/project-routing.ts): each Work method runs inside the project its
 * request names, by `workingDirectory` in the body or the calling program's call context, and a request naming none is
 * refused, never served from the daemon's own folder. A schedule keeps the project it was made in and its run is
 * spawned there (automation/manager-runtime-execution.ts). The real catalog and routing, the real automation manager
 * with its stores and session broker; only the agent runtime that would carry out a run is a stand-in, recording the
 * folder it was handed.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { requestProject, routeByProject } from '../platform/src/platform/control-plane/project-routing.ts';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { AutomationJobStore } from '../platform/src/platform/automation/store/jobs.ts';
import { AutomationRunStore } from '../platform/src/platform/automation/store/runs.ts';

const roots: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a Work request is served in the project it names and refused with none; a schedule\'s run is spawned in the project it was made in', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-work-per-project-')));
  roots.push(root);
  const alpha = join(root, 'projects', 'alpha');
  const beta = join(root, 'projects', 'beta');
  const own = join(root, 'daemon-home', 'own-folder');
  // Each project a repository (its identity), alpha with a subfolder a program may be opened in.
  for (const folder of [join(alpha, '.git'), join(alpha, 'src'), join(beta, '.git'), own]) mkdirSync(folder, { recursive: true });

  // Work: a method registered through the daemon's routing; what it sees is the project it is served in.
  const catalog = new GatewayMethodCatalog();
  const made: string[] = [];
  const routed = routeByProject(catalog, async (folder) => { if (!made.includes(folder)) made.push(folder); });
  routed.register(catalog.get('workLedger.snapshot')!, (invocation) => ({ servedIn: requestProject(), body: invocation.body }), { replace: true });
  const context = { principalId: 'owner', principalKind: 'user' as const, admin: true, scopes: ['*'], metadata: {} };
  const work = async (body: Record<string, unknown>, callProject?: string): Promise<string> => {
    try {
      const answer = await catalog.invoke('workLedger.snapshot', { body, query: {}, context: { ...context, ...(callProject ? { call: { project: callProject } } : {}) } }) as { servedIn?: string; body?: Record<string, unknown> };
      return `${answer.servedIn === alpha ? 'alpha' : answer.servedIn === beta ? 'beta' : String(answer.servedIn)}${answer.body && 'workingDirectory' in answer.body ? ' (folder left in body)' : ''}`;
    } catch (error) {
      return `refused ${(error as { code?: string }).code ?? String(error)}`;
    }
  };

  // Schedules: the real manager; the stand-in runtime records the folder each run is handed.
  const configManager = new ConfigManager({ surfaceRoot: 'daemon', workingDir: own, configDir: join(root, 'config') });
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(root, 'bindings.json')) });
  const sessionBroker = new SharedSessionBroker({
    store: new PersistentStore(join(root, 'sessions.json')) as never,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  cleanups.push(() => sessionBroker.stop());
  const spawnedIn: string[] = [];
  const spawnTask = (input: { readonly workingDirectory?: string | undefined }): string => {
    spawnedIn.push(input.workingDirectory === alpha ? 'alpha' : input.workingDirectory === beta ? 'beta' : input.workingDirectory === own ? 'own folder' : String(input.workingDirectory));
    return `agent-${spawnedIn.length}`;
  };
  const manager = new AutomationManager({
    configManager, routeBindings, sessionBroker,
    spawnTask,
    cancelTask: () => {},
    agentStatusProvider: { getStatus: () => null },
  });
  cleanups.push(() => manager.stop());
  const inAlpha = await manager.createJob({ name: 'alpha nightly', prompt: 'tidy alpha', schedule: { kind: 'at', at: Date.now() + 86_400_000 }, enabled: false, workingDirectory: alpha });
  const inBeta = await manager.createJob({ name: 'beta nightly', prompt: 'tidy beta', schedule: { kind: 'at', at: Date.now() + 86_400_000 }, enabled: false, workingDirectory: beta });
  await manager.runNow(inAlpha.id);
  await manager.runNow(inBeta.id);

  // A schedule 3.5.0 kept names no project: 3.5.0 ran it in the folder that daemon worked in (alpha). After the upgrade
  // the daemon works in its own folder and names the one its 3.5.0 self ran in (service-graph.ts), and the run stays there.
  const jobsFile = join(root, 'v350', 'automation-jobs.json');
  const make350 = new AutomationManager({ configManager: new ConfigManager({ surfaceRoot: 'daemon', workingDir: alpha, configDir: join(root, 'config-350') }),
    jobStore: new AutomationJobStore(jobsFile), runStore: new AutomationRunStore(join(root, 'v350', 'automation-runs.json')),
    routeBindings, sessionBroker, cancelTask: () => {}, agentStatusProvider: { getStatus: () => null } });
  const kept350 = await make350.createJob({ name: 'alpha weekly', prompt: 'tidy alpha', schedule: { kind: 'at', at: Date.now() + 86_400_000 }, enabled: false, workingDirectory: alpha });
  make350.stop();
  // Put back as 3.5.0 wrote it: no project on the job.
  const written = JSON.parse(readFileSync(jobsFile, 'utf8')) as { jobs?: Array<{ execution?: Record<string, unknown> }> };
  for (const job of written.jobs ?? []) delete job.execution?.['workingDirectory'];
  writeFileSync(jobsFile, JSON.stringify(written));
  const upgraded = new AutomationManager({ configManager, unplacedJobsFolder: alpha,
    jobStore: new AutomationJobStore(jobsFile), runStore: new AutomationRunStore(join(root, 'v350', 'automation-runs.json')),
    routeBindings, sessionBroker, spawnTask, cancelTask: () => {}, agentStatusProvider: { getStatus: () => null } });
  cleanups.push(() => upgraded.stop());
  await upgraded.runNow(kept350.id);

  expect([
    `named in body: ${await work({ projectId: 'p', workingDirectory: alpha })}`,
    `named by the call: ${await work({ projectId: 'p' }, beta)}`,
    `subfolder: ${await work({ projectId: 'p', workingDirectory: join(alpha, 'src') })}`,
    `named none: ${await work({ projectId: 'p' })}`,
    `schedules ran in: ${spawnedIn.join(', ')}`,
  ]).toEqual([
    'named in body: alpha',
    'named by the call: beta',
    'subfolder: alpha',
    'named none: refused NO_PROJECT',
    // The third: the schedule 3.5.0 kept, run after the upgrade.
    'schedules ran in: alpha, beta, alpha',
  ]);
});
