import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProtectedPaymentRequests, ProtectedPaymentRequestError } from '../sdk/src/platform/payments/host/protected-requests.js';
import { encryptStore } from '../sdk/src/platform/config/secrets-keyfile.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { protectedPaymentRequest } from './helpers/protected-payment-request.ts';

const noop = () => {};
const filename = (root: string, id: string) => join(root, `${Buffer.from(id).toString('base64url')}.json`);

test('original request and taint survive real encrypted-store reopening without plaintext status or changed defaults', async () => {
  const root = join(makeProjectTempDir('payment-protected-request'), 'requests');
  const original = protectedPaymentRequest(), store = new ProtectedPaymentRequests(root);
  await store.retain(original, noop);
  const cipher = readFileSync(filename(root, original.purchaseId), 'utf8');
  for (const value of [original.input.item, original.input.checkoutUrl, original.input.reading.orderSummaryText, original.evidence.sources[0]?.text]) {
    if (!value) throw new Error('Missing private fixture');
    expect(cipher).not.toContain(value);
  }
  expect(readdirSync(root).sort()).toEqual(['.key', `${Buffer.from(original.purchaseId).toString('base64url')}.json`].sort());
  const reopened = new ProtectedPaymentRequests(root), saved = await reopened.read(original.purchaseId, original.operationId, noop);
  // Undefined optional object fields are omitted, never coerced to null/false.
  expect(saved).toEqual(JSON.parse(JSON.stringify(original)));
  expect(Object.hasOwn(saved.input, 'preferredTier')).toBe(false);
  expect(saved.input.controls.expirySeparator).toBe(''); expect(saved.input.controls.twoDigitYear).toBe(false);
  expect(saved.input.requestedMax).toBe('0.00'); expect(saved.input.reading.tax).toBeNull();
  expect(Object.isFrozen(saved.input)).toBe(true); expect(Object.isFrozen(saved.evidence.sources)).toBe(true);
  await reopened.remove(original.purchaseId, original.operationId, noop);
  expect(existsSync(filename(root, original.purchaseId))).toBe(false); expect(existsSync(join(root, '.key'))).toBe(true);
});

test('exclusive publication preserves the first request and refuses another operation under that purchase identity', async () => {
  const root = join(makeProjectTempDir('payment-protected-exclusive'), 'requests'), original = protectedPaymentRequest();
  await new ProtectedPaymentRequests(root).retain(original, noop);
  const before = readFileSync(filename(root, original.purchaseId));
  await expect(new ProtectedPaymentRequests(root).retain({ ...protectedPaymentRequest(original.purchaseId), input: { ...original.input, requestedMax: '999.00' } }, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(readFileSync(filename(root, original.purchaseId))).toEqual(before);
  await expect(new ProtectedPaymentRequests(root).read(original.purchaseId, protectedPaymentRequest().operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  const copiedId = 'copied-purchase'; writeFileSync(filename(root, copiedId), before, { mode: 0o600 });
  await expect(new ProtectedPaymentRequests(root).read(copiedId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
});

test.each(['missing', 'malformed', 'replaced'] as const)('a %s original key never causes fallback decryption or replacement', async kind => {
  const root = join(makeProjectTempDir('payment-protected-key'), 'requests'), original = protectedPaymentRequest();
  await new ProtectedPaymentRequests(root).retain(original, noop);
  const path = join(root, '.key'), originalCipher = readFileSync(filename(root, original.purchaseId));
  if (kind === 'missing') unlinkSync(path);
  else writeFileSync(path, kind === 'malformed' ? 'broken key' : `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const before = existsSync(path) ? readFileSync(path) : null;
  const store = new ProtectedPaymentRequests(root);
  await expect(store.read(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  await expect(store.retain(protectedPaymentRequest('new-purchase'), noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
  expect(readFileSync(filename(root, original.purchaseId))).toEqual(originalCipher);
});

test.each(['tag', 'version', 'plaintext-shape'] as const)('damaged %s remains intact and disables further publication', async kind => {
  const root = join(makeProjectTempDir('payment-protected-damage'), 'requests'), original = protectedPaymentRequest();
  await new ProtectedPaymentRequests(root).retain(original, noop);
  const path = filename(root, original.purchaseId), envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (kind === 'tag') envelope['tag'] = '0'.repeat(32);
  else if (kind === 'version') envelope['version'] = 999;
  else {
    const key = Buffer.from(readFileSync(join(root, '.key'), 'utf8').trim(), 'hex');
    Object.assign(envelope, encryptStore(JSON.stringify({ ...original, evidence: { ...original.evidence, complete: false } }), key));
  }
  const damaged = JSON.stringify(envelope); writeFileSync(path, damaged);
  const store = new ProtectedPaymentRequests(root);
  await expect(store.read(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  await expect(store.retain(protectedPaymentRequest('another'), noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(readFileSync(path, 'utf8')).toBe(damaged);
});

test.each(['symlink', 'hardlink', 'permissions', 'directory'] as const)('an unsafe %s record is refused without removing or following it', async kind => {
  const root = join(makeProjectTempDir('payment-protected-unsafe'), 'requests'), original = protectedPaymentRequest();
  await new ProtectedPaymentRequests(root).retain(original, noop);
  const path = filename(root, original.purchaseId), retained = join(root, 'retained-original'); renameSync(path, retained);
  if (kind === 'symlink') symlinkSync(retained, path);
  else if (kind === 'hardlink') linkSync(retained, path);
  else if (kind === 'directory') mkdirSync(path, { mode: 0o700 });
  else { renameSync(retained, path); chmodSync(path, 0o644); }
  await expect(new ProtectedPaymentRequests(root).read(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(existsSync(path)).toBe(true);
});

test.each(['record', 'key', 'parent'] as const)('same-byte %s replacement retires observed ownership and refuses cleanup', async kind => {
  const base = makeProjectTempDir('payment-protected-replacement'), root = join(base, 'requests'), original = protectedPaymentRequest();
  const store = new ProtectedPaymentRequests(root); await store.retain(original, noop);
  const path = filename(root, original.purchaseId);
  if (kind === 'parent') { renameSync(root, join(base, 'retained')); mkdirSync(root, { mode: 0o700 });
    for (const name of readdirSync(join(base, 'retained'))) writeFileSync(join(root, name), readFileSync(join(base, 'retained', name)), { mode: 0o600 });
  } else { const target = kind === 'key' ? join(root, '.key') : path;
    writeFileSync(join(base, 'replacement'), readFileSync(target), { mode: 0o600 }); renameSync(join(base, 'replacement'), target); }
  const before = readFileSync(path);
  await expect(store.remove(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(readFileSync(path)).toEqual(before);
  await expect(store.read(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
});

test('a retired admission cannot create or read a protected request and a missing store is never initialized by read', async () => {
  const root = join(makeProjectTempDir('payment-protected-retired'), 'requests'), original = protectedPaymentRequest();
  await expect(new ProtectedPaymentRequests(root).retain(original, () => { throw new Error('private owner detail'); })).rejects.toThrow('original protected checkout request');
  expect(existsSync(root)).toBe(false);
  await expect(new ProtectedPaymentRequests(root).read(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(existsSync(root)).toBe(false);
});

test('a failed final directory flush retains the published cipher and never acknowledges durable preparation', async () => {
  const root = join(makeProjectTempDir('payment-protected-durability'), 'requests'), store = new ProtectedPaymentRequests(root);
  // Initialize the real key independently so the injected failure reaches
  // final request publication, rather than failing first at key creation.
  const first = protectedPaymentRequest('known-earlier'); await store.retain(first, noop);
  const original = protectedPaymentRequest('uncertain-publication'), path = filename(root, original.purchaseId), sync = fs.fsyncSync;
  const failure = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (existsSync(path) && fs.fstatSync(fd).isDirectory()) throw new Error('Private directory failure');
    sync(fd);
  });
  try { await expect(store.retain(original, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError); }
  finally { failure.mockRestore(); }
  expect(existsSync(path)).toBe(true);
  const retained = readFileSync(path);
  await expect(store.remove(original.purchaseId, original.operationId, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
  expect(readFileSync(path)).toEqual(retained);
  // A fresh owner can inspect facts after the filesystem is healthy. The
  // original failed instance cannot infer successful admission or execution.
  expect((await new ProtectedPaymentRequests(root).read(original.purchaseId, original.operationId, noop)).input.item).toBe(original.input.item);
});
