/**
 * The preservation gate compares the original public reference with the private archive. It may skip a
 * declared file only when the baseline tree does not hold it; a baseline it cannot read is a failed gate.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveDeclaredReadReceipts, verifyPrivateReceiptPreservation } from '../../platform/src/platform/contract/private-read-receipts.js';
import type { ContractView } from '../../platform/src/platform/contract/types.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = makeRepo(); roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  const receipt = '.goodvibes/reviews/ctr-abcd1234/source-receipts.json';
  const observations = [{ path: 'review-artifacts/findings.md', returnedRanges: ['1-1'], returnedLines: 1,
    contentKind: 'declared-reference' as const, returnedContent: '1 | original ledger' }];
  const contract = { id: 'ctr-abcd1234', projectRoot: root, units: [
    { id: 'u1', status: 'passed', files: [], checks: [{ id: 'u1.k1', result: 'pass' }], readEvidence: observations },
    { id: 'u2', status: 'running', files: [receipt], checks: [], readEvidence: [] },
  ] } as unknown as ContractView;
  preserveDeclaredReadReceipts(contract);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  return { root, receipt, contract, head };
}

test('a working directory that is not a repository fails the gate instead of skipping the reference', () => {
  const f = fixture();
  const elsewhere = mkdtempSync(join(tmpdir(), 'not-a-repository-')); roots.push(elsewhere);
  const unit = { ...f.contract.units[1]!, files: [f.receipt, 'review-artifacts/findings.md'], baseline: { head: f.head, dirty: {} } };
  const gate = verifyPrivateReceiptPreservation(f.contract, unit, elsewhere)!;
  expect(gate.passed).toBe(false);
  expect(gate.output).toContain('review-artifacts/findings.md could not be read');
});

test('a baseline commit that does not exist fails the gate', () => {
  const f = fixture();
  const unit = { ...f.contract.units[1]!, files: [f.receipt, 'review-artifacts/findings.md'], baseline: { head: 'f'.repeat(40), dirty: {} } };
  expect(verifyPrivateReceiptPreservation(f.contract, unit, f.root)!.passed).toBe(false);
});

test('a declared file the baseline never held is reported as new, and the gate still passes', () => {
  const f = fixture();
  const unit = { ...f.contract.units[1]!, files: [f.receipt, 'review-artifacts/findings.md'], baseline: { head: f.head, dirty: {} } };
  const gate = verifyPrivateReceiptPreservation(f.contract, unit, f.root)!;
  expect(gate.passed).toBe(true);
  expect(JSON.parse(gate.output)).toMatchObject({ referenceChecks: [], absentAtBaseline: ['review-artifacts/findings.md'] });
});
