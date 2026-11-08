/** Real retained-hold files and canonical native publication, not version labels alone. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, parseNativeReaderCapabilities, NativeDataCompatibilityError,
  NATIVE_READER_REQUIREMENT_FILE, type AdmittedNativeDataPublisher } from '../sdk/src/platform/runtime/native-reader-compatibility.js';
import { applyVerifiedUpdate, realUpdateFileIo, resolveDaemonNativeTargets, sha256, UpdateTransactionError, type UpdateFetchLike } from '../sdk/src/platform/runtime/self-update.js';
import { DurableBudgetLedger, PaymentBudgetUnavailableError } from '../sdk/src/platform/payments/host/budget-store.js';
import { BudgetLedger, type BudgetLimits } from '../sdk/src/platform/payments/budget.js';
import { tryAcquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { nativeCohortFixture, nativeMemoryIo } from './_helpers/daemon-native-cohort.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const clock = Date.parse('2026-11-08T12:00:00Z');
const limits: BudgetLimits = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 0,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
function fixture(guard: () => void = () => {}) {
  const prefix = mkdtempSync(join(tmpdir(), 'native-data-reader-')); roots.push(prefix);
  const execPath = join(prefix, 'goodvibes-daemon');
  const publisher: AdmittedNativeDataPublisher = { execPath, version: '3.1.2', assertCurrent: guard };
  const owner = createNativeDataWriteOwner(publisher);
  return { prefix, execPath, publisher, owner, file: join(prefix, NATIVE_READER_REQUIREMENT_FILE), budget: join(prefix, 'budget.json') };
}
function reserve(ledger: BudgetLedger, id: string, retained = true) {
  return ledger.reserve({ id, itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits, nowMs: clock, timezone: 'UTC', ...(retained ? { retainUntilSettled: true as const } : {}) });
}
const requirement = () => JSON.stringify({ schema: 1, minimumReader: '3.1.2', formats: ['payment-retained-holds-v2'] });

test('starting a new owner and ordinary accounting preserve compatible early rollback', () => {
  let calls = 0; const f = fixture(() => { calls++; });
  const ledger = new DurableBudgetLedger(f.budget, () => clock, () => f.owner.declare('payment-retained-holds-v2'));
  expect(reserve(ledger, 'ordinary', false)).not.toBeNull();
  expect(ledger.commit('ordinary', clock)?.itemMinorUnits).toBe(1_000);
  expect(calls).toBe(0); expect(existsSync(f.file)).toBe(false);
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.1', realUpdateFileIo)).not.toThrow();
});

test('an actual durable retained hold publishes its reader requirement before its budget write', () => {
  const f = fixture(); let beforeWrite = false;
  const ledger = new DurableBudgetLedger(f.budget, () => clock, () => {
    expect(existsSync(f.budget)).toBe(false);
    f.owner.declare('payment-retained-holds-v2');
    expect(() => assertNativeReaderCompatible(f.execPath, '3.1.1', realUpdateFileIo)).toThrow(NativeDataCompatibilityError);
    beforeWrite = true;
  });
  expect(reserve(ledger, 'checkout')).not.toBeNull(); expect(beforeWrite).toBe(true);
  expect(JSON.parse(readFileSync(f.budget, 'utf8')).reservations).toMatchObject([{ id: 'checkout', retainUntilSettled: true }]);
  for (const version of ['3.1.2', 'v3.1.3', '4.0.0']) expect(() => assertNativeReaderCompatible(f.execPath, version, realUpdateFileIo, nativeReaderCapabilities(version))).not.toThrow();
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.2-beta.1', realUpdateFileIo)).toThrow('requires GoodVibes 3.1.2');
});

test('retiring the admitted native owner prevents a new incompatible hold from becoming available', () => {
  let active = true; const f = fixture(() => { if (!active) throw new Error('retired'); });
  const ledger = new DurableBudgetLedger(f.budget, () => clock, () => f.owner.declare('payment-retained-holds-v2'));
  active = false;
  expect(() => reserve(ledger, 'checkout')).toThrow(NativeDataCompatibilityError);
  expect(ledger.state().reservations).toEqual([]); expect(existsSync(f.budget)).toBe(false); expect(existsSync(f.file)).toBe(false);
});

test.each([1, 2])('opening stored version %s holds establishes compatibility before exposing accounting', storedVersion => {
  const f = fixture(); const previous = new BudgetLedger(); reserve(previous, 'restored', storedVersion === 2);
  writeFileSync(f.budget, JSON.stringify({ version: storedVersion, ...previous.state() }));
  const ledger = new DurableBudgetLedger(f.budget, () => clock, () => f.owner.declare('payment-retained-holds-v2'));
  expect(ledger.snapshot(limits, clock, 'UTC').item.reserved).toBe(1_000);
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.1', realUpdateFileIo)).toThrow('requires GoodVibes 3.1.2');
  expect(JSON.parse(readFileSync(f.budget, 'utf8')).reservations[0].retainUntilSettled).toBe(true);
});

test('an existing hold is not exposed or rewritten when its native publisher is unavailable', () => {
  const f = fixture(() => { throw new Error('retired'); }); const previous = new BudgetLedger(); reserve(previous, 'restored');
  const original = JSON.stringify({ version: 2, ...previous.state() }); writeFileSync(f.budget, original);
  const ledger = new DurableBudgetLedger(f.budget, () => clock, () => f.owner.declare('payment-retained-holds-v2'));
  expect(() => ledger.state()).toThrow(PaymentBudgetUnavailableError);
  expect(readFileSync(f.budget, 'utf8')).toBe(original); expect(existsSync(f.file)).toBe(false);
});

test('already published compatibility survives host cancellation so final known spends can be saved', () => {
  let active = true; let calls = 0;
  const f = fixture(() => { calls++; if (!active) throw new Error('closing'); });
  const ledger = new DurableBudgetLedger(f.budget, () => clock, () => f.owner.declare('payment-retained-holds-v2'));
  reserve(ledger, 'submitted'); reserve(ledger, 'other-held'); const admittedCalls = calls;
  active = false;
  expect(ledger.commit('submitted', clock)?.itemMinorUnits).toBe(1_000); expect(calls).toBe(admittedCalls);
  const reopened = new DurableBudgetLedger(f.budget, () => clock);
  expect(reopened.state().spend.map(row => row.purchaseId)).toEqual(['submitted']);
  expect(reopened.state().reservations.map(row => row.id)).toEqual(['other-held']);
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.1', realUpdateFileIo)).toThrow(NativeDataCompatibilityError);
});

test('a competing live publisher makes no progress until its actual file lease is released', () => {
  const f = fixture(); const release = tryAcquireCrossProcessLock(`${f.file}.lock`);
  if (!release) throw new Error('Fixture lock was not acquired');
  try { expect(() => f.owner.declare('payment-retained-holds-v2')).toThrow('Another native owner'); expect(existsSync(f.file)).toBe(false); }
  finally { release(); }
  f.owner.declare('payment-retained-holds-v2');
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.1', realUpdateFileIo)).toThrow(NativeDataCompatibilityError);
});

test.each(['{', JSON.stringify({ schema: 9 }), JSON.stringify({ schema: 1, minimumReader: '3.1.1', formats: ['payment-retained-holds-v2'] }),
  JSON.stringify({ schema: 1, minimumReader: '3.1.2', formats: ['unknown'] })])('unreadable or understated compatibility evidence is preserved: %s', original => {
  const f = fixture(); writeFileSync(f.file, original);
  expect(() => f.owner.declare('payment-retained-holds-v2')).toThrow(NativeDataCompatibilityError);
  expect(() => assertNativeReaderCompatible(f.execPath, '4.0.0', realUpdateFileIo)).toThrow(NativeDataCompatibilityError);
  expect(readFileSync(f.file, 'utf8')).toBe(original);
});

test.each(['directory', 'symlink', 'dangling'] as const)('an unsafe %s cannot masquerade as missing requirements', kind => {
  const f = fixture();
  if (kind === 'directory') mkdirSync(f.file);
  else { const target = join(f.prefix, 'outside.json'); if (kind === 'symlink') writeFileSync(target, requirement()); symlinkSync(target, f.file); }
  expect(() => f.owner.declare('payment-retained-holds-v2')).toThrow(NativeDataCompatibilityError);
  expect(() => assertNativeReaderCompatible(f.execPath, '4.0.0', realUpdateFileIo)).toThrow(NativeDataCompatibilityError);
});

test('deleting observed evidence retires the writer rather than resetting the reader floor', () => {
  const f = fixture(); f.owner.declare('payment-retained-holds-v2'); rmSync(f.file);
  expect(() => f.owner.declare('payment-retained-holds-v2')).toThrow(NativeDataCompatibilityError);
  expect(existsSync(f.file)).toBe(false);
});

test('a higher supported reader requirement cannot be lowered by an older running writer', () => {
  const f = fixture(); const original = JSON.stringify({ schema: 1, minimumReader: '3.2.0', formats: ['payment-retained-holds-v2'] });
  writeFileSync(f.file, original);
  expect(() => f.owner.declare('payment-retained-holds-v2')).toThrow('requires GoodVibes 3.2.0');
  expect(readFileSync(f.file, 'utf8')).toBe(original);
});

test('a candidate with the same version but unknown or missing reader support cannot replace a capable build', () => {
  const f = fixture(); f.owner.declare('payment-retained-holds-v2');
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.2', realUpdateFileIo)).toThrow('does not confirm support');
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.2', realUpdateFileIo, { schema: 1, version: '3.1.2', formats: [] })).toThrow('does not confirm support');
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.3'))).toThrow('does not confirm support');
  expect(() => assertNativeReaderCompatible(f.execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
});

test('candidate reader profiles are detached and do not invent support for older artifacts', () => {
  const raw = { schema: 1, version: '3.1.2', formats: ['payment-retained-holds-v2'] };
  const captured = parseNativeReaderCapabilities(raw); raw.formats.length = 0;
  expect(captured.formats).toEqual(['payment-retained-holds-v2']); expect(Object.isFrozen(captured.formats)).toBe(true);
  for (const bad of [{ ...raw, schema: 2 }, { ...raw, version: 'unknown' }, { ...raw, formats: ['x', 'x'] }, { ...raw, extra: true }]) {
    expect(() => parseNativeReaderCapabilities(bad)).toThrow(NativeDataCompatibilityError);
  }
  let accessed = false;
  const accessor = Object.defineProperty({ schema: 1, formats: [] }, 'version', { enumerable: true, get() { accessed = true; throw new Error('private profile'); } });
  expect(() => parseNativeReaderCapabilities(accessor)).toThrow(NativeDataCompatibilityError); expect(accessed).toBe(false);
  const values: string[] = []; Object.defineProperty(values, '0', { enumerable: true, configurable: true, get() { accessed = true; return 'payment-retained-holds-v2'; } });
  expect(() => parseNativeReaderCapabilities({ schema: 1, version: '3.1.2', formats: values })).toThrow(NativeDataCompatibilityError); expect(accessed).toBe(false);
});

test('an asynchronous native guard is drained and cannot publish an incompatible data requirement', async () => {
  const f = fixture(async () => { throw new Error('private native failure'); });
  expect(() => f.owner.declare('payment-retained-holds-v2')).toThrow(NativeDataCompatibilityError);
  await new Promise<void>(resolve => setImmediate(resolve)); expect(existsSync(f.file)).toBe(false);
});

for (const profile of ['old-version', 'same-version-unknown', 'same-version-missing', 'same-version-capable', 'foreign-reader-profile', 'malformed-reader-pin', 'ambiguous-reader-pin'] as const) {
  for (const hasRequirement of [false, true]) test(`canonical native update checks actual ${profile} support under all swap claims (requirement=${hasRequirement})`, async () => {
    const execPath = '/native-reader-fixture/goodvibes-daemon';
    const previous = nativeCohortFixture({ version: '3.1.2', daemonBytes: 'current' });
    const candidateVersion = profile === 'old-version' ? '3.1.1' : '3.1.2';
    const readers = profile === 'old-version' || profile === 'same-version-unknown' ? undefined
      : profile === 'same-version-missing' ? { schema: 1 as const, version: candidateVersion, formats: [] } : nativeReaderCapabilities(candidateVersion);
    const candidate = nativeCohortFixture({ version: candidateVersion, daemonBytes: 'candidate-reader', ...(readers ? { readers } : {}) });
    if (profile === 'foreign-reader-profile') {
      candidate.assets['goodvibes-daemon-linux-x64.reader-ci-artifact.json'] = Buffer.from(JSON.stringify({ ...candidate.artifact, sourceTree: 'f'.repeat(40) }));
      candidate.checksumManifest = Object.entries(candidate.assets).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join('');
    }
    if (profile === 'malformed-reader-pin' || profile === 'ambiguous-reader-pin') {
      const name = 'goodvibes-daemon-linux-x64.reader-ci-artifact.json';
      const bytes = candidate.assets[name]; if (!bytes) throw new Error('Reader fixture asset was not produced');
      candidate.checksumManifest = profile === 'malformed-reader-pin'
        ? candidate.checksumManifest.split('\n').map(line => line.endsWith('  ' + name) ? 'not-a-digest  ' + name : line).join('\n')
        : candidate.checksumManifest + sha256(bytes) + '  ' + name + '\n';
    }
    const floor = '/native-reader-fixture/' + NATIVE_READER_REQUIREMENT_FILE;
    const memory = nativeMemoryIo({ ...previous.installation(execPath), ...(hasRequirement ? { [floor]: Buffer.from(requirement()) } : {}) });
    const targets = resolveDaemonNativeTargets(execPath, 'linux', 'x64'); if (!targets) throw new Error('Native fixture target unavailable');
    let checked = false;
    const readFile = memory.io.readFile;
    const io = { ...memory.io, readFile(path: string) {
      if (path === floor) { checked = true; for (const target of targets) expect(memory.io.exists(target.path + '.update-transaction')).toBe(true); }
      return readFile(path);
    } };
    const fetchImpl: UpdateFetchLike = async url => {
      const name = url.slice(url.lastIndexOf('/') + 1);
      const bytes = name === 'SHA256SUMS.txt' ? Buffer.from(candidate.checksumManifest) : candidate.assets[name];
      if (!bytes) throw new Error('Unexpected fixture download');
      return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => bytes.toString(), arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    };
    const apply = applyVerifiedUpdate({ targets, io, fetchImpl, downloadBaseUrl: `https://fixture.invalid/v${candidateVersion}`, platform: 'linux',
      daemonNative: { execPath, platform: 'linux', arch: 'x64', version: candidateVersion } });
    if (profile === 'malformed-reader-pin' || profile === 'ambiguous-reader-pin') {
      await expect(apply).rejects.toThrow('reader artifact checksum'); expect(checked).toBe(false);
      for (const [path, bytes] of Object.entries(previous.installation(execPath))) expect(memory.files.get(path)).toEqual(bytes);
      expect(memory.mutations).toEqual([]);
    } else if (profile === 'foreign-reader-profile') {
      await expect(apply).rejects.toThrow('reader artifact does not match'); expect(checked).toBe(false);
      for (const [path, bytes] of Object.entries(previous.installation(execPath))) expect(memory.files.get(path)).toEqual(bytes);
      expect(memory.mutations).toEqual([]);
    } else if (hasRequirement && profile !== 'same-version-capable') {
      await expect(apply).rejects.toBeInstanceOf(UpdateTransactionError); expect(checked).toBe(true);
      for (const [path, bytes] of Object.entries(previous.installation(execPath))) expect(memory.files.get(path)).toEqual(bytes);
      expect(memory.mutations.filter(operation => operation.startsWith('rename:'))).toEqual([]);
    } else { await apply; expect(checked).toBe(hasRequirement); for (const [path, bytes] of Object.entries(candidate.installation(execPath))) expect(memory.files.get(path)).toEqual(bytes); }
  });
}
