import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ownedAutomationJob, AutomationJobMutationStaleError, projectAutomationTargetRequest } from '../platform/src/platform/automation/job-mutations.ts';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { AutomationJobStore } from '../platform/src/platform/automation/store/jobs.ts';
import { snapshotJudgmentInput } from '../platform/src/platform/gate/judgment-input.ts';
import { findCardNumberShapes } from '../platform/src/platform/security/card-shapes.ts';
import { automationMutationFixture } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const revision = 'aaaa4111-1111-4111-8110-abcdefabcdef';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function automation() {
  const directory = makeProjectTempDir('native-selected-reference');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const first = automationMutationFixture(directory);
  try { await first.store.save([ownedAutomationJob(await first.create(), revision)]); }
  finally { await first.close(); }
  const actual = automationMutationFixture(directory); cleanup.push(() => actual.close());
  await actual.manager.start();
  const selected = (await actual.store.load()).jobs[0];
  if (!selected) throw new Error('Actual automation store lost the producer job');
  const target = actual.manager.retainJobTarget(selected.id, revision);
  const body = { jobId: selected.id, expectedMutationRevision: revision, name: 'Native durable', admission: 'autonomous' };
  return { ...actual, target, body, selected };
}

test('a real producer-owned card-shaped UUID is local while the full request meaning remains admitted', async () => {
  const f = await automation(); expect(findCardNumberShapes(revision, 1)).toHaveLength(1);
  const projected = snapshotJudgmentInput(projectAutomationTargetRequest(f.target, 'automation.jobs.update', { ...f.body, extra: { note: 'Keep this unknown meaning' } }));
  expect(projected).toMatchObject({ name: 'Native durable', extra: { note: 'Keep this unknown meaning' }, expectedMutationRevision: { kind: 'selected-native-revision' } });
  expect(JSON.stringify(projected)).not.toContain(revision);
  expect(f.body.expectedMutationRevision).toBe(revision);
});

test('canonical persistence can establish originally absent parent directories', async () => {
  const f = await automation();
  const store = new AutomationJobStore(join(dirname(f.path), 'native-owned', 'inner', 'jobs.json'));
  const manager = new AutomationManager({ configManager: f.config, jobStore: store, routeBindings: f.routes,
    sessionBroker: f.broker, spawnTask: () => 'synthetic-local-agent', agentStatusProvider: { getStatus: () => null } });
  cleanup.push(() => manager.stop());
  const job = await manager.createJob({ name: 'Nested native', prompt: 'Synthetic local reminder',
    schedule: { kind: 'every', intervalMs: 3_600_000 }, enabled: false });
  if (!job || typeof job.mutationRevision !== 'string') throw new Error('Actual manager lost its producer revision');
  const target = manager.retainJobTarget(job.id, job.mutationRevision);
  expect(snapshotJudgmentInput(projectAutomationTargetRequest(target, 'automation.jobs.update', {
    jobId: job.id, expectedMutationRevision: job.mutationRevision, name: 'Nested native retained',
  }))).toMatchObject({ name: 'Nested native retained', expectedMutationRevision: { kind: 'selected-native-revision' } });
});

for (const kind of ['unknown method', 'foreign selector', 'foreign revision'] as const) {
  test(`automation reference refuses ${kind}`, async () => {
    const f = await automation();
    let body = f.body, method = 'automation.jobs.update';
    if (kind === 'unknown method') method = 'automation.jobs.create';
    if (kind === 'foreign selector') body = { ...body, jobId: 'foreign' };
    if (kind === 'foreign revision') body = { ...body, expectedMutationRevision: 'foreign' };
    const before = readFileSync(f.path);
    expect(() => projectAutomationTargetRequest(f.target, method, body)).toThrow(AutomationJobMutationStaleError);
    expect(readFileSync(f.path)).toEqual(before);
  });
}

for (const tail of [{ unknown: { pan: '4111111111111111' } }, { unknown: { apiKey: 'SYNTHETIC_NOT_A_REAL_KEY' } }]) {
  test('a retained automation reference never suppresses a nested private tail', async () => {
    const f = await automation(); const before = readFileSync(f.path);
    expect(() => snapshotJudgmentInput(projectAutomationTargetRequest(f.target, 'automation.jobs.update', { ...f.body, ...tail }))).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
  });
}

for (const kind of ['ABA', 'stop'] as const) {
  test(`retained automation reference keeps actual ${kind} retirement`, async () => {
    const f = await automation();
    if (kind === 'ABA') {
      await f.manager.updateJob(f.selected.id, { name: 'Temporary' });
      await f.manager.updateJob(f.selected.id, { name: f.selected.name });
    }
    if (kind === 'stop') f.manager.stop();
    const before = readFileSync(f.path);
    expect(() => f.target.assertCurrent()).toThrow(AutomationJobMutationStaleError);
    expect(() => projectAutomationTargetRequest(f.target, 'automation.jobs.update', f.body)).toThrow(AutomationJobMutationStaleError);
    expect(readFileSync(f.path)).toEqual(before);
  });
}

test('a retained automation reference stays current while its job runs', async () => {
  const f = await automation();
  const current = f.manager.getJob(f.selected.id);
  if (!current) throw new Error('Actual manager lost the selected job');
  // What the scheduler writes as a job runs is not part of what was selected.
  (f.manager as unknown as { jobs: Map<string, typeof current> }).jobs.set(current.id, { ...current, nextRunAt: Date.now() + 60_000, runCount: current.runCount + 1 });
  expect(() => f.target.assertCurrent()).not.toThrow();
  expect(f.manager.getJob(f.selected.id)?.mutationRevision).toBe(revision);
});
