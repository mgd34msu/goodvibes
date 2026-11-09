import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decisionModelPolicyState, installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { HomeGraphService } from '../platform/src/platform/knowledge/home-graph/service.js';
import { runHomeGraphIssueTriage } from '../platform/src/platform/knowledge/home-graph/triage.js';
import { rankHomeGraphPageCandidates } from '../platform/src/platform/knowledge/home-graph/page-priority.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], services: HomeGraphService[] = [];
let previous: JudgmentPort | undefined, installed = false;
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  if (installed) installJudgmentPort(previous); installed = false;
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-classic-homegraph-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init();
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifacts); services.push(service);
  return { store, service, artifacts, dbPath };
}
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision chain outage'); });
  previous = installJudgmentPort(fake.port); installed = true; return fake.requests;
}
const under = <T>(policy: DecisionModelPolicy, operation: () => T) => withDecisionModelPolicy(() => policy, operation);

test('Classic Home Graph snapshots retain structural facts and explicitly omit automatic semantic work', async () => {
  const { store, service } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const result = await service.syncSnapshot({ installationId: 'home-one', title: 'Synthetic home',
      devices: [{ id: 'router', name: 'Network router' }], entities: [{ entity_id: 'sensor.router', name: 'Router sensor' }] });
    expect(result.provenance).toBe('classic');
    expect(result.quality).toMatchObject({ status: 'held', reason: 'decision-model-disabled' });
    expect(result.generated).toMatchObject({ provenance: 'classic', reason: 'decision-model-disabled', artifacts: 0, devicePassports: 0 });
    expect(result.counts.devices).toBe(1); expect(result.counts.entities).toBe(1);
    expect(store.listNodes().some(node => node.title === 'Network router')).toBe(true);
    const browse = await service.browse({ installationId: 'home-one' });
    expect(browse.nodes.some(node => node.title === 'Network router')).toBe(true);
    expect((await service.status({ installationId: 'home-one' })).sourceCount).toBeGreaterThan(0);
    await service.map({ installationId: 'home-one' });
    expect((await service.listPages({ installationId: 'home-one' })).provenance).toBe('classic');
  });
  expect(requests).toHaveLength(0);
});

test('Classic explicit source storage and declared links survive restart without fake activation receipts', async () => {
  const { store, service, artifacts, dbPath } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const result = await service.ingestNote({ installationId: 'home-one', title: 'Network note', body: '# Network\n\nKeep power connected.',
      target: { kind: 'device', id: 'declared-router', title: 'Caller declared router' } });
    expect(result.provenance).toBe('classic'); expect(result.linked).toBeDefined();
    expect(result.extraction?.metadata).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated' });
    const target = store.getNode(result.linked!.toId);
    expect(target?.metadata).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated', existence: 'caller-declared', nodeObservation: { origin: 'link-declaration' } });
    expect(target?.metadata.nodeActivation).toBeUndefined();
    const exported = await service.exportSpace({ installationId: 'home-one' }); expect(exported).toBeDefined();
    await service.dispose(); await store.close();
    const reopened = new KnowledgeStore({ dbPath }); stores.push(reopened); await reopened.init();
    const restarted = new HomeGraphService(reopened, artifacts); services.push(restarted);
    const browse = await restarted.browse({ installationId: 'home-one' });
    expect(browse.sources.some(source => source.id === result.source.id)).toBe(true);
    expect(browse.nodes.some(node => node.id === target?.id)).toBe(true);
    await restarted.unlinkKnowledge({ installationId: 'home-one', sourceId: result.source.id,
      target: { kind: 'device', id: 'declared-router' } });
    expect(reopened.listEdges().some(edge => edge.id === result.linked?.id)).toBe(false);
  });
  expect(requests).toHaveLength(0);
});

test('Preferred auto-link outage preserves an already stored source and does not invent a link', async () => {
  const { store, service } = await fixture(); const requests = outage();
  await under('Classic - Off', () => service.syncSnapshot({ installationId: 'home-one', devices: [{ id: 'router', name: 'Network router' }] }));
  await under('Preferred', async () => {
    const result = await service.ingestNote({ installationId: 'home-one', title: 'Router instructions', body: '# Router\n\nNetwork router instructions.' });
    expect(result).toMatchObject({ provenance: 'classic', autoLinkAssessment: 'not-evaluated' });
    expect(result.linked).toBeUndefined(); expect(store.getSource(result.source.id)?.status).toBe('indexed');
    expect(store.listSources().filter(source => source.id === result.source.id)).toHaveLength(1);
    expect(decisionModelPolicyState().operation).toBe('classic');
  });
  expect(requests.length).toBeGreaterThan(0);
});

test('Classic semantic Home Graph features refuse before any artifact or graph mutation', async () => {
  const { store, service, artifacts } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const before = JSON.stringify(store.status());
    for (const run of [
      () => service.ask({ installationId: 'home-one', query: 'What is missing?' }),
      () => service.reindex({ installationId: 'home-one' }),
      () => service.refreshDevicePassport({ installationId: 'home-one', deviceId: 'router' }),
      () => service.generateRoomPage({ installationId: 'home-one', roomId: 'room' }),
      () => service.generatePacket({ installationId: 'home-one' }),
      () => service.runRefinement({ installationId: 'home-one' }),
      () => runHomeGraphIssueTriage({ store, installationId: 'home-one' }),
    ]) await expect(run()).rejects.toMatchObject({ code: 'decision-models-disabled' });
    expect(JSON.stringify(store.status())).toBe(before); expect(artifacts.list()).toHaveLength(0);
  });
  expect(requests).toHaveLength(0);
});

test.each(['Classic - Off', 'Preferred'] as const)('%s generated-page listing preserves catalog order without priority probabilities', async policy => {
  const requests = outage();
  await under(policy, async () => {
    const candidates = [{ id: 'later', title: 'Zebra' }, { id: 'earlier', title: 'Alpha' }];
    expect(await rankHomeGraphPageCandidates({ candidates, content: row => ({ title: row.title }), purpose: 'List references' })).toEqual(candidates);
    expect(policy === 'Classic - Off' ? requests.length === 0 : requests.length > 0).toBe(true);
  });
});

test('Classic explicit links cannot replace a node from another knowledge space', async () => {
  const { store, service } = await fixture(); const requests = outage();
  await under('Classic - Off', async () => {
    const foreign = await service.ingestNote({ installationId: 'home-other', title: 'Other note', body: 'Other home.',
      target: { kind: 'device', id: 'private-router', title: 'Foreign device' } });
    const local = await service.ingestNote({ installationId: 'home-one', title: 'Local note', body: 'Local home.' });
    const target = store.getNode(foreign.linked!.toId);
    await expect(service.linkKnowledge({ installationId: 'home-one', sourceId: local.source.id,
      target: { kind: 'node', id: target!.id } })).rejects.toThrow('another knowledge space');
    expect(store.getNode(target!.id)).toBe(target);
  });
  expect(requests).toHaveLength(0);
});
