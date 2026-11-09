/** Source regressions, deliberately unrun until the coding phase is complete. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareKnowledgeSourceRecord } from '../sdk/src/platform/knowledge/store-evidence-writes.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-native-content-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ rootDir: root }), descriptor = await store.create({ text: 'abc', kind: 'document', filename: 'source.txt' });
  const record = store.getRecord(descriptor.id); if (!record) throw new Error('Missing original native record');
  return { root, store, descriptor, record };
}

test('fresh local artifact descriptors, stored records and attachments omit generated checksums', async () => {
  const f = await fixture(), acquired = await f.store.readContent(f.descriptor.id);
  expect(Object.hasOwn(f.descriptor, 'sha256')).toBe(false); expect(Object.hasOwn(f.record, 'sha256')).toBe(false);
  expect(Object.hasOwn(JSON.parse(readFileSync(f.record.metadataPath, 'utf8')), 'sha256')).toBe(false);
  expect(Object.hasOwn(await f.store.toAttachment({ artifactId: f.descriptor.id }), 'sha256')).toBe(false);
  expect(acquired.buffer.toString()).toBe('abc'); expect(typeof acquired.assertCurrent).toBe('function'); expect(() => acquired.assertCurrent?.()).not.toThrow();
});

test.each(['content-rewrite', 'same-bytes-replacement', 'metadata-rewrite', 'delete'] as const)('native retained read detects %s without content rehashing', async change => {
  const f = await fixture(), acquired = await f.store.readContent(f.descriptor.id), bytes = readFileSync(f.record.contentPath);
  if (change === 'content-rewrite') writeFileSync(f.record.contentPath, 'xyz', { mode: 0o600 });
  if (change === 'same-bytes-replacement') { unlinkSync(f.record.contentPath); writeFileSync(f.record.contentPath, bytes, { mode: 0o600 }); }
  if (change === 'metadata-rewrite') writeFileSync(f.record.metadataPath, readFileSync(f.record.metadataPath), { mode: 0o600 });
  if (change === 'delete') expect(f.store.delete(f.descriptor.id)).toBe(true);
  expect(() => acquired.assertCurrent?.()).toThrow(); expect(acquired.buffer.toString()).toBe('abc');
});

test('a serialized descriptor or matching checksum metadata never mints an original native read assertion', async () => {
  const f = await fixture(), acquired = await f.store.readContent(f.descriptor.id), copied = JSON.parse(JSON.stringify(acquired)) as Record<string, unknown>;
  expect(copied['assertCurrent']).toBeUndefined();
  const second = new ArtifactStore({ rootDir: f.root }); expect((await second.readContent(f.descriptor.id)).buffer.toString()).toBe('abc');
  // A later same-name physical replacement cannot be adopted by the original
  // store even when its bytes and old public metadata would compare equal.
  unlinkSync(f.record.contentPath); writeFileSync(f.record.contentPath, 'abc', { mode: 0o600 });
  await expect(f.store.readContent(f.descriptor.id)).rejects.toThrow();
});

test.each(['matching', 'damaged', 'malformed'] as const)('only an actual saved earlier checksum pin is verified on acquisition (%s)', async kind => {
  const f = await fixture();
  const checksum = kind === 'malformed' ? 'invalid' : 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  writeFileSync(f.record.metadataPath, JSON.stringify({ ...f.record, sha256: checksum }), { mode: 0o600 });
  if (kind === 'damaged') writeFileSync(f.record.contentPath, 'xyz', { mode: 0o600 });
  const reopened = new ArtifactStore({ rootDir: f.root });
  if (kind === 'matching') {
    const first = await reopened.readContent(f.descriptor.id); expect(first.buffer.toString()).toBe('abc');
    const second = await reopened.readContent(f.descriptor.id); expect(second.buffer.toString()).toBe('abc');
    expect(reopened.get(f.descriptor.id)?.sha256).toBe(checksum);
  } else await expect(reopened.readContent(f.descriptor.id)).rejects.toThrow();
  // Failed old-format verification preserves evidence, rather than deleting a
  // possibly replaced original file or manufacturing new checksum metadata.
  expect(readFileSync(f.record.contentPath, 'utf8')).toBe(kind === 'damaged' ? 'xyz' : 'abc');
});


test('switching to a fresh native artifact clears an earlier source checksum while ordinary partial edits preserve it', () => {
  const original = prepareKnowledgeSourceRecord({ id: 'source', connectorId: 'manual', sourceType: 'document', status: 'indexed',
    artifactId: 'earlier-artifact', contentHash: 'earlier-published-checksum' }, undefined);
  const replaced = prepareKnowledgeSourceRecord({ connectorId: 'manual', sourceType: 'document', status: 'indexed', artifactId: 'new-native-artifact' }, original);
  expect(replaced.artifactId).toBe('new-native-artifact'); expect(replaced.contentHash).toBeUndefined();
  const partial = prepareKnowledgeSourceRecord({ connectorId: 'manual', sourceType: 'document', status: 'indexed', title: 'New title' }, original);
  expect(partial.artifactId).toBe('earlier-artifact'); expect(partial.contentHash).toBe('earlier-published-checksum');
});
