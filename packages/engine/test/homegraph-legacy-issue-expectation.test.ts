/** Actual older-row compatibility guards must not rehash unchanged selectors. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { isLegacyHomeGraphQualityIssue } from '../platform/src/platform/knowledge/store-issue-replacement.js';
import { createHomeGraphQualityIssueIdentities } from '../platform/src/platform/knowledge/home-graph/quality/issue-identities.js';
import type { KnowledgeIssueRecord } from '../platform/src/platform/knowledge/types.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const space = 'homeassistant:quality-fixture';
const code = 'homegraph.device.missing_manual';
const older = (): KnowledgeIssueRecord => ({
  id: 'hg-issue-adbdae61b9d5a9664a6a521e', nodeId: 'LOCAL_DEVICE', code, severity: 'warning', status: 'open',
  message: 'Earlier generated quality issue', createdAt: 1, updatedAt: 1,
  metadata: { knowledgeSpaceId: space, namespace: space, generated: true, homeGraph: true, subjectId: 'LOCAL_DEVICE' },
});
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of close.splice(0).reverse()) await release(); });

test('actual indexed original issue identity guards reuse the checked older recipe expectation', async () => {
  const root = makeProjectTempDir('legacy-quality-expectation'), store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  close.push(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  await store.init();
  await store.upsertNode({ id: 'LOCAL_DEVICE', kind: 'ha_device', slug: 'fixture', title: 'Synthetic device', status: 'draft', metadata: { knowledgeSpaceId: space } });
  const original = await store.upsertIssue(older());
  const hashes = spyOn(crypto, 'createHash');
  try {
    const identities = createHomeGraphQualityIssueIdentities(store, space, `homegraph:${space}:quality`);
    const identity = identities.prepare(code, 'LOCAL_DEVICE');
    expect(identity.original).toBe(original);
    expect(hashes).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 8; index++) {
      expect(store.getSemanticIssueCandidates({ spaceId: space, namespace: space, code, nodeId: 'LOCAL_DEVICE' })[0]).toBe(original);
      identity.assertCurrent(); identities.assertCurrent();
    }
    expect(hashes).toHaveBeenCalledTimes(1);
    expect(isLegacyHomeGraphQualityIssue(structuredClone(original), space)).toBe(true);
    expect(hashes).toHaveBeenCalledTimes(2); // The copied row independently checks, never inherits original reuse.
  } finally { hashes.mockRestore(); }
});

test('recipe, ID and footprint changes cannot inherit a cached old-row classification', () => {
  const original = older(), hashes = spyOn(crypto, 'createHash');
  try {
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(true);
    expect(hashes).toHaveBeenCalledTimes(1);
    Object.assign(original, { id: 'hg-issue-000000000000000000000000' });
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    expect(hashes).toHaveBeenCalledTimes(1); // Same recipe, current ID still compared.
    Object.assign(original, { id: older().id });
    original.metadata.generated = false;
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    original.metadata.generated = true;
    original.metadata.subjectId = 'other-device';
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    original.metadata.subjectId = 'LOCAL_DEVICE';
    Object.assign(original, { sourceId: 'unrelated-source' });
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    Reflect.deleteProperty(original, 'sourceId');
    original.metadata.knowledgeSpaceId = 'another-space';
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    original.metadata.knowledgeSpaceId = space;
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(true);
    expect(hashes).toHaveBeenCalledTimes(1);
    Object.assign(original, { code: 'homegraph.device.unknown_battery' });
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    expect(hashes).toHaveBeenCalledTimes(2);
    Object.assign(original, { id: 'hg-issue-bc6bee5d2b03fbd74b1be1f3' });
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(true);
    expect(hashes).toHaveBeenCalledTimes(2);
    Object.assign(original, { nodeId: 'different-native-device' }); original.metadata.subjectId = 'different-native-device';
    expect(isLegacyHomeGraphQualityIssue(original, space)).toBe(false);
    expect(hashes).toHaveBeenCalledTimes(3);
  } finally { hashes.mockRestore(); }
});
