import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ownedAutomationJob, AutomationJobMutationStaleError, projectAutomationTargetRequest } from '../platform/src/platform/automation/job-mutations.ts';
import { AutomationManager } from '../platform/src/platform/automation/manager-runtime.ts';
import { AutomationJobStore } from '../platform/src/platform/automation/store/jobs.ts';
import { snapshotJudgmentInput } from '../platform/src/platform/gate/judgment-input.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema-version.ts';
import { ProjectPlanningService } from '../platform/src/platform/knowledge/project-planning/service.ts';
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

async function planning() {
  const directory = makeProjectTempDir('planning-selected-reference');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const clock = spyOn(Date, 'now').mockReturnValue(70_000); cleanup.push(() => clock.mockRestore());
  const fake = fakePort(name => { if (name !== 'specified') throw new Error(`Unexpected planning question: ${name}`); return noulAnswer(0.01); });
  const previous = installJudgmentPort(fake.port); cleanup.push(() => { installJudgmentPort(previous); });
  const path = join(directory, 'planning.sqlite'); let store = new KnowledgeStore({ dbPath: path }); cleanup.push(() => store.close());
  let service = new ProjectPlanningService(store);
  const state = { goal: 'Preserve retry history', scope: 'Retry helper only', executionApproved: true,
    tasks: [{ id: 'retry', title: 'Keep retry records', verification: ['Run retry tests'] }], metadata: { active: true, owner: 'tui' },
  };
  await service.upsertState({ projectId: 'proj', state });
  const first = await service.getState({ projectId: 'proj' });
  if (!first.source) throw new Error('Planning fixture lost its native source');
  // A native opaque revision can incidentally contain PAN-shaped digits. Seed
  // that exact valid historical SQLite value without hashing unrelated source
  // bytes or brute-forcing random revisions. Restore the understood native
  // trigger before reopening; every later conditional write uses the real one.
  await store.close();
  const setup = new SQLiteStore(path, { coordinated: true }); await setup.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  try {
    const trigger = setup.exec("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='knowledge_sources_revision_update'")[0]?.values[0]?.[0];
    if (typeof trigger !== 'string') throw new Error('Native source revision trigger is missing');
    setup.run('DROP TRIGGER knowledge_sources_revision_update');
    setup.run('UPDATE knowledge_sources SET gv_revision = ? WHERE id = ?', ['aaaa4111111111111111bbbbbbbbbbbb', first.source.id]);
    setup.run(trigger); await setup.save();
  } finally { setup.close(); }
  store = new KnowledgeStore({ dbPath: path }); await store.init(); service = new ProjectPlanningService(store);
  const selected = await service.getState({ projectId: 'proj' });
  if (!selected.source || !selected.revision) throw new Error('Planning fixture lost its native revision');
  expect(findCardNumberShapes(selected.revision.generation, 1)).toHaveLength(1);
  return { store, service, path, fake, state, selected: { ...selected, source: selected.source, revision: selected.revision } };
}

test('an actual saved card-shaped opaque revision supports selected and native conditional planning publication', async () => {
  const f = await planning();
  const result = await f.service.applyStateAction({ projectId: 'proj', expected: { kind: 'revision', revision: f.selected.revision }, action: { kind: 'dismiss' } });
  expect(result).toMatchObject({ applied: true, state: { metadata: { active: false } } });
  const next = await planning();
  await next.service.upsertState({ projectId: 'proj', state: { ...next.state, goal: 'A newer historical record' } });
  expect((await next.service.getState({ projectId: 'proj' })).state?.goal).toBe('A newer historical record');
});

for (const tail of [{ unknown: { pan: '4111111111111111' } }, { unknown: { apiKey: 'SYNTHETIC_NOT_A_REAL_KEY' } }]) {
  test('matched planning input and write references still refuse complete private tails without new dispatch', async () => {
    const f = await planning(), before = readFileSync(f.path), requests = f.fake.requests.length;
    await expect(f.service.applyStateAction({ projectId: 'proj', expected: { kind: 'revision', revision: f.selected.revision }, action: { kind: 'dismiss' }, ...tail })).rejects.toThrow();
    await expect(f.store.upsertOwnedCanonicalSources([{ input: { ...f.selected.source, ...tail }, generation: f.selected.revision.generation }], () => {}, () => {})).rejects.toThrow();
    const writes = [{ input: f.selected.source, generation: f.selected.revision.generation }];
    Object.defineProperty(writes, 'unknown', { value: tail.unknown, enumerable: true });
    await expect(f.store.upsertOwnedCanonicalSources(writes, () => {}, () => {})).rejects.toThrow();
    expect(f.fake.requests.length).toBe(requests); expect(readFileSync(f.path)).toEqual(before);
  });
}

test('forged planning revision keeps ordinary privacy admission and cannot grant a native write', async () => {
  const f = await planning(), before = readFileSync(f.path), requests = f.fake.requests.length;
  const generation = `${'a'.repeat(24)}4111111111111111${'a'.repeat(24)}`;
  await expect(f.service.applyStateAction({ projectId: 'proj', expected: { kind: 'revision', revision: { ...f.selected.revision, generation } }, action: { kind: 'dismiss' } })).rejects.toMatchObject({ problem: 'card-material' });
  await expect(f.store.upsertOwnedCanonicalSources([{ input: f.selected.source, generation }], () => {}, () => {})).rejects.toMatchObject({ problem: 'card-material' });
  expect(f.fake.requests.length).toBe(requests); expect(readFileSync(f.path)).toEqual(before);
});


for (const state of ['existing', 'absent'] as const) {
  test(`an unmatched ${state} planning source screens a forged revision before its held result`, async () => {
    const f = await planning();
    const store = state === 'existing' ? f.store : new KnowledgeStore({ dbPath: `${f.path}.absent` });
    if (state === 'absent') { await store.init(); cleanup.push(() => store.close()); }
    const service = state === 'existing' ? f.service : new ProjectPlanningService(store);
    const path = store.storagePath, before = existsSync(path) ? readFileSync(path) : undefined, requests = f.fake.requests.length;
    const generation = `${'a'.repeat(24)}4111111111111111${'a'.repeat(24)}`;
    await expect(service.applyStateAction({ projectId: 'proj',
      expected: { kind: 'revision', revision: { ...f.selected.revision, generation } }, action: { kind: 'dismiss' },
    })).rejects.toMatchObject({ problem: 'card-material' });
    expect(f.fake.requests.length).toBe(requests);
    expect(existsSync(path)).toBe(before !== undefined);
    if (before !== undefined) expect(readFileSync(path)).toEqual(before);
  });

  test(`an ordinary unmatched ${state} planning revision keeps its effect-free held result`, async () => {
    const f = await planning();
    const store = state === 'existing' ? f.store : new KnowledgeStore({ dbPath: `${f.path}.ordinary-absent` });
    if (state === 'absent') { await store.init(); cleanup.push(() => store.close()); }
    const service = state === 'existing' ? f.service : new ProjectPlanningService(store);
    const path = store.storagePath, before = existsSync(path) ? readFileSync(path) : undefined, requests = f.fake.requests.length;
    const generation = 'a'.repeat(64);
    expect(generation).not.toBe(f.selected.revision.generation);
    const result = await service.applyStateAction({ projectId: 'proj',
      expected: { kind: 'revision', revision: { ...f.selected.revision, generation } }, action: { kind: 'dismiss' },
    });
    expect(result).toMatchObject({ applied: false, reason: state === 'existing' ? 'state-changed' : 'no-state' });
    expect(f.fake.requests.length).toBe(requests);
    expect(existsSync(path)).toBe(before !== undefined);
    if (before !== undefined) expect(readFileSync(path)).toEqual(before);
  });
}

test('a matching generation alone cannot project a foreign planning source identity', async () => {
  const f = await planning(), before = readFileSync(f.path), requests = f.fake.requests.length;
  const revision = { ...f.selected.revision, sourceId: 'foreign-source' };
  await expect(f.service.applyStateAction({ projectId: 'proj',
    expected: { kind: 'revision', revision }, action: { kind: 'dismiss' },
  })).rejects.toMatchObject({ problem: 'card-material' });
  expect(f.fake.requests.length).toBe(requests);
  expect(readFileSync(f.path)).toEqual(before);
});
