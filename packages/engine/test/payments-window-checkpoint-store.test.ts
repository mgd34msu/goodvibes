import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtectedPaymentRequests } from '../platform/src/platform/payments/host/protected-requests.js';
import { captureCheckoutWindowCheckpoint } from '../platform/src/platform/payments/checkout-window-checkpoint.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, NATIVE_READER_REQUIREMENT_FILE } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import { extractCheckout } from '../platform/src/platform/payments/checkout-extraction.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(beforeCheckpoint?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'payment-window-checkpoint-')); roots.push(root);
  const directory = join(root, 'requests'), original = protectedPaymentRequest(), window = protectedPaymentWindow(original);
  const store = new ProtectedPaymentRequests(directory, beforeCheckpoint, undefined, undefined, undefined, () => {});
  await store.retain(original, () => {});
  const path = join(directory, `${Buffer.from(original.purchaseId).toString('base64url')}.json`);
  const old = readFileSync(path);
  return { root, directory, original, window, store, path, old };
}

test('the actual encrypted request retains the latest window quote without rewriting its original intent or evidence', async () => {
  const f = await fixture();
  expect((await f.store.read(f.original.purchaseId, f.original.operationId, () => {})).window).toBeUndefined();
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, f.window, null, () => {});
  const saved = await new ProtectedPaymentRequests(f.directory).read(f.original.purchaseId, f.original.operationId, () => {});
  expect(saved.window).toEqual(f.window);
  expect(saved.input.reading.lines[0]?.unitPrice).toBe('10.00');
  expect(saved.window?.reading.lines[0]?.unitPrice).toBe('20.00');
  expect(saved.principalId).toBe(f.original.principalId); expect(saved.host.authority).toEqual(f.original.host.authority);
  expect(saved.evidence).toEqual(f.original.evidence);
  const disk = readFileSync(f.path, 'utf8');
  expect(disk).not.toContain(f.original.input.item); expect(disk).not.toContain(f.window.record.windowNotice ?? '');
  expect(disk).not.toContain('Original private page evidence');
});

test.each(['purchase', 'page', 'card', 'intent', 'reservation', 'total', 'quote', 'phase'] as const)(
  'a foreign or inconsistent %s cannot replace retained checkout evidence', async kind => {
    const f = await fixture(), value = structuredClone(f.window);
    if (kind === 'purchase') Reflect.set(value.record, 'purchaseId', 'other');
    if (kind === 'page') Reflect.set(value.record, 'pageId', 'other');
    if (kind === 'card') Reflect.set(value.record, 'cardId', 'other');
    if (kind === 'intent') Reflect.set(value.record, 'item', 'other');
    if (kind === 'reservation') Reflect.set(value.record, 'reservationId', 'other');
    if (kind === 'total') Reflect.set(value.record, 'totalMinorUnits', 1);
    if (kind === 'quote') Reflect.set(value.reading, 'lines', [{ label: 'owner item', quantity: '1', unitPrice: '30.00' }]);
    if (kind === 'phase') Reflect.set(value.record, 'phase', 'submit-pending');
    await expect(f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, value, null, () => {})).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(f.old);
    expect((await new ProtectedPaymentRequests(f.directory).read(f.original.purchaseId, f.original.operationId, () => {})).window).toBeUndefined();
  },
);

test('an earlier checkpoint cannot overwrite a later retained quote', async () => {
  const f = await fixture();
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, protectedPaymentWindow(f.original, 3), null, () => {});
  const later = readFileSync(f.path);
  await expect(f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, f.window, null, () => {})).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(later);
});

test('the real installed-data owner declares the checkpoint format before incompatible encrypted publication', async () => {
  const publication = { declare: () => {} };
  const f = await fixture(() => publication.declare());
  const execPath = join(f.root, 'goodvibes-daemon'), requirement = join(f.root, NATIVE_READER_REQUIREMENT_FILE);
  const native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent: () => {} });
  expect(existsSync(requirement)).toBe(false);
  publication.declare = () => {
    expect(readFileSync(f.path)).toEqual(f.old);
    native.declare('payment-window-checkpoints-v1');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
      { schema: 1, version: '3.1.2', formats: ['payment-retained-holds-v2', 'telegram-account-cursors-v2'] })).toThrow();
  };
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, f.window, null, () => {});
  expect(JSON.parse(readFileSync(requirement, 'utf8')).formats).toEqual(['payment-window-checkpoints-v1']);
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
});

function replaceCheckpointFile(path: string, bytes: Buffer): void {
  writeFileSync(path + '.other', bytes, { mode: 0o600 });
  renameSync(path + '.other', path);
}

test.each(['retire', 'replace'] as const)('a publication callback cannot %s the original owned file then continue', async kind => {
  let publish = () => {}, live = true;
  const f = await fixture(() => publish());
  publish = () => {
    if (kind === 'retire') live = false;
    else replaceCheckpointFile(f.path, f.old);
  };
  await expect(f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, f.window, null,
    () => { if (!live) throw new Error('Owner retired'); })).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(f.old);
});

test('capture rejects incomplete windows and retains detached immutable quote facts', () => {
  const original = protectedPaymentRequest(), window = protectedPaymentWindow(original), captured = captureCheckoutWindowCheckpoint(window);
  Reflect.set(window.reading, 'lines', []); Reflect.set(window.record, 'windowNotice', 'replacement');
  expect(captured.reading.lines).toHaveLength(1); expect(captured.record.windowNotice).toBe('Approve the actual twenty dollar quote.');
  expect(() => captureCheckoutWindowCheckpoint({ ...captured, record: { ...captured.record, windowDeliveries: undefined } })).toThrow();
});

test('exact selected terms use the v2 native reader floor and remain independently readable after restart', async () => {
  const f = await fixture(), parsed = extractCheckout(f.window.reading, f.window.record.currency);
  if (!parsed.ok) throw new Error('Fixture quote');
  const quote = parsed.checkout;
  const window = { ...f.window, terms: { submitTarget: f.original.input.controls.placeOrderTarget,
    merchantDomain: f.window.record.merchantDomain, currency: quote.currency, lines: quote.lines,
    taxMinorUnits: quote.taxMinorUnits, feesMinorUnits: quote.feesMinorUnits, feeLabels: quote.feeLabels,
    shippingLabel: 'normal', shippingMinorUnits: 0, totalMinorUnits: 2_000 } };
  const execPath = join(f.root, 'goodvibes-daemon'), native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent: () => {} });
  const store = new ProtectedPaymentRequests(f.directory, version => {
    expect(version).toBe(2); expect(readFileSync(f.path)).toEqual(f.old);
    native.declare('payment-window-checkpoints-v2');
  });
  await store.checkpointWindow(f.original.purchaseId, f.original.operationId, window, null, () => {});
  const saved = await new ProtectedPaymentRequests(f.directory).read(f.original.purchaseId, f.original.operationId, () => {});
  expect(saved.window?.terms).toEqual(window.terms);
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
    { schema: 1, version: '3.1.2', formats: ['payment-retained-holds-v2', 'telegram-account-cursors-v2', 'payment-window-checkpoints-v1'] })).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
  expect(() => captureCheckoutWindowCheckpoint({ ...window, terms: { ...window.terms, shippingLabel: 'Unselected option' } })).toThrow();
  expect(() => captureCheckoutWindowCheckpoint({ ...window, terms: { ...window.terms, totalMinorUnits: 1 } })).toThrow();
});


test('encrypted checkpoints retain distinct recipients on one channel and refuse the same receipt twice', async () => {
  const f = await fixture(), first = f.window.record.windowDeliveries?.[0];
  if (!first?.receipt) throw new Error('Missing original receipt');
  const second = { ...first, receipt: { ...first.receipt, conversationId: '-100456' } };
  const window = { ...f.window, record: { ...f.window.record, windowDeliveries: [first, second] } };
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, window, null, () => {});
  const saved = await new ProtectedPaymentRequests(f.directory, undefined, undefined, undefined, undefined, () => {}).read(f.original.purchaseId, f.original.operationId, () => {});
  expect(saved.window?.record.windowDeliveries).toEqual([first, second]);
  const before = readFileSync(f.path);
  await expect(f.store.checkpointWindow(f.original.purchaseId, f.original.operationId,
    { ...window, record: { ...window.record, windowDeliveries: [first, { ...first }] } }, null, () => {})).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(before);
});

test('a multi-recipient native floor precedes encrypted publication and an older same-version reader refuses it', async () => {
  const f = await fixture(), first = f.window.record.windowDeliveries?.[0];
  if (!first?.receipt) throw new Error('Missing original receipt');
  const window = { ...f.window, record: { ...f.window.record, windowDeliveries: [first, { ...first, receipt: { ...first.receipt, conversationId: '-100456' } }] } };
  const execPath = join(f.root, 'goodvibes-daemon'), native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  let declarations = 0;
  const store = new ProtectedPaymentRequests(f.directory, undefined, undefined, undefined, undefined, () => {
    if (declarations++ === 0) expect(readFileSync(f.path)).toEqual(f.old);
    native.declare('payment-multi-recipient-checkpoints-v1');
  });
  await store.checkpointWindow(f.original.purchaseId, f.original.operationId, window, null, () => {});
  expect(declarations).toBeGreaterThan(0);
  const older = nativeReaderCapabilities('3.1.2');
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
    { ...older, formats: older.formats.filter(format => format !== 'payment-multi-recipient-checkpoints-v1') })).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, older)).not.toThrow();
  await expect(new ProtectedPaymentRequests(f.directory).read(f.original.purchaseId, f.original.operationId, () => {})).rejects.toThrow();
  expect((await store.read(f.original.purchaseId, f.original.operationId, () => {})).window).toEqual(window);
});

test.each(['missing', 'refused', 'async', 'thrown-rejection'] as const)('an unavailable %s multi-recipient floor preserves the original encrypted checkpoint', async kind => {
  const f = await fixture(), first = f.window.record.windowDeliveries?.[0];
  if (!first?.receipt) throw new Error('Missing original receipt');
  const window = { ...f.window, record: { ...f.window.record, windowDeliveries: [first, { ...first, receipt: { ...first.receipt, conversationId: '-100456' } }] } };
  const before = kind === 'missing' ? undefined : kind === 'refused'
    ? () => { throw new Error('Original native readers cannot admit this format'); }
    : kind === 'thrown-rejection' ? () => { throw Promise.reject(new Error('Misused thrown native writer')); }
    : () => Promise.reject(new Error('Misused asynchronous native writer'));
  const store = new ProtectedPaymentRequests(f.directory, undefined, undefined, undefined, undefined, before);
  await expect(store.checkpointWindow(f.original.purchaseId, f.original.operationId, window, null, () => {})).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(f.old);
  expect((await new ProtectedPaymentRequests(f.directory).read(f.original.purchaseId, f.original.operationId, () => {})).window).toBeUndefined();
});
