import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quarantineCorruptFile, reapOwnedQuarantines } from '../platform/src/platform/utils/atomic-json-store.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const options = { label: 'test/quarantine', reason: 'invalid saved container', recovery: 'The test rebuilds from preserved evidence.' };

test('an archive whose receipt was never written is reaped once the grace window has passed', () => {
  const root = mkdtempSync(join(tmpdir(), 'empty-receipt-')); roots.push(root);
  const path = join(root, 'store.json'); writeFileSync(path, 'corrupt');
  const { quarantinePath } = quarantineCorruptFile(path, { ...options, maxFiles: 5 });
  writeFileSync(`${quarantinePath}.why`, '');
  expect(reapOwnedQuarantines(path, { maxFiles: 0, now: Date.now() })).toEqual({ reaped: 0, preservedUnknown: 1 });
  expect(readdirSync(root).filter(name => name.includes('.corrupt-'))).toHaveLength(2);
  expect(reapOwnedQuarantines(path, { maxFiles: 0, now: Date.now() + 120_000 })).toEqual({ reaped: 1, preservedUnknown: 0 });
  expect(readdirSync(root).filter(name => name.includes('.corrupt-'))).toEqual([]);
});
