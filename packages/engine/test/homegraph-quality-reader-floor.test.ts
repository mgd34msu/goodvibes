/** Actual opaque-quality publication paths must establish a native reader floor. UNRUN. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import type { KnowledgeIssueUpsertInput } from '../platform/src/platform/knowledge/types.js';
import { nativeReaderCapabilities } from '../platform/src/platform/runtime/native-reader-compatibility.js';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root,{ recursive: true, force: true }); });
for (const path of ['upsert','replace','guarded-replacement','node-issue','import','prepared-ingest'] as const) test(`actual ${path} refuses opaque quality publication before row/cache changes when a reader cohort cannot accept it`, async () => {
  const root = mkdtempSync(join(tmpdir(),'quality-reader-floor-')); roots.push(root); const dbPath = join(root,'knowledge.sqlite'); let allowed = true, declarations = 0;
  const store = new KnowledgeStore({ dbPath, nativeDataWriter: { declare(format) { if (format === 'homegraph-quality-identities-v1') { declarations++; if (!allowed) throw Error('Original reader cohort retained'); } } } }); stores.push(store); await store.init();
  const node = await store.upsertNode({ id: 'native-subject', kind: 'ha_device', slug: 'native-subject', title: 'Device', status: 'draft', metadata: { knowledgeSpaceId: 'house' } });
  const input: KnowledgeIssueUpsertInput = { id: 'hg-issue-aaaaaaaa-aaaa-eaaa-iaaa-aaaaaaaaaaaa', nodeId: node.id, code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Before', metadata: { knowledgeSpaceId: 'house', namespace: 'homegraph:house:quality', homeGraphQualityIdentityVersion: 1 } };
  const original = await store.upsertIssue(input), before = readFileSync(dbPath), snapshot = JSON.stringify(store.getIssue(original.id)); allowed = false; declarations = 0;
  const changed = { ...original, message: 'Changed' };
  const graph = { sources: [], extractions: [], nodes: [], edges: [], issues: [changed] };
  const work = path === 'upsert' ? store.upsertIssue(changed)
    : path === 'replace' ? store.replaceIssueRecord(changed)
    : path === 'guarded-replacement' ? store.replaceIssuesGuarded([changed],'homegraph:house:quality',() => {})
    : path === 'node-issue' ? store.applyGuardedNodeIssueWrites({ nodes: [], issues: [changed] },() => {})
    : path === 'import' ? store.applyImport(graph)
    : store.applyPreparedIngest(graph,async () => ({ nodes: [], edges: [], issues: [changed] }));
  await expect(work).rejects.toThrow('Original reader cohort retained'); expect(declarations).toBe(1); expect(JSON.stringify(store.getIssue(original.id))).toBe(snapshot); expect(readFileSync(dbPath)).toEqual(before);
});

test('the native capability vocabulary declares the actual opaque quality identity format', () => {
  expect(nativeReaderCapabilities('3.1.2').formats).toContain('homegraph-quality-identities-v1');
});
