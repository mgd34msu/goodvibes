import { beforeEach } from 'bun:test';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
const qualityReadings = useKnowledgeAnswerReadings();
beforeEach(() => qualityReadings.set({ homeGraph: [
  ['Front Door Sensor', { batteryApplicable: 0.99, manualApplicable: 0.01 }],
] }));
import { describe, expect, test } from 'bun:test';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';
import { readHomeGraphState } from '../platform/src/platform/knowledge/home-graph/state.js';
import { renderPacketPage } from '../platform/src/platform/knowledge/home-graph/rendering.js';

useHomeGraphFixtures();

const doorSnapshot = (installationId: string) => ({
  installationId,
  devices: [{ id: 'front-door-sensor', name: 'Front Door Sensor' }],
  entities: [{ entityId: 'binary_sensor.front_door', deviceId: 'front-door-sensor', metadata: { attributes: { friendly_name: 'Front Door', device_class: 'door' } } }],
});

describe('Home Graph space resolution', () => {
  test('a reset that names no space is refused and deletes nothing', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('alpha'));
    await service.syncSnapshot(doorSnapshot('beta'));
    const before = store.listNodes(Number.MAX_SAFE_INTEGER).length;

    await expect(service.resetSpace({})).rejects.toThrow(/needs installationId or knowledgeSpaceId/);

    expect(store.listNodes(Number.MAX_SAFE_INTEGER).length).toBe(before);
  });

  test('a no-id dry run reports the default space, never the most recently updated one', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('default'));
    await service.syncSnapshot(doorSnapshot('newer'));

    const preview = await service.resetSpace({ dryRun: true });

    expect(preview.spaceId).toBe('homeassistant:default');
  });

  test('several Home Assistant spaces with no default are an error that names them', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('alpha'));
    await service.syncSnapshot(doorSnapshot('beta'));

    await expect(service.resetSpace({ dryRun: true })).rejects.toThrow(/homeassistant:alpha.*homeassistant:beta|homeassistant:beta.*homeassistant:alpha/);
    await expect(service.exportSpace({})).rejects.toThrow(/Several Home Assistant spaces/);
  });

  test('a space that is not a Home Assistant space is refused by every verb', async () => {
    const { service, store } = createHomeGraphService();
    await store.upsertSource({ id: 'project-plan', connectorId: 'project', sourceType: 'document', title: 'Project plan', canonicalUri: 'project://x/plan', status: 'indexed', metadata: { knowledgeSpaceId: 'project:x' } });

    for (const knowledgeSpaceId of ['project:x', 'default', ' ']) {
      await expect(service.resetSpace({ knowledgeSpaceId, dryRun: true })).rejects.toThrow(/only address Home Assistant spaces/);
      await expect(service.exportSpace({ knowledgeSpaceId })).rejects.toThrow(/only address Home Assistant spaces/);
    }
    expect(store.getSource('project-plan')).not.toBeNull();
  });

  test('a write with no ids and the read that follows address the same space', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('default'));
    await service.syncSnapshot(doorSnapshot('newer'));

    const ingested = await service.ingestNote({ title: 'Router note', body: 'The router lives in the hall closet.' });
    const listed = await service.listSources({});

    expect(listed.spaceId).toBe(ingested.spaceId);
    expect(listed.sources.some((source) => source.id === ingested.source.id)).toBe(true);
  });

  test('a write with no ids lands in the only space that exists, even when it is not the default', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('abc'));

    const ingested = await service.ingestNote({ body: 'The router lives in the hall closet.' });
    const listed = await service.listSources({});

    expect(ingested.spaceId).toBe('homeassistant:abc');
    expect(listed.spaceId).toBe('homeassistant:abc');
    expect(listed.sources.some((source) => source.id === ingested.source.id)).toBe(true);
  });

  test('reindex of two spaces runs both instead of skipping the second', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('alpha'));
    await service.syncSnapshot(doorSnapshot('beta'));

    const [first, second] = await Promise.all([service.reindex({ installationId: 'alpha' }), service.reindex({ installationId: 'beta' })]);

    expect(first.coalesced).toBeUndefined();
    expect(second.coalesced).toBeUndefined();
    expect([first.spaceId, second.spaceId].sort()).toEqual(['homeassistant:alpha', 'homeassistant:beta']);
  });

  test('an ingest with an unknown source target publishes nothing', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('house'));
    const before = store.listSources(Number.MAX_SAFE_INTEGER).length;

    await expect(service.ingestNote({ installationId: 'house', body: 'note', target: { kind: 'source', id: 'no-such-source' } })).rejects.toThrow(/Unknown Home Graph source target/);

    expect(store.listSources(Number.MAX_SAFE_INTEGER).length).toBe(before);
  });
});

describe('Home Graph review', () => {
  test('reopen returns a resolved issue to open', async () => {
    const { service } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('house'));
    const issue = (await service.listIssues({ installationId: 'house', status: 'open' })).issues.find((item) => item.code === 'homegraph.device.unknown_battery')!;
    const resolved = await service.reviewFact({ installationId: 'house', issueId: issue.id, action: 'resolve' });
    expect(resolved.issue?.status).toBe('resolved');

    const reopened = await service.reviewFact({ installationId: 'house', issueId: issue.id, action: 'reopen' });

    expect(reopened.issue?.status).toBe('open');
  });

  test('a forgotten node comes back when reopened', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('house'));
    const device = store.listNodes(Number.MAX_SAFE_INTEGER).find((node) => node.kind === 'ha_device')!;
    const visible = () => readHomeGraphState(store, 'homeassistant:house').nodes.some((node) => node.id === device.id);

    await service.reviewFact({ installationId: 'house', nodeId: device.id, action: 'forget' });
    expect(visible()).toBe(false);
    await service.reviewFact({ installationId: 'house', nodeId: device.id, action: 'reopen' });

    expect(visible()).toBe(true);
  });

  test('a fact value of the wrong type is refused before it reaches the node', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('house'));
    const device = store.listNodes(Number.MAX_SAFE_INTEGER).find((node) => node.kind === 'ha_device')!;

    await expect(service.reviewFact({ installationId: 'house', nodeId: device.id, action: 'edit', value: { batteryPowered: 'maybe' } })).rejects.toThrow(/must be a boolean/);

    expect(store.getNode(device.id)!.metadata.batteryPowered).toBeUndefined();
  });
});

describe('Home Graph packet sharing profiles', () => {
  async function seeded() {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(doorSnapshot('house'));
    const space = { knowledgeSpaceId: 'homeassistant:house' };
    await store.upsertNode({ kind: 'ha_network_node', slug: 'router', title: 'Hall router', metadata: { ...space, homeGraph: true } });
    await store.upsertSource({ id: 'router-manual', connectorId: 'homeassistant', sourceType: 'manual', title: 'Router manual', canonicalUri: 'homegraph://house/router', sourceUri: 'https://example.test/router?token=secret', tags: ['homeassistant'], status: 'indexed', metadata: space });
    await store.upsertIssue({ id: 'open-issue', severity: 'warning', code: 'homegraph.device.unknown_battery', message: 'Front Door Sensor has no known battery type.', status: 'open', metadata: space });
    return { ...readHomeGraphState(store, 'homeassistant:house'), title: 'Packet' };
  }

  test('a guest packet limited to devices shows no network, sources or issues', async () => {
    const markdown = renderPacketPage(await seeded(), { sharingProfile: 'guest', includeFields: ['devices'] });

    expect(markdown).toContain('Devices');
    for (const section of ['Network', 'Sources', 'Open Issues', 'Hall router', 'token=secret']) expect(markdown).not.toContain(section);
  });

  test('a profile can only narrow what it may show, includeFields cannot widen it', async () => {
    const markdown = renderPacketPage(await seeded(), { sharingProfile: 'guest', includeFields: ['network', 'sources'] });

    expect(markdown).not.toContain('Hall router');
    expect(markdown).not.toContain('token=secret');
  });

  test('unknown profiles and field names are refused', async () => {
    const state = await seeded();

    expect(() => renderPacketPage(state, { sharingProfile: 'bogus' })).toThrow(/Unknown sharing profile/);
    expect(() => renderPacketPage(state, { includeFields: ['serial'] })).toThrow(/Unknown packet field/);
    expect(() => renderPacketPage(state, { excludeFields: ['netwrk'] })).toThrow(/Unknown packet field/);
  });

  test('the heading is the title the caller gave, also when a packet kind is set', async () => {
    const markdown = renderPacketPage(await seeded(), { packetKind: 'guest-access' });

    expect(markdown.split('\n')[0]).toBe('# Packet');
  });

  test('the default profile keeps the full packet', async () => {
    const markdown = renderPacketPage(await seeded(), {});

    expect(markdown).toContain('Hall router');
    expect(markdown).toContain('Router manual');
  });
});
