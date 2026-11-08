import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PairingTokenManager, type NativeContinuationAuthority, type NativeContinuationGrant } from '../sdk/src/platform/pairing/pairing-token-store.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const binding = '11'.repeat(32), successor = '22'.repeat(32), childBinding = '33'.repeat(32), noop = () => {};
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
interface Snapshot {
  tokens: { id: string; tokenHash: string; createdAt: number; name: string; nativeContinuationRevision?: { id: string; createdAt: number; tokenHash: string } }[];
  continuations?: { id: string; binding: string; tokenRevision: string; ownerRoot: string }[];
}
function persisted(file: string): Snapshot { return JSON.parse(readFileSync(file, 'utf8')) as Snapshot; }
function fixture() {
  const root = makeProjectTempDir('pairing-continuation-identity'), file = join(root, 'pairing.json');
  const manager = new PairingTokenManager(file), paired = manager.mint({ name: 'Synthetic identity fixture' });
  const native = manager.authenticateNative(paired.token); if (!native) throw new Error('Missing native pairing');
  const authority: NativeContinuationAuthority = { ...native, scopes: ['write:synthetic'] };
  return { root, file, manager, paired, authority, issue: (value = binding) => manager.issueNativeContinuation(paired.token, authority, value, noop) };
}

test('fresh native custody uses issued identities; repeated grant checks do no SHA work', () => {
  const item = fixture(), hash = spyOn(crypto, 'createHash');
  let grant: NativeContinuationGrant;
  try {
    grant = item.issue();
    // The one retained SHA authenticates the actually presented bearer.
    expect(hash).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) expect(item.manager.readNativeContinuation(grant)).toEqual(item.authority);
    const restarted = new PairingTokenManager(item.file);
    for (let i = 0; i < 10; i++) expect(restarted.readNativeContinuation(grant)).toEqual(item.authority);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(item.issue()).toEqual(grant); expect(hash).toHaveBeenCalledTimes(2);
  } finally { hash.mockRestore(); }
  const snapshot = persisted(item.file), token = snapshot.tokens[0], issued = snapshot.continuations?.[0];
  if (!token || !issued || !token.nativeContinuationRevision) throw new Error('Missing native custody records');
  expect(issued.tokenRevision).toBe(token.nativeContinuationRevision.id);
  expect(issued.tokenRevision).not.toBe(digest(JSON.stringify([token.createdAt, token.tokenHash])));
  const owner = JSON.parse(readFileSync(`${item.file}.native-owner`, 'utf8')) as { id: string; parents: string[][] };
  expect(issued.ownerRoot).toBe(owner.id); expect(issued.ownerRoot).not.toBe(digest(JSON.stringify(owner.parents)));
  expect(readFileSync(item.file, 'utf8')).not.toContain(item.paired.token);
  expect(readFileSync(`${item.file}.native-owner`, 'utf8')).not.toContain(item.paired.token);
  expect(JSON.stringify(item.manager.list())).not.toContain('nativeContinuationRevision');
});

test('one original incarnation is retained across grant/watch/consumption/child publication and restart', () => {
  const item = fixture(), parent = item.issue();
  item.manager.bindNativeContinuationWatch(parent, '44'.repeat(32), noop);
  item.manager.consumeNativeContinuation(parent, successor, noop);
  const hash = spyOn(crypto, 'createHash');
  try {
    const child = item.manager.issueNativeContinuationFromGrant(parent, successor, item.authority, childBinding, noop);
    const restarted = new PairingTokenManager(item.file);
    expect(restarted.readNativeContinuation(child)).toEqual(item.authority);
    expect(hash).not.toHaveBeenCalled();
    const grants = persisted(item.file).continuations;
    expect(grants?.[1]?.tokenRevision).toBe(grants?.[0]?.tokenRevision);
    expect(grants?.[1]?.ownerRoot).toBe(grants?.[0]?.ownerRoot);
    restarted.revokeNativeContinuation(parent);
    expect(item.manager.readNativeContinuation(child)).toBeNull();
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test.each(['createdAt', 'tokenHash'] as const)('changing %s under the same public token ID retires the native grant', field => {
  const item = fixture(), grant = item.issue(), snapshot = persisted(item.file), token = snapshot.tokens[0];
  if (!token) throw new Error('Missing pairing');
  if (field === 'createdAt') token.createdAt++;
  else token.tokenHash = digest('synthetic changed verifier');
  writeFileSync(item.file, JSON.stringify(snapshot));
  expect(item.manager.readNativeContinuation(grant)).toBeNull();
  expect(new PairingTokenManager(item.file).readNativeContinuation(grant)).toBeNull();
});

test('copying the complete private directory cannot transplant issued owner identity', () => {
  const item = fixture(), grant = item.issue(), retained = join(makeProjectTempDir('pairing-displaced-root'), 'original');
  renameSync(item.root, retained); mkdirSync(item.root, { mode: 0o700 });
  for (const name of readdirSync(retained)) if (lstatSync(join(retained, name)).isFile()) {
    writeFileSync(join(item.root, name), readFileSync(join(retained, name)), { mode: 0o600 });
  }
  const restarted = new PairingTokenManager(item.file);
  expect(restarted.readNativeContinuation(grant)).toBeNull();
  const replacement = restarted.issueNativeContinuation(item.paired.token, item.authority, childBinding, noop);
  expect(restarted.readNativeContinuation(replacement)).toEqual(item.authority);
  expect(restarted.readNativeContinuation(grant)).toBeNull();
});

test.each(['missing', 'corrupt', 'unsupported'] as const)('%s owner evidence refuses lookup without repair or loss of ordinary authentication', kind => {
  const item = fixture(), grant = item.issue(), path = `${item.file}.native-owner`, original = readFileSync(item.file, 'utf8');
  if (kind === 'missing') unlinkSync(path);
  else writeFileSync(path, kind === 'corrupt' ? '{broken' : JSON.stringify({ version: 999, id: '11'.repeat(32), parents: [] }));
  const before = kind === 'missing' ? null : readFileSync(path, 'utf8');
  expect(item.manager.readNativeContinuation(grant)).toBeNull();
  const restarted = new PairingTokenManager(item.file);
  expect(restarted.readNativeContinuation(grant)).toBeNull();
  expect(restarted.authenticate(item.paired.token)?.id).toBe(item.paired.id);
  // Ordinary authentication may stamp last-seen; it must retain every grant
  // and the additive incarnation field, never rebuild an empty pairing store.
  expect(persisted(item.file).continuations).toEqual((JSON.parse(original) as Snapshot).continuations);
  expect(kind === 'missing' ? null : readFileSync(path, 'utf8')).toBe(before);
});

test('failed owner publication never exposes a continuation grant or a successful native issuer', () => {
  const item = fixture(), before = readFileSync(item.file, 'utf8');
  const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('Synthetic owner publication failure'); });
  try { expect(() => item.issue()).toThrow('Synthetic owner publication failure'); }
  finally { write.mockRestore(); }
  expect(readFileSync(item.file, 'utf8')).toBe(before);
  expect(item.manager.authenticateNative(item.paired.token)).toBeNull();
});

/** Published v3.1.1 grant representation, independently assembled with that
 * release's exact directory/token digest inputs. This is old stored evidence,
 * not a fresh production digest writer or an execution authority constructor. */
function publishedFixture() {
  const item = fixture(), snapshot = persisted(item.file), token = snapshot.tokens[0];
  if (!token) throw new Error('Missing published token fixture');
  const parents: string[][] = [];
  for (let path = dirname(item.file);;) {
    const stat = lstatSync(path, { bigint: true });
    parents.push([path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  const grant = { id: `continuation-${crypto.randomUUID()}`, binding };
  const stored = { ...grant, sourceBinding: binding, successorSourceBinding: null, parent: null, tokenId: token.id,
    tokenRevision: digest(JSON.stringify([token.createdAt, token.tokenHash])), ownerRoot: digest(JSON.stringify(parents)),
    watchBinding: null, scopes: item.authority.scopes, createdAt: Date.now(), consumption: null, revoked: false };
  writeFileSync(item.file, JSON.stringify({ ...snapshot, continuations: [stored] }));
  return { ...item, grant, stored, manager: new PairingTokenManager(item.file) };
}

test('published v1 grants verify once per exact incarnation without rewriting or creating an owner identity', () => {
  const item = publishedFixture(), before = readFileSync(item.file, 'utf8'), hash = spyOn(crypto, 'createHash');
  try {
    expect(item.manager.readNativeContinuation(item.grant)).toEqual(item.authority);
    expect(hash).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i++) expect(item.manager.readNativeContinuation(item.grant)).toEqual(item.authority);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(readFileSync(item.file, 'utf8')).toBe(before);
    expect(readdirSync(item.root)).not.toContain('pairing.json.native-owner');
    item.manager.consumeNativeContinuation(item.grant, successor, noop);
    const child = item.manager.issueNativeContinuationFromGrant(item.grant, successor, item.authority, childBinding, noop);
    expect(item.manager.readNativeContinuation(child)).toEqual(item.authority);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(persisted(item.file).continuations?.[1]?.tokenRevision).toBe(item.stored.tokenRevision);
    expect(persisted(item.file).tokens[0]?.nativeContinuationRevision).toBeUndefined();
    const restarted = new PairingTokenManager(item.file);
    expect(restarted.readNativeContinuation(child)).toEqual(item.authority);
  } finally { hash.mockRestore(); }
});

test.each(['token', 'owner-root'] as const)('a changed published %s invalidates the compatibility cache and the original grant', change => {
  const item = publishedFixture();
  expect(item.manager.readNativeContinuation(item.grant)).toEqual(item.authority);
  if (change === 'token') {
    const snapshot = persisted(item.file), token = snapshot.tokens[0]; if (!token) throw new Error('Missing token');
    token.createdAt++; writeFileSync(item.file, JSON.stringify(snapshot));
  } else {
    const retained = join(makeProjectTempDir('published-pairing-displaced'), 'original');
    renameSync(item.root, retained); mkdirSync(item.root, { mode: 0o700 });
    for (const name of readdirSync(retained)) if (lstatSync(join(retained, name)).isFile()) {
      writeFileSync(join(item.root, name), readFileSync(join(retained, name)), { mode: 0o600 });
    }
  }
  expect(item.manager.readNativeContinuation(item.grant)).toBeNull();
  expect(new PairingTokenManager(item.file).readNativeContinuation(item.grant)).toBeNull();
});
