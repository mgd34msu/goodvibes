/** Released v3.1.1 bindings remain readable while unchanged guards stop
 * re-reading/fsyncing policy files and recomputing their v1 commitments. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DurablePolicyEpochOwner } from '../sdk/src/platform/config/durable-policy-epoch.ts';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-policy-observation-')); roots.push(root);
  const file = join(root, 'settings.json'); writeFileSync(file, '{"behavior":{"autoApprove":false}}');
  return { root, file, epoch: `${file}.policy-epoch.json` };
}

// The published v3.1.1 fileIdentity/current wire algorithms, independently
// reproduced from that release. Neither helper calls the new owner/cache.
function releasedDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function releasedFileIdentity(path: string): string {
  const ancestors: unknown[] = [];
  for (let parent = dirname(resolve(path));;) {
    const entry = lstatSync(parent, { bigint: true });
    ancestors.push([parent, String(entry.dev), String(entry.ino), String(entry.birthtimeNs)]);
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  try {
    const entry = lstatSync(path, { bigint: true });
    const facts = [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].map(String);
    return releasedDigest([ancestors, facts, createHash('sha256').update(readFileSync(path)).digest('hex')]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return releasedDigest([ancestors, 'absent']);
    throw error;
  }
}
function releasedBinding(file: string, epoch: { readonly incarnation: string; readonly fileIdentity: string }, effective: unknown): string {
  return releasedDigest([[[file, epoch.incarnation, epoch.fileIdentity]], effective]);
}

for (const present of [true, false]) test(`a published-v1 policy record opens unchanged after restart (present=${present})`, () => {
  const f = fixture(); if (!present) rmSync(f.file);
  const epoch = { version: 1, incarnation: randomUUID(), fileIdentity: releasedFileIdentity(f.file) };
  atomic.writeJsonFileAtomic(f.epoch, epoch, { durable: true, mode: 0o600 });
  const original = readFileSync(f.epoch), effective = { behavior: { autoApprove: false }, label: 'actual-v1-fixture' };
  const expected = releasedBinding(f.file, epoch, effective);
  for (let restart = 0; restart < 2; restart++) {
    const owner = new DurablePolicyEpochOwner([f.file], true);
    for (let repeat = 0; repeat < 5; repeat++) expect(owner.current(effective)).toBe(expected);
    expect(readFileSync(f.epoch)).toEqual(original);
  }
});

test('newly issued policy history uses private physical facts without an extra source-content commitment', () => {
  const f = fixture(), effective = { behavior: { autoApprove: false } };
  const owner = new DurablePolicyEpochOwner([f.file], true), binding = owner.capture(effective);
  const epoch = JSON.parse(readFileSync(f.epoch, 'utf8'));
  expect(Object.keys(epoch).sort()).toEqual(['fileIdentity', 'incarnation', 'version']);
  expect(epoch.version).toBe(2); expect(epoch.fileIdentity).toStartWith('policy-file-v2:[');
  expect(binding).toBe(releasedBinding(f.file, epoch, effective));
});

test('fresh capture, repeated currentness and a source mutation hash only the final private configuration frame', () => {
  const f = fixture(), effective = { policy: 'same', credential: 'synthetic-private-config-value' };
  const owner = new DurablePolicyEpochOwner([f.file], true);
  const hash = spyOn(crypto, 'createHash');
  try {
    const original = owner.capture(effective);
    expect(hash).toHaveBeenCalledTimes(1);
    for (let repeat = 0; repeat < 10; repeat++) expect(owner.current(effective)).toBe(original);
    expect(hash).toHaveBeenCalledTimes(1);
    owner.advance();
    writeFileSync(f.file, '{"behavior":{"autoApprove":true}}');
    owner.reconcile();
    expect(owner.current({ ...effective, policy: 'changed' })).not.toBe(original);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(readFileSync(f.epoch, 'utf8')).not.toContain(effective.credential);
  } finally { hash.mockRestore(); }
});

test('an actual v1 owner advances to physical facts only at mutation intent and never revives its old binding', () => {
  const f = fixture(), effective = { policy: 'existing' };
  const epoch = { version: 1, incarnation: randomUUID(), fileIdentity: releasedFileIdentity(f.file) };
  atomic.writeJsonFileAtomic(f.epoch, epoch, { durable: true, mode: 0o600 });
  const original = releasedBinding(f.file, epoch, effective);
  const owner = new DurablePolicyEpochOwner([f.file], true);
  expect(owner.current(effective)).toBe(original);
  expect(JSON.parse(readFileSync(f.epoch, 'utf8')).version).toBe(1);
  const hash = spyOn(crypto, 'createHash');
  try {
    owner.advance(); owner.reconcile();
    const advanced = JSON.parse(readFileSync(f.epoch, 'utf8'));
    expect(advanced.version).toBe(2);
    expect(advanced.incarnation).not.toBe(epoch.incarnation);
    expect(advanced.fileIdentity).toStartWith('policy-file-v2:[');
    expect(hash).not.toHaveBeenCalled();
    expect(owner.current(effective)).not.toBe(original);
    expect(hash).toHaveBeenCalledTimes(1);
    const restarted = new DurablePolicyEpochOwner([f.file], true);
    expect(restarted.current(effective)).toBe(owner.current(effective));
  } finally { hash.mockRestore(); }
});

test('malformed physical facts stay unavailable and are never repaired by mutation intent', () => {
  for (const fileIdentity of ['policy-file-v2:[broken', 'policy-file-v2:[]', 'policy-file-v2:[[],"absent"]',
    'policy-file-v2:[[["relative","1","2","3"]],"absent"]']) {
    const f = fixture();
    const value = { version: 2, incarnation: randomUUID(), fileIdentity };
    atomic.writeJsonFileAtomic(f.epoch, value, { durable: true, mode: 0o600 });
    const before = readFileSync(f.epoch);
    const owner = new DurablePolicyEpochOwner([f.file], true);
    expect(() => owner.current({})).toThrow();
    expect(() => owner.advance()).toThrow('mutation intent');
    expect(readFileSync(f.epoch)).toEqual(before);
  }
});

test('unchanged live guards reuse the confirmed durable record, while a restart confirms its own record', () => {
  const f = fixture(), effective = { policy: 'same' };
  const owner = new DurablePolicyEpochOwner([f.file], true), original = owner.capture(effective);
  const confirm = atomic.confirmFileDurable; const confirmed: string[] = [];
  const observation = spyOn(atomic, 'confirmFileDurable').mockImplementation(path => { confirmed.push(path); return confirm(path); });
  try {
    for (let repeat = 0; repeat < 10; repeat++) expect(owner.current(effective)).toBe(original);
    expect(confirmed).toEqual([]);
    const restarted = new DurablePolicyEpochOwner([f.file], true);
    expect(confirmed).toContain(f.epoch);
    const afterRestart = confirmed.length;
    expect(restarted.current(effective)).toBe(original);
    expect(confirmed).toHaveLength(afterRestart);
  } finally { observation.mockRestore(); }
});

test('mutated effective values cannot reuse the previous binding for the same physical files', () => {
  const f = fixture(), effective = { permissions: { allow: false }, extensions: ['first'] };
  const owner = new DurablePolicyEpochOwner([f.file], true), original = owner.capture(effective);
  const epoch = JSON.parse(readFileSync(f.epoch, 'utf8'));
  effective.permissions.allow = true; effective.extensions.push('second');
  const changed = owner.current(effective);
  expect(changed).not.toBe(original); expect(changed).toBe(releasedBinding(f.file, epoch, effective));
});

test('private effective configuration frames never become enumerable owner metadata', () => {
  const f = fixture(), effective = { credential: 'synthetic-private-policy-frame' };
  const owner = new DurablePolicyEpochOwner([f.file], true); owner.capture(effective);
  expect(JSON.stringify(owner)).not.toContain(effective.credential);
  for (const value of Object.values(owner)) expect(typeof value === 'string' && value.includes(effective.credential)).toBe(false);
  expect(readFileSync(f.epoch, 'utf8')).not.toContain(effective.credential);
});

test('a same-size external source edit with restored mtime retires the original policy permanently', () => {
  const f = fixture(), effective = { policy: 'original' };
  const owner = new DurablePolicyEpochOwner([f.file], true); owner.capture(effective);
  const bytes = readFileSync(f.file), original = lstatSync(f.file);
  const edited = Buffer.from(bytes); edited[0] = 91; writeFileSync(f.file, edited); utimesSync(f.file, original.atime, original.mtime);
  expect(() => owner.current(effective)).toThrow('ownership is unavailable');
  writeFileSync(f.file, bytes); utimesSync(f.file, original.atime, original.mtime);
  expect(() => owner.current(effective)).toThrow('ownership is unavailable');
});

for (const change of ['source', 'record', 'directory'] as const) test(`an external ${change} replacement cannot borrow cached policy ownership`, () => {
  const f = fixture(), effective = { policy: 'original' };
  const owner = new DurablePolicyEpochOwner([f.file], true); owner.capture(effective);
  if (change === 'directory') {
    const retained = f.root + '.retained'; roots.push(retained);
    renameSync(f.root, retained); mkdirSync(f.root);
    writeFileSync(f.file, readFileSync(join(retained, 'settings.json')));
    writeFileSync(f.epoch, readFileSync(join(retained, 'settings.json.policy-epoch.json')));
  } else {
    const path = change === 'source' ? f.file : f.epoch, bytes = readFileSync(path);
    const replacement = path + '.replacement';
    writeFileSync(replacement, change === 'source' ? bytes : '{"version":99}'); renameSync(replacement, path);
  }
  expect(() => owner.current(effective)).toThrow('ownership is unavailable');
});

test('a cached sidecar never hides another actual owner advancing the durable nonce', () => {
  const f = fixture(), effective = { policy: 'original' };
  const owner = new DurablePolicyEpochOwner([f.file], true), original = owner.capture(effective);
  const other = new DurablePolicyEpochOwner([f.file], true); other.advance(); other.reconcile();
  expect(other.current(effective)).not.toBe(original);
  expect(() => owner.current(effective)).toThrow('ownership is unavailable');
});

test('outstanding mutation ownership is checked even when every policy image is cached', () => {
  const f = fixture(), effective = { policy: 'original' };
  const owner = new DurablePolicyEpochOwner([f.file], true); owner.capture(effective);
  mkdirSync(`${f.epoch}.owner-lock`);
  expect(() => owner.current(effective)).toThrow('ownership is unavailable');
});
