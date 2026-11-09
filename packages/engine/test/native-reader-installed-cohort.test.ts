/** Regression source intentionally UNRUN during the coding-first pass. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createNativeDataWriteOwner, nativeReaderCapabilities, NATIVE_READER_REQUIREMENT_FILE } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { createInstalledReaderCohort } from '../platform/src/platform/runtime/native-reader-cohort.js';
import { clientReaderAsset, clientReaderPayloadPaths, clientReaderMemberPath, type ClientReaderArtifact, type ClientReaderPackage } from '../platform/src/platform/runtime/client-reader-artifact.js';
import { sha256 } from '../platform/src/platform/runtime/self-update.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
function fixture() {
  const root = makeProjectTempDir('installed-reader-cohort'), execPath = join(root, 'goodvibes'); writeFileSync(execPath, 'Own admitted terminal', { mode: 0o755 });
  const cohort = createInstalledReaderCohort({ execPath, version: '3.1.2', platform: 'darwin', arch: 'x64' });
  const owner = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {}, readerCohort: cohort });
  return { root, execPath, cohort, owner, file: join(root, NATIVE_READER_REQUIREMENT_FILE) };
}
function peer(root: string, packageName: ClientReaderPackage = '@goodvibes-jev/agent', formats: readonly string[] = nativeReaderCapabilities('3.1.2').formats, version = '3.1.2', historicalProgramOnly = false) {
  const program = packageName === '@goodvibes-jev/tui' ? 'goodvibes' : packageName === '@goodvibes-jev/agent' ? 'goodvibes-agent' : 'goodvibes-daemon';
  const path = join(root, program), bytes = Buffer.from(`Published ${program} ${version}`), target = 'darwin-x64';
  writeFileSync(path, bytes, { mode: 0o755 });
  const files: Array<ClientReaderArtifact['files'][number]> = [{ path: clientReaderAsset(packageName, target), sha256: sha256(bytes), mode: 0o755, size: bytes.length }];
  const artifact: ClientReaderArtifact = { schema: 1, packageName, version, target, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40),
    files, readers: { schema: 1, version, formats } };
  if (packageName === '@goodvibes-jev/daemon' && !historicalProgramOnly) for (const member of clientReaderPayloadPaths(packageName, target).slice(1)) {
    const payload = Buffer.from('Published companion ' + member), memberPath = clientReaderMemberPath(path, artifact, member);
    mkdirSync(dirname(memberPath), { recursive: true }); writeFileSync(memberPath, payload, { mode: 0o644 });
    files.push({ path: member, sha256: sha256(payload), mode: 0o644, size: payload.length });
  }
  writeFileSync(path + '.readers.json', JSON.stringify(artifact), { mode: 0o644 }); return { path, bytes, artifact };
}

test('an installed historical peer without affirmative readers cannot be exposed to a new shared format', async () => {
  const f = fixture(), peerPath = join(f.root, 'goodvibes-agent'), data = join(f.root, 'knowledge.sqlite'); writeFileSync(peerPath, 'Historical Agent', { mode: 0o755 });
  const store = new KnowledgeStore({ dbPath: data, nativeDataWriter: f.owner });
  try {
    await expect(store.upsertSource({ connectorId: 'fixture', sourceType: 'document', title: 'Held shared publication', canonicalUri: 'fixture://held', status: 'indexed' })).rejects.toThrow();
    expect(existsSync(f.file)).toBe(false); expect(existsSync(data)).toBe(false); expect(readFileSync(peerPath, 'utf8')).toBe('Historical Agent');
  } finally { await store.close(); }
});

test.each(['old-version', 'same-version-missing-format'] as const)('%s peers do not gain support from version labels', failure => {
  const f = fixture(); peer(f.root, '@goodvibes-jev/agent', failure === 'old-version' ? nativeReaderCapabilities('3.1.2').formats : [], failure === 'old-version' ? '3.1.1' : '3.1.2');
  expect(() => f.owner.declare('contract-review-observations-v1')).toThrow('cohort'); expect(existsSync(f.file)).toBe(false);
});

test('actual compatible peer payloads are admitted once and no unchanged publication rehashes them', () => {
  const f = fixture(); peer(f.root); const hash = spyOn(crypto, 'createHash');
  try {
    f.owner.declare('knowledge-schema-v12'); expect(hash).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 5; index++) f.owner.declare('knowledge-schema-v12');
    f.owner.declare('configuration-policy-epochs-v2'); expect(hash).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(f.file, 'utf8')).formats).toEqual(['knowledge-schema-v12', 'configuration-policy-epochs-v2']);
  } finally { hash.mockRestore(); }
});

test('an incompatible present daemon is checked even when the current writer is a terminal', () => {
  const f = fixture(); peer(f.root, '@goodvibes-jev/daemon', []);
  expect(() => f.owner.declare('contract-review-observations-v1')).toThrow('cohort'); expect(existsSync(f.file)).toBe(false);
});

test('an unrelated product transaction withholds the new floor and a settled retry remains possible', () => {
  const f = fixture(); peer(f.root); const claim = join(f.root, 'goodvibes-daemon.update-transaction'); writeFileSync(claim, 'Other native owner');
  expect(() => f.owner.declare('knowledge-schema-v12')).toThrow('Another native owner'); expect(existsSync(f.file)).toBe(false);
  unlinkSync(claim); expect(() => f.owner.declare('knowledge-schema-v12')).not.toThrow();
});

test('a peer replaced after reading its profile cannot cross the floor publication barrier', () => {
  const f = fixture(), other = peer(f.root); let checks = 0;
  const owner = createNativeDataWriteOwner({ execPath: f.execPath, version: '3.1.2', assertCurrent() {}, readerCohort(formats) {
    const current = f.cohort(formats);
    return () => { current(); if (++checks === 2) writeFileSync(other.path, 'Foreign replacement peer'); current(); };
  } });
  expect(() => owner.declare('contract-review-observations-v1')).toThrow(); expect(existsSync(f.file)).toBe(false);
});

test('already declared accounting uses its saved floor after execution cancellation without introducing another format', () => {
  const f = fixture(); peer(f.root); let active = true;
  const owner = createNativeDataWriteOwner({ execPath: f.execPath, version: '3.1.2', readerCohort: f.cohort, assertCurrent() { if (!active) throw new Error('Execution cancelled'); } });
  owner.declare('payment-retained-holds-v2'); const before = readFileSync(f.file); active = false;
  expect(() => owner.declare('payment-retained-holds-v2')).not.toThrow(); expect(readFileSync(f.file)).toEqual(before);
  expect(() => owner.declare('configuration-policy-epochs-v2')).toThrow(); expect(readFileSync(f.file)).toEqual(before);
});

// Historical one-file Darwin metadata remains readable for history; it cannot
// certify the installed daemon's vector/SQLite companions for a new data floor.
test('historical Darwin daemon reader metadata cannot approve a new shared format', () => {
  const f = fixture(), daemon = peer(f.root, '@goodvibes-jev/daemon', nativeReaderCapabilities('3.1.2').formats, '3.1.2', true);
  expect(daemon.artifact.files).toHaveLength(1);
  expect(() => f.owner.declare('contract-review-observations-v1')).toThrow();
  expect(existsSync(f.file)).toBe(false);
  expect(readFileSync(daemon.path)).toEqual(daemon.bytes);
});

test('a complete matching Darwin daemon peer can approve a shared format', () => {
  const f = fixture(); peer(f.root, '@goodvibes-jev/daemon');
  expect(() => f.owner.declare('contract-review-observations-v1')).not.toThrow();
  expect(JSON.parse(readFileSync(f.file, 'utf8')).formats).toEqual(['contract-review-observations-v1']);
});
