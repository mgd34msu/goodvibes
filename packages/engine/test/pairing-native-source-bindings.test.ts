import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingTokenManager, type NativeContinuationAuthority } from '../platform/src/platform/pairing/pairing-token-store.js';
import { nativeCiHistoricalSourceBinding, nativeCiSourceBinding } from '../platform/src/platform/workflow/work-ledger/native-ci-continuation-types.js';
import { bindNativeExecutionRequest } from '../platform/src/platform/workflow/work-ledger/native-execution-types.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, type NativeDataWriteOwner } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import * as atomic from '../platform/src/platform/utils/atomic-json-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pin = (value: number) => value.toString(16).padStart(64, '0');
const current = () => {};
function fixture(options: ConstructorParameters<typeof PairingTokenManager>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pairing-source-version-')); roots.push(root);
  const file = join(root, 'pairing.json'), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const manager = new PairingTokenManager(file, options), token = manager.mint({ name: 'Synthetic source-binding fixture' });
  const authority: NativeContinuationAuthority = { ...manager.authenticateNative(token.token)!, scopes: ['read:work-ledger', 'write:fleet', 'write:work-ledger'] };
  return { root, file, workspace, manager, token, authority };
}
function request(f: ReturnType<typeof fixture>, workId = 'work-owned-source') {
  const key = { workId, criteriaId: 'criteria-v2:' + workId, criteriaRevision: '1', attemptId: 'attempt-original' };
  return bindNativeExecutionRequest({ key,
    binding: { sourceId: 'original-source', inputRevision: 'original-input', actionId: pin(1), actionRevision: 'original-action',
      authorityId: 'original-authority', authorityRevision: 'pending-owner', scopeId: 'original-scope', scopeRevision: 'original-scope-revision' },
    input: { ask: 'Keep original work.', projectRoot: f.workspace, sessionId: 'original-session', origin: 'external',
      nativeSource: { sourceId: 'original-source', sourceRevision: 'original-source-version', inputRevision: 'original-input',
        criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: 'Keep original work.', criteria: ['Keep every original obligation.'] } },
  }, 'project', { principalId: f.authority.principalId, authorityRevision: f.authority.authorityRevision,
    scopeId: 'registered-workspace', scopeRevision: 'registered-workspace-epoch' }, f.authority.scopes);
}

test('actual work-prefixed native source uses its action token, and marked consumed-successor cancellation needs no historical computation', () => {
  const f = fixture(), source = request(f);
  expect(nativeCiSourceBinding('project', source)).toBe(source.binding.actionId);
  const parent = f.manager.issueNativeContinuation(f.token.token, f.authority, pin(2), current, source.binding.actionId);
  f.manager.consumeNativeContinuation(parent, pin(3), current, pin(4));
  const unrelated = f.manager.issueNativeContinuation(f.token.token, f.authority, pin(5), current, pin(6));
  let historical = 0;
  f.manager.revokeNativeContinuationsForSource(pin(4), current, { authority: f.authority,
    legacyBinding() { historical++; throw new Error('A marked source must not enter the old recipe'); } });
  expect(historical).toBe(0);
  const reopened = new PairingTokenManager(f.file);
  expect(reopened.readNativeContinuation(parent)).toBeNull();
  expect(reopened.readNativeContinuation(unrelated)).toEqual(f.authority);
});

test('real pre-marker recipe grants and canonical grants retire together after restart while unrelated grants survive', () => {
  const f = fixture(), source = request(f), legacy = nativeCiHistoricalSourceBinding('project', source);
  // Issue through the genuine private owner using the exact earlier producer
  // recipe. Only the optional new marker is removed to reproduce old bytes;
  // custody, scopes, parent lineage and independent grant bindings stay real.
  const old = f.manager.issueNativeContinuation(f.token.token, f.authority, pin(10), current, legacy);
  const oldOther = f.manager.issueNativeContinuation(f.token.token, f.authority, pin(11), current, pin(12));
  const bytes = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const grant of bytes.continuations) delete grant.sourceBindingVersion;
  writeFileSync(f.file, JSON.stringify(bytes));
  const reopened = new PairingTokenManager(f.file);
  expect(reopened.readNativeContinuation(old)).toEqual(f.authority);
  reopened.consumeNativeContinuation(old, pin(13), current, pin(14));
  const descendant = reopened.issueNativeContinuationFromGrant(old, pin(13), f.authority, pin(15), current, pin(14));
  const canonical = reopened.issueNativeContinuation(f.token.token, f.authority, pin(16), current, source.binding.actionId);
  const currentOther = reopened.issueNativeContinuation(f.token.token, f.authority, pin(17), current, pin(18));
  let historical = 0;
  reopened.revokeNativeContinuationsForSource(source.binding.actionId, current, { authority: f.authority,
    legacyBinding() { historical++; return nativeCiHistoricalSourceBinding('project', source); } });
  expect(historical).toBe(1);
  const final = new PairingTokenManager(f.file);
  for (const grant of [old, descendant, canonical]) expect(final.readNativeContinuation(grant)).toBeNull();
  for (const grant of [oldOther, currentOther]) expect(final.readNativeContinuation(grant)).toEqual(f.authority);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  expect(saved.revokedNativeSources.sort()).toEqual([legacy, source.binding.actionId].sort());
});

test('an actual unmarked canonical grant is resolved directly without a historical alias calculation', () => {
  const f = fixture(), source = request(f);
  const grant = f.manager.issueNativeContinuation(f.token.token, f.authority, pin(19), current, source.binding.actionId);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  delete saved.continuations[0].sourceBindingVersion;
  writeFileSync(f.file, JSON.stringify(saved));
  const reopened = new PairingTokenManager(f.file);
  expect(reopened.readNativeContinuation(grant)).toEqual(f.authority);
  let historical = 0;
  reopened.revokeNativeContinuationsForSource(source.binding.actionId, current, { authority: f.authority,
    legacyBinding() { historical++; throw new Error('An exact saved source match needs no old recipe'); } });
  expect(historical).toBe(0);
  expect(new PairingTokenManager(f.file).readNativeContinuation(grant)).toBeNull();
});

test('marked grant publication declares its genuine native reader floor before the file effect and refusal retains the old token image', () => {
  let deny = true, owner: ReturnType<typeof createNativeDataWriteOwner> | undefined;
  const writer: NativeDataWriteOwner = { declare(format) {
    if (format !== 'pairing-native-source-bindings-v2') throw new Error('Unexpected native format');
    if (deny) throw new Error('Synthetic older source-binding reader');
    owner!.declare(format);
  } };
  const f = fixture({ nativeDataWriter: writer });
  const executable = join(f.root, 'goodvibes'); writeFileSync(executable, 'Synthetic admitted application');
  owner = createNativeDataWriteOwner({ execPath: executable, version: '3.1.2', assertCurrent: current });
  const before = readFileSync(f.file);
  expect(() => f.manager.issueNativeContinuation(f.token.token, f.authority, pin(20), current, pin(21))).toThrow('older source-binding reader');
  expect(readFileSync(f.file)).toEqual(before);
  deny = false;
  // A failed native write fences that instance. Restart from the unchanged
  // genuine image instead of weakening its original persistence-failure latch.
  const admitted = new PairingTokenManager(f.file, { nativeDataWriter: writer });
  const capabilities = nativeReaderCapabilities('3.1.2'), old = { ...capabilities,
    formats: capabilities.formats.filter(format => format !== 'pairing-native-source-bindings-v2') };
  const actualWrite = atomic.writeJsonFileAtomic;
  let effects = 0;
  const writing = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((path, value, options) => {
    if (path === f.file) {
      expect(() => assertNativeReaderCompatible(executable, '3.1.2', realUpdateFileIo, old)).toThrow();
      effects++;
    }
    actualWrite(path, value, options);
  });
  try { admitted.issueNativeContinuation(f.token.token, f.authority, pin(20), current, pin(21)); }
  finally { writing.mockRestore(); }
  expect(effects).toBe(1);
  expect(() => assertNativeReaderCompatible(executable, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
  expect(JSON.parse(readFileSync(f.file, 'utf8')).continuations[0].sourceBindingVersion).toBe(2);
});

test('future source-binding markers refuse authentication and writes without quarantining original data', () => {
  const f = fixture();
  f.manager.issueNativeContinuation(f.token.token, f.authority, pin(30), current, pin(31));
  const saved = JSON.parse(readFileSync(f.file, 'utf8')); saved.continuations[0].sourceBindingVersion = 3;
  writeFileSync(f.file, JSON.stringify(saved));
  const before = readFileSync(f.file), names = readdirSync(f.root).sort();
  const future = new PairingTokenManager(f.file);
  expect(future.authenticateNative(f.token.token)).toBeNull();
  expect(() => future.mint({ name: 'Cannot overwrite future grants' })).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
  expect(readdirSync(f.root).sort()).toEqual(names);
});

test.each(['returned', 'thrown'] as const)('a %s failed asynchronous marker declaration is drained and never publishes a grant', mode => {
  const f = fixture({ nativeDataWriter: { declare() {
    const failed = Promise.reject(new Error('Synthetic asynchronous declaration failure'));
    if (mode === 'thrown') throw failed;
    return failed;
  } } });
  const before = readFileSync(f.file);
  expect(() => f.manager.issueNativeContinuation(f.token.token, f.authority, pin(40), current, pin(41))).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
