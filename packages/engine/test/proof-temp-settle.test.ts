import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALE_PROOF_TMP_MS, prepareObserveProofWorkspace, settleProofWorkspace } from '../scripts/proof-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function backdate(path: string): void {
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000);
  utimesSync(path, old, old);
}

test('a passing run on default scratch is reclaimed by the next run once it is old', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-settle-')); roots.push(root);
  const scratch = prepareObserveProofWorkspace(undefined, root);
  settleProofWorkspace(scratch, true);
  backdate(scratch);
  prepareObserveProofWorkspace(undefined, root);
  expect(existsSync(scratch)).toBe(false);
});

test('a failing run keeps its scratch past the sweep', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-settle-')); roots.push(root);
  const scratch = prepareObserveProofWorkspace(undefined, root);
  settleProofWorkspace(scratch, false);
  backdate(scratch);
  prepareObserveProofWorkspace(undefined, root);
  expect(existsSync(scratch)).toBe(true);
});
