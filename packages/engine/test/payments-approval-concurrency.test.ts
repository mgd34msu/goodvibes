import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, spyOn, test } from 'bun:test';
import { DaemonApprovalStore, PaymentApprovalStoreError } from '../platform/src/platform/payments/host/approval-store.js';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const ACTION = 'payments.checkout.begin';
const CONTENT = { merchant: 'example.invalid', item: 'a test item', amount: '20.00' } as const;
let filePath = '';
beforeEach(() => { filePath = join(makeProjectTempDir('approval-concurrency'), 'approvals.json'); });

test('already-open owners cannot re-spend a grant or overwrite one another’s newer grant', () => {
  const first = new DaemonApprovalStore(filePath), second = new DaemonApprovalStore(filePath);
  first.grant({ action: ACTION, content: CONTENT });
  expect(first.pendingCount()).toBe(1); expect(second.pendingCount()).toBe(1);
  expect(first.take({ action: ACTION, content: CONTENT }).approval).not.toBeNull();
  expect(second.take({ action: ACTION, content: CONTENT })).toEqual({ approval: null, mismatch: 'none' });
  first.grant({ action: ACTION, content: { ...CONTENT, item: 'first item' } });
  second.grant({ action: ACTION, content: { ...CONTENT, item: 'second item' } });
  expect(first.pendingCount()).toBe(2);
  expect(first.take({ action: ACTION, content: { ...CONTENT, item: 'second item' } }).approval).not.toBeNull();
  expect(second.take({ action: ACTION, content: { ...CONTENT, item: 'first item' } }).approval).not.toBeNull();
});

test('extra input fields cannot replace the owner surface or extend the fixed approval lifetime', () => {
  let clock = Date.parse('2026-11-08T12:00:00.000Z');
  const store = new DaemonApprovalStore(filePath, () => new Date(clock));
  const input = { action: ACTION, content: CONTENT, ttlMs: 24 * 60 * 60 * 1000, surface: 'web-page' };
  expect(store.grant(input).surface).toBe('owner-direct');
  clock += 6 * 60 * 1000;
  expect(store.take({ action: ACTION, content: CONTENT })).toEqual({ approval: null, mismatch: 'expired' });
});

test('a held mutation lock refuses without changing evidence and becomes usable after release', () => {
  const store = new DaemonApprovalStore(filePath); store.grant({ action: ACTION, content: CONTENT });
  const bytes = fs.readFileSync(filePath), release = tryAcquireCrossProcessLock(`${filePath}.mutation.lock`);
  if (!release) throw new Error('Expected the actual approval mutation lock');
  try {
    expect(() => store.take({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
    expect(fs.readFileSync(filePath)).toEqual(bytes);
  } finally { release(); }
  expect(store.take({ action: ACTION, content: CONTENT }).approval).not.toBeNull();
});

test('supported file and row extensions survive a grant and an unrelated spend', () => {
  const store = new DaemonApprovalStore(filePath); store.grant({ action: ACTION, content: CONTENT });
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version: number; approvals: Record<string, unknown>[]; extension?: unknown };
  raw.extension = { retain: true }; const row = raw.approvals[0]; if (!row) throw new Error('Expected persisted grant');
  row['extension'] = { original: true }; fs.writeFileSync(filePath, JSON.stringify(raw));
  store.grant({ action: ACTION, content: { ...CONTENT, item: 'another item' } });
  store.take({ action: ACTION, content: { ...CONTENT, item: 'another item' } });
  const after = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof raw;
  expect(after.extension).toEqual({ retain: true }); expect(after.approvals[0]?.['extension']).toEqual({ original: true });
});

test('deleted observed or unsafe evidence cannot be interpreted as unused storage', () => {
  const store = new DaemonApprovalStore(filePath); store.grant({ action: ACTION, content: CONTENT }); fs.unlinkSync(filePath);
  expect(() => store.grant({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
  fs.symlinkSync(`${filePath}.absent`, filePath);
  expect(() => new DaemonApprovalStore(filePath).pendingCount()).toThrow(PaymentApprovalStoreError);
});

test.each([{ version: 2, approvals: [] }, { version: 1 }, { version: 1, approvals: [null] }])('unsupported or invalid storage is never rewritten', raw => {
  const bytes = JSON.stringify(raw); fs.writeFileSync(filePath, bytes);
  const store = new DaemonApprovalStore(filePath);
  expect(() => store.grant({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(bytes);
});

test('a failed directory confirmation never restores a spent approval from memory', () => {
  const store = new DaemonApprovalStore(filePath); store.grant({ action: ACTION, content: CONTENT });
  const actual = fs.fsyncSync;
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('Private filesystem diagnostic');
    actual(fd);
  });
  try { expect(() => store.take({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError); }
  finally { sync.mockRestore(); }
  expect(() => store.take({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
  expect(new DaemonApprovalStore(filePath).take({ action: ACTION, content: CONTENT })).toEqual({ approval: null, mismatch: 'none' });
});

test('actual concurrent processes have exactly one successful spend of the original grant', async () => {
  new DaemonApprovalStore(filePath).grant({ action: ACTION, content: CONTENT });
  const childPath = join(makeProjectTempDir('approval-processes'), 'spend.ts');
  const module = new URL('../platform/src/platform/payments/host/approval-store.ts', import.meta.url).href;
  fs.writeFileSync(childPath, `import { DaemonApprovalStore, PaymentApprovalStoreError } from ${JSON.stringify(module)};
const store = new DaemonApprovalStore(process.argv[2]!);
const input = JSON.parse(process.argv[3]!);
for (let i = 0; ; i++) {
  try { process.stdout.write(JSON.stringify(store.take(input))); break; }
  catch (error) { if (!(error instanceof PaymentApprovalStoreError) || error.kind !== 'busy' || i > 100) throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
}`);
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, 'run', childPath, filePath, JSON.stringify({ action: ACTION, content: CONTENT })], { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }));
  for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
  const grants = results.map(result => JSON.parse(result.stdout) as { approval: unknown });
  expect(grants.filter(result => result.approval !== null)).toHaveLength(1);
  expect(new DaemonApprovalStore(filePath).pendingCount()).toBe(0);
});
