import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtectedPaymentRequests } from '../sdk/src/platform/payments/host/protected-requests.js';
import { captureCheckoutWindowCheckpoint } from '../sdk/src/platform/payments/checkout-window-checkpoint.js';
import { protectedPaymentRequest } from './helpers/protected-payment-request.js';
import { protectedPaymentWindow } from './helpers/protected-payment-window.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, NATIVE_READER_REQUIREMENT_FILE } from '../sdk/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../sdk/src/platform/runtime/self-update.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(beforeCheckpoint?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'payment-window-checkpoint-')); roots.push(root);
  const directory = join(root, 'requests'), original = protectedPaymentRequest(), window = protectedPaymentWindow(original);
  const store = new ProtectedPaymentRequests(directory, beforeCheckpoint);
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
  let declare = () => {};
  const f = await fixture(() => declare());
  const execPath = join(f.root, 'goodvibes-daemon'), requirement = join(f.root, NATIVE_READER_REQUIREMENT_FILE);
  const native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent: () => {} });
  expect(existsSync(requirement)).toBe(false);
  declare = () => {
    expect(readFileSync(f.path)).toEqual(f.old);
    native.declare('payment-window-checkpoints-v1');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
      { schema: 1, version: '3.1.2', formats: ['payment-retained-holds-v2', 'telegram-account-cursors-v2'] })).toThrow();
  };
  await f.store.checkpointWindow(f.original.purchaseId, f.original.operationId, f.window, null, () => {});
  expect(JSON.parse(readFileSync(requirement, 'utf8')).formats).toEqual(['payment-window-checkpoints-v1']);
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
});

test.each(['retire', 'replace'] as const)('a publication callback cannot %s the original owned file then continue', async kind => {
  let publish = () => {}, live = true;
  const f = await fixture(() => publish());
  publish = () => {
    if (kind === 'retire') live = false;
    else { writeFileSync(f.path + '.other', f.old, { mode: 0o600 }); renameSync(f.path + '.other', f.path); }
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
