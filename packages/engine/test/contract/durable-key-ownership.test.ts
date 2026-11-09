/** Coding-first source regressions. Test execution is deferred. */
import * as crypto from 'node:crypto';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../_helpers/project-temp.js';
import { DurableContractAdmissions, DurableContractAdmissionError, durableKeyHash, durableKeyIdentity, durablePayloadRevision,
  freezeDurableKey, freezeDurableRequest, type DurableContractAdmission, type DurableContractKey } from '../../sdk/src/platform/contract/durable-admission.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const rawKey = (): DurableContractKey => ({ workId: 'work /: % []', criteriaId: 'criteria shared by independent keys', criteriaRevision: 'revision1', attemptId: 'attempt1' });
function fixture() { const root = makeProjectTempDir('gv-durable-key'); roots.push(root); return { root, directory: join(root, '.goodvibes', 'contracts', 'admissions'), store: new DurableContractAdmissions(root) }; }
function admission(root: string, key: DurableContractKey, contractId = 'ctr-1234abcd'): DurableContractAdmission {
  const request = freezeDurableRequest({ key, binding: { sourceId: 'source', inputRevision: 'input', actionId: 'action', actionRevision: 'revision',
    authorityId: 'owner', authorityRevision: 'owner-revision', scopeId: 'scope', scopeRevision: 'scope-revision' },
    input: { ask: 'Preserve every original key reference', sessionId: 'session', origin: 'turn', projectRoot: root, isolation: 'shared' } });
  return { ...request, schemaVersion: 1, contractId, ownerAgentId: 'owner', payloadRevision: durablePayloadRevision(request) };
}

test('one actual immutable key owns one existing filename digest across real missing read, key lock, lease and publication', async () => {
  const f = fixture(), original = admission(f.root, rawKey()), key = original.key;
  const hash = spyOn(crypto, 'createHash');
  let releaseLock: (() => void) | undefined, releaseLease: (() => void) | undefined;
  try {
    const digest = durableKeyHash(key); expect(hash.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(1);
    const capturedAgain = freezeDurableRequest({ key, binding: original.binding, input: { ...original.input } });
    expect(capturedAgain.key).toBe(key); expect(durableKeyHash(capturedAgain.key)).toBe(digest);
    expect(hash.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(1);
    expect(f.store.read(key)).toBeNull(); releaseLock = await f.store.lock(key); releaseLease = await f.store.lease(key);
    expect(existsSync(join(f.directory, `${digest}.json.lock`))).toBe(true); expect(existsSync(join(f.directory, `${digest}.json.execution`))).toBe(true);
    f.store.write(original, 'first checkpoint');
    expect(hash.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(1);
    expect(f.store.read(key)).toEqual(original);
    // The actual independently read saved payload still verifies its separate
    // complete-request commitment. There is no second filename hash here.
    expect(hash.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(2);
    expect(readdirSync(f.directory).filter(name => name.endsWith('.json'))).toEqual([digest + '.json']);
  } finally { releaseLease?.(); releaseLock?.(); hash.mockRestore(); }
});

test('all four generic references remain separate identities even when an opaque-looking criteria ID is reused', async () => {
  const f = fixture(); const base = { workId: 'w'.repeat(256), criteriaId: 'criteria-v2:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', criteriaRevision: 'r'.repeat(256), attemptId: 'a'.repeat(256) };
  const keys = [base, ...(['workId', 'criteriaId', 'criteriaRevision', 'attemptId'] as const).map(field => ({ ...base, [field]: 'Z' + base[field].slice(1) }))];
  const rows: DurableContractAdmission[] = [];
  for (const [index, key] of keys.entries()) {
    const row = admission(f.root, key, `ctr-${index.toString(16).padStart(8, '0')}`), release = await f.store.lock(row.key);
    try { f.store.write(row, `checkpoint-${index}`); rows.push(row); } finally { release(); }
  }
  expect(new Set(rows.map(row => durableKeyHash(row.key))).size).toBe(keys.length);
  expect(new Set(rows.map(row => durableKeyIdentity(row.key))).size).toBe(keys.length);
  for (const [index, row] of rows.entries()) { expect(new DurableContractAdmissions(f.root).read(row.key)).toEqual(row); expect(f.store.checkpoint(row.key)).toBe(`checkpoint-${index}`); }
  const first = await f.store.lease(rows[0]!.key), other = await f.store.lease(rows[1]!.key);
  try { expect(readFileSync(join(f.directory, durableKeyHash(rows[0]!.key) + '.json'), 'utf8')).toContain('checkpoint-0'); }
  finally { other(); first(); }
});

test('a detached original key remains fixed while mutable and foreign frozen copies independently validate and hash', () => {
  const source = rawKey(), native = freezeDurableKey(source), original = durableKeyHash(native);
  (source as { workId: string }).workId = 'new work';
  expect(durableKeyHash(native)).toBe(original); expect(durableKeyHash(source)).not.toBe(original);
  const foreign = Object.freeze({ ...native }); expect(freezeDurableKey(foreign)).not.toBe(foreign);
  const hash = spyOn(crypto, 'createHash');
  try { expect(durableKeyHash(foreign)).toBe(original); expect(durableKeyHash(foreign)).toBe(original); expect(hash.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(2); }
  finally { hash.mockRestore(); }
});

test('original protocol bytes are unchanged for the maximum portable four-reference namespace', () => {
  const key = freezeDurableKey({ workId: '!'.repeat(256), criteriaId: '/'.repeat(256), criteriaRevision: '\\'.repeat(256), attemptId: '~'.repeat(256) });
  const legacy = JSON.stringify({ attemptId: key.attemptId, criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, workId: key.workId });
  expect(durableKeyHash(key)).toBe(crypto.createHash('sha256').update(legacy).digest('hex'));
  expect(durableKeyHash(key)).toMatch(/^[a-f0-9]{64}$/);
});

test('hostile key getters, proxies and late WeakMap overrides cannot manufacture a cached native key', () => {
  let getters = 0; const value = Object.create(null, { workId: { enumerable: true, get() { getters++; return 'work'; } },
    criteriaId: { enumerable: true, value: 'criteria' }, criteriaRevision: { enumerable: true, value: 'revision' }, attemptId: { enumerable: true, value: 'attempt' } });
  expect(() => freezeDurableKey(value)).toThrow(DurableContractAdmissionError); expect(getters).toBe(0);
  const proxy = new Proxy(rawKey(), { get() { getters++; return 'forged'; } });
  expect(() => freezeDurableKey(proxy)).toThrow(DurableContractAdmissionError); expect(getters).toBe(0);
  const prior = WeakMap.prototype.get;
  try { WeakMap.prototype.get = () => ({ identity: 'forged', filename: '0'.repeat(64) });
    expect(() => durableKeyHash({ ...rawKey(), attemptId: '' })).toThrow(DurableContractAdmissionError);
    expect(durableKeyHash(rawKey())).not.toBe('0'.repeat(64));
  } finally { WeakMap.prototype.get = prior; }
});

test('request admission rejects key accessors without evaluation and refuses a key changed by another borrowed getter', () => {
  const f = fixture(), source = admission(f.root, rawKey()); let getter = 0;
  const hostile = { binding: source.binding, input: source.input, get key() { getter++; return rawKey(); } };
  expect(() => freezeDurableRequest(hostile)).toThrow(DurableContractAdmissionError); expect(getter).toBe(0);
  const key = rawKey();
  const changed = { key, binding: source.binding, get input() { (key as { workId: string }).workId = 'changed by input getter'; return source.input; } };
  expect(() => freezeDurableRequest(changed)).toThrow(DurableContractAdmissionError);
});

test('lock acquisition captures the caller key before its first await', async () => {
  const f = fixture(), input = rawKey(), original = freezeDurableKey(input), expected = durableKeyHash(original);
  const pending = f.store.lock(input); (input as { workId: string }).workId = 'changed after dispatch';
  const release = await pending;
  try { expect(existsSync(join(f.directory, expected + '.json.lock'))).toBe(true); expect(existsSync(join(f.directory, durableKeyHash(input) + '.json.lock'))).toBe(false); }
  finally { release(); }
});
