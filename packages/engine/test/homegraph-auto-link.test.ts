import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { autoLinkHomeGraphSourceWithOutcome } from '../platform/src/platform/knowledge/home-graph/auto-link.js';
import { readHomeGraphState } from '../platform/src/platform/knowledge/home-graph/state.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:auto-link-fixture', installationId = 'auto-link-fixture';
const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A home of `devices` devices; the one named Kitchen oven is model OV-7, the rest are unrelated. */
async function fixture(devices = 1, manual = 'Operating instructions for the OV-7 appliance.') {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-auto-link-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const metadata = { knowledgeSpaceId: spaceId };
  const node = await seedHomeAssistantObservation(store, { id: 'LOCAL_DEVICE', kind: 'ha_device', slug: 'appliance',
    title: 'Kitchen oven', aliases: [], status: 'active', metadata: { ...metadata, model: 'OV-7', private: 'DO_NOT_TRANSMIT' } });
  for (let index = 1; index < devices; index++) await seedHomeAssistantObservation(store, { id: `other-${index}`, kind: 'ha_device',
    slug: `sensor-${index}`, title: `Sensor ${index}`, aliases: [], status: 'active', metadata: { ...metadata, model: `ZX-${index}` } });
  const source = await store.upsertSource({ id: 'LOCAL_SOURCE', connectorId: 'homeassistant', sourceType: 'manual',
    title: 'Appliance manual', canonicalUri: 'https://example.test/manual', tags: ['manual'], status: 'indexed', metadata });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text', title: source.title, summary: manual,
    excerpt: 'Turn the knob to start.', sections: ['Retain the purchase receipt for warranty service.'], links: [], estimatedTokens: 30, structure: {}, metadata });
  const run = (signal?: AbortSignal) => autoLinkHomeGraphSourceWithOutcome({ store, spaceId, installationId, source: store.getSource(source.id)!,
    extraction: store.getExtractionBySourceId(source.id) ?? undefined, state: readHomeGraphState(store, spaceId), signal });
  return { store, node, source, run };
}

/** Items of one fan-out request arrive as `kind__manual`, `subject__s1`. */
function readings(subject: (index: number) => number = () => 0.99, onAsk?: () => Promise<void>) {
  const fake = fakePort((name, question) => {
    const item = name.slice(name.indexOf('__') + 2);
    if (item === 'manual') return noulAnswer(0.99);
    if (item === 'integrationDocumentation') return noulAnswer(0.01);
    if (item === 'relation') return choiceAnswer(question, 'has_manual', 0.99);
    return noulAnswer(subject(Number(item.slice(1))));
  });
  let once = onAsk;
  installJudgmentPort({ ...fake.port, async ask(request) { const run = once; once = undefined; await run?.(); return fake.port.ask(request); } });
  return fake;
}

test('a home of 130 devices links a manual with one request, sending neither row ids nor private fields', async () => {
  const { store, node, run } = await fixture(130); const fake = readings();
  const report = await run();
  expect(report.linked[0]?.node.id).toBe(node.id);
  expect(report.linked[0]?.relation).toBe('has_manual');
  expect(report.counts.linked).toBe(1);
  expect(fake.requests).toHaveLength(1);
  const sent = JSON.stringify(fake.requests);
  for (const local of ['LOCAL_DEVICE', 'LOCAL_SOURCE', 'DO_NOT_TRANSMIT']) expect(sent).not.toContain(local);
  expect(store.listEdges().filter((edge) => edge.fromId === 'LOCAL_SOURCE')).toHaveLength(1);
});

test('a document that names nothing in the home makes no request, and is not read again while nothing changes', async () => {
  const { store, run } = await fixture(5, 'A recipe for bread.'); const fake = readings();
  expect((await run()).outcomes).toEqual([{ sourceId: 'LOCAL_SOURCE', status: 'none', shortlisted: 0 }]);
  expect((await run()).outcomes).toEqual([]);
  expect(fake.requests).toHaveLength(0);
  expect(store.listEdges().filter((edge) => edge.fromId === 'LOCAL_SOURCE')).toHaveLength(0);
});

test('an unsettled subject is reported unread, writes no edge and does not throw', async () => {
  const { store, run } = await fixture(); readings(() => 0.5);
  expect((await run()).outcomes[0]).toMatchObject({ status: 'unread', reason: 'uncertain' });
  expect(store.listEdges().filter((edge) => edge.fromId === 'LOCAL_SOURCE')).toHaveLength(0);
});

test('no decision model leaves the document unread without a write', async () => {
  const { store, run } = await fixture();
  expect((await run()).outcomes[0]).toMatchObject({ status: 'unread' });
  expect(store.listEdges().filter((edge) => edge.fromId === 'LOCAL_SOURCE')).toHaveLength(0);
});

test('a change to the linked device during the reading stops the edge write', async () => {
  const { store, node, run } = await fixture();
  readings(() => 0.99, async () => { await store.upsertNode({ ...store.getNode(node.id)!, summary: 'Changed while reading' }); });
  await expect(run()).rejects.toMatchObject({ reason: 'stale' });
  expect(store.listEdges().filter((edge) => edge.fromId === 'LOCAL_SOURCE')).toHaveLength(0);
});

test('a write elsewhere in the home during the reading does not stop the link', async () => {
  const { store, run } = await fixture(3);
  readings(() => 0.99, async () => { await store.upsertNode({ ...store.getNode('other-1')!, summary: 'Unrelated change' }); });
  expect((await run()).counts.linked).toBe(1);
});
