/**
 * A recovery file read that races a replacement is "could not tell", not "not this session's":
 * the session keeps its one recovery file instead of gaining an opaque second one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RecoverySourceChangedError,
  createRecoveryPathResolver,
  readRecoveryHeader,
} from '../platform/src/platform/runtime/recovery-path.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function recoveryDirWithCanonical(id: string): { directory: string; canonical: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gv-recovery-path-'));
  roots.push(directory);
  const canonical = join(directory, `recovery-${id}.jsonl`);
  writeFileSync(canonical, `${JSON.stringify({ type: 'meta', sessionId: id })}\n`, 'utf-8');
  return { directory, canonical };
}

describe('recovery path resolution', () => {
  test('a read that raced a replacement is retried and the canonical file is kept', () => {
    const { directory, canonical } = recoveryDirWithCanonical('sess-1');
    let failures = 1;
    const resolve = createRecoveryPathResolver(directory, undefined, (path) => {
      if (failures-- > 0) throw new RecoverySourceChangedError();
      return readRecoveryHeader(path);
    });
    expect(resolve('sess-1')).toBe(canonical);
  });

  test('a read that keeps racing fails the resolution instead of allocating a second file', () => {
    const { directory } = recoveryDirWithCanonical('sess-2');
    const resolve = createRecoveryPathResolver(directory, undefined, () => { throw new RecoverySourceChangedError(); });
    expect(() => resolve('sess-2')).toThrow('Recovery source changed');
  });

  test('a canonical file that belongs to another session is still not reused', () => {
    const { directory, canonical } = recoveryDirWithCanonical('sess-3');
    writeFileSync(canonical, `${JSON.stringify({ type: 'meta', sessionId: 'someone-else' })}\n`, 'utf-8');
    const resolve = createRecoveryPathResolver(directory);
    const path = resolve('sess-3');
    expect(path).not.toBe(canonical);
    expect(path).toContain('recovery-opaque-');
  });
});
