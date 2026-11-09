/** Original synchronous claim proof, authored and UNRUN. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCrossProcessLockCurrent, tryAcquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.ts';
test('a re-opened identical pathname cannot attest the original acquired claim or delete its replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'trigger-native-claim-')), path = join(root, 'owner.lock');
  try {
    const release = tryAcquireCrossProcessLock(path); if (!release) throw Error('Expected original claim');
    assertCrossProcessLockCurrent(release); const bytes = readFileSync(path); renameSync(path, `${path}.original`); writeFileSync(path, bytes);
    expect(() => assertCrossProcessLockCurrent(release)).toThrow('Original native lock owner changed');
    expect(() => release()).toThrow('Original native lock owner changed'); expect(readFileSync(path)).toEqual(bytes);
    expect(() => assertCrossProcessLockCurrent(release)).toThrow('Original native lock ownership is unavailable'); release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a release-shaped function cannot mint a descriptor-backed native claim', () => {
  expect(() => assertCrossProcessLockCurrent(() => {})).toThrow('Original native lock ownership is unavailable');
});
