import { join } from 'node:path';
import { beforeEach, expect, test } from 'bun:test';
import { DaemonApprovalStore } from '../platform/src/platform/payments/host/approval-store.js';
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
