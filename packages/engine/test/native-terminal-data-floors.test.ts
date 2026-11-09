/** Regression source intentionally UNRUN during the coding-first pass. */
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { admitInstalledClientDataWriter, installedReaderCommand } from '../sdk/src/platform/runtime/installed-client-data-writer.js';
import { assertStagedClientReaderCompatible } from '../sdk/src/platform/runtime/client-reader-update.js';
import { clientReaderAsset, type ClientReaderArtifact, type ClientReaderPackage } from '../sdk/src/platform/runtime/client-reader-artifact.js';
import { createNativeDataWriteOwner, nativeReaderCapabilities, NATIVE_READER_REQUIREMENT_FILE } from '../sdk/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo, rollbackKeptPrevious, sha256 } from '../sdk/src/platform/runtime/self-update.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

function fixture(product = 'goodvibes') {
  const root = makeProjectTempDir('terminal-data-reader'), execPath = join(root, product);
  writeFileSync(execPath, 'Original admitted executable', { mode: 0o755 });
  const owner = admitInstalledClientDataWriter({ moduleUrl: 'file:///$bunfs/root/terminal-entry.js', execPath, compiledVersion: '3.1.2', platform: 'darwin' });
  if (!owner) throw new Error('Fixture did not admit a bundled initial executable');
  return { root, execPath, owner, requirement: join(root, NATIVE_READER_REQUIREMENT_FILE) };
}
function formats(path: string): string[] { return JSON.parse(readFileSync(path, 'utf8')).formats; }
function artifact(packageName: ClientReaderPackage, bytes: Buffer, supported = true): ClientReaderArtifact {
  const target = 'darwin-x64', asset = clientReaderAsset(packageName, target);
  return { schema: 1, packageName, version: '3.1.2', target, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40),
    files: [{ path: asset, sha256: sha256(bytes), mode: 0o755, size: bytes.length }],
    readers: supported ? nativeReaderCapabilities('3.1.2') : { schema: 1, version: '3.1.2', formats: [] } };
}

test.each(['file:///workspace/main.ts', 'file:///workspace/$bunfs-demo/src/main.ts', 'file:///workspace/$bunfs/root/main.ts'])('source module %s does not acquire installation ownership from an executable-looking path', moduleUrl => {
  const f = fixture();
  expect(admitInstalledClientDataWriter({ moduleUrl, execPath: f.execPath, compiledVersion: '3.1.2', platform: 'darwin' })).toBeUndefined();
  expect(existsSync(f.requirement)).toBe(false);
});

test('Linux admission refuses a selected path that is not the OS loaded image', () => {
  if (process.platform !== 'linux') return;
  const f = fixture();
  expect(() => admitInstalledClientDataWriter({ moduleUrl: 'file:///$bunfs/root/main.js', execPath: f.execPath, compiledVersion: '3.1.2', platform: 'linux' })).toThrow('loaded');
});

test('the actual knowledge schema13 write establishes a floor before its first SQLite image', async () => {
  const f = fixture(), path = join(f.root, 'knowledge.sqlite'); let declared = false;
  const store = new KnowledgeStore({ dbPath: path, nativeDataWriter: { declare(format) {
    if (!declared) expect(existsSync(path)).toBe(false);
    f.owner.declare(format); expect(formats(f.requirement)).toContain('knowledge-schema-v13'); declared = true;
  } } });
  try {
    await store.init(); expect(existsSync(path)).toBe(false); expect(existsSync(f.requirement)).toBe(false);
    await store.upsertSource({ connectorId: 'fixture', sourceType: 'document', title: 'Owned document', canonicalUri: 'fixture://source', status: 'indexed' });
    expect(declared).toBe(true);
    const db = new Database(path, { readonly: true }); try { expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 13 }); } finally { db.close(); }
  } finally { await store.close(); }
});

test('a revoked original executable cannot publish the new knowledge format', async () => {
  const f = fixture(), path = join(f.root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: path, nativeDataWriter: f.owner });
  try {
    await store.init(); renameSync(f.execPath, f.execPath + '.retained'); writeFileSync(f.execPath, 'Replacement image', { mode: 0o755 });
    await expect(store.upsertSource({ connectorId: 'fixture', sourceType: 'document', title: 'Held', canonicalUri: 'fixture://held', status: 'indexed' })).rejects.toThrow();
    expect(existsSync(path)).toBe(false); expect(existsSync(f.requirement)).toBe(false);
  } finally { await store.close(); }
});

test('real ConfigManager fresh durable-source issuance declares config-v2 before sidecars', () => {
  const f = fixture(); let declared = false;
  const config = new ConfigManager({ configDir: join(f.root, 'config'), nativeDataWriter: { declare(format) {
    f.owner.declare(format); expect(formats(f.requirement)).toContain('configuration-policy-epochs-v2'); declared = true;
  } } });
  expect(existsSync(f.requirement)).toBe(false);
  config.captureDurableConfigurationIncarnation(); expect(declared).toBe(true);
  expect(JSON.parse(readFileSync(config.getConfigPath() + '.policy-epoch.json', 'utf8')).version).toBe(2);
});

test.each(['@goodvibes-jev/tui', '@goodvibes-jev/agent'] as const)('saved floors reject %s historical rollback without ever executing it', packageName => {
  const product = packageName.endsWith('/tui') ? 'goodvibes' : 'goodvibes-agent', f = fixture(product);
  f.owner.declare('knowledge-schema-v12');
  const previous = Buffer.from('#!/bin/sh\nprintf unexpected > "' + join(f.root, 'was-executed') + '"\n');
  writeFileSync(f.execPath + '.previous', previous, { mode: 0o755 });
  const before = readFileSync(f.execPath);
  expect(() => rollbackKeptPrevious([{ label: 'terminal', path: f.execPath }, { label: 'readers', path: f.execPath + '.readers.json' }], realUpdateFileIo,
    () => assertStagedClientReaderCompatible(f.execPath, f.execPath + '.previous', realUpdateFileIo), { native: true })).toThrow();
  expect(readFileSync(f.execPath)).toEqual(before); expect(readFileSync(f.execPath + '.previous')).toEqual(previous);
  expect(existsSync(join(f.root, 'was-executed'))).toBe(false);
  writeFileSync(f.execPath + '.readers.json.previous', JSON.stringify(artifact(packageName, previous, false)), { mode: 0o644 });
  expect(() => assertStagedClientReaderCompatible(f.execPath, f.execPath + '.previous', realUpdateFileIo)).toThrow();
  writeFileSync(f.execPath + '.readers.json.previous', JSON.stringify(artifact(packageName, previous)), { mode: 0o644 });
  expect(() => assertStagedClientReaderCompatible(f.execPath, f.execPath + '.previous', realUpdateFileIo)).not.toThrow();
  expect(existsSync(join(f.root, 'was-executed'))).toBe(false);
  writeFileSync(f.execPath + '.previous', 'Changed after release metadata'); chmodSync(f.execPath + '.previous', 0o755);
  expect(() => assertStagedClientReaderCompatible(f.execPath, f.execPath + '.previous', realUpdateFileIo)).toThrow('payload');
});

test('reader descriptions use supplied compiled readers without configuration setup', () => {
  const f = fixture();
  const description = installedReaderCommand(['check-install-reader', '--describe'], '3.1.2');
  expect(JSON.parse(description ?? '')).toEqual(nativeReaderCapabilities('3.1.2')); expect(existsSync(f.requirement)).toBe(false);
  createNativeDataWriteOwner({ execPath: f.execPath, version: '3.1.2', assertCurrent() {} }).declare('knowledge-schema-v12');
  expect(() => installedReaderCommand(['check-install-reader', f.execPath], '3.1.1')).toThrow();
});

test('an existing schema11 knowledge image establishes its floor before migration publication', async () => {
  const f = fixture(), path = join(f.root, 'knowledge.sqlite');
  const old = new KnowledgeStore({ dbPath: path });
  await old.upsertSource({ id: 'original-preserved-source', connectorId: 'fixture', sourceType: 'document', title: 'Prior source', canonicalUri: 'fixture://preserved', status: 'indexed' }); await old.close();
  const previous = new Database(path); previous.exec('PRAGMA user_version=11'); previous.close();
  let beforePublication = false;
  const next = new KnowledgeStore({ dbPath: path, nativeDataWriter: { declare(format) {
    if (!beforePublication) {
      const persisted = new Database(path, { readonly: true }); try { expect(persisted.query('PRAGMA user_version').get()).toEqual({ user_version: 11 }); } finally { persisted.close(); }
    }
    f.owner.declare(format); beforePublication = true;
  } } });
  try { await next.init(); expect(beforePublication).toBe(true); expect(next.getSourceByCanonicalUri('fixture://preserved')?.id).toBe('original-preserved-source'); }
  finally { await next.close(); }
});

test('parent retirement never creates a requirement lease in a replacement install directory', () => {
  const root = makeProjectTempDir('reader-retired-parent'), selected = join(root, 'selected'), retained = join(root, 'retained');
  // A selected install directory is independent of the user data roots.
  mkdirSync(selected);
  const execPath = join(selected, 'goodvibes'); writeFileSync(execPath, 'Original executable', { mode: 0o755 });
  const owner = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  renameSync(selected, retained); mkdirSync(selected); writeFileSync(join(selected, 'keep'), 'Foreign retained file');
  expect(() => owner.declare('knowledge-schema-v12')).toThrow();
  expect(readdirSync(selected)).toEqual(['keep']); expect(readFileSync(join(selected, 'keep'), 'utf8')).toBe('Foreign retained file');
});

test('already declared formats remain available to draining accounting without publishing new formats', () => {
  const f = fixture(); let retired = false;
  const owner = createNativeDataWriteOwner({ execPath: f.execPath, version: '3.1.2', assertCurrent() { if (retired) throw new Error('Execution retired'); } });
  owner.declare('knowledge-schema-v12'); const before = readFileSync(f.requirement); retired = true;
  expect(() => owner.declare('knowledge-schema-v12')).not.toThrow(); expect(readFileSync(f.requirement)).toEqual(before);
  expect(() => owner.declare('configuration-policy-epochs-v2')).toThrow(); expect(readFileSync(f.requirement)).toEqual(before);
});

test('retirement during publication closes its lease without touching the replacement directory', () => {
  const root = makeProjectTempDir('reader-parent-during-write'), selected = join(root, 'selected'), retained = join(root, 'retained'); mkdirSync(selected);
  const execPath = join(selected, 'goodvibes'); writeFileSync(execPath, 'Original executable', { mode: 0o755 });
  let changed = false;
  const owner = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {
    if (!changed) { changed = true; renameSync(selected, retained); mkdirSync(selected); writeFileSync(join(selected, 'foreign'), 'Original foreign bytes'); }
  } });
  expect(() => owner.declare('knowledge-schema-v12')).toThrow(); expect(changed).toBe(true);
  expect(readdirSync(selected)).toEqual(['foreign']); expect(readFileSync(join(selected, 'foreign'), 'utf8')).toBe('Original foreign bytes');
});
