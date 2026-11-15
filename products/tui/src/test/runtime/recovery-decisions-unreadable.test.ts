/**
 * Recording a removal must never turn "could not read the ledger" into "forgot
 * every earlier decision".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';
import { readRecoveryRemovals, recordRecoveryRemoval, recoveryDecisionsPathFor } from '../../runtime/recovery-decisions.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;
beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-recovery-unreadable');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

describe('recording a removal over an unreadable ledger', () => {
  test('a ledger that cannot be read at all (permission denied) is left exactly as it is', () => {
    // Root reads through any mode, so there is no unreadable file to make there.
    if (process.getuid?.() === 0) return;
    const path = recoveryDecisionsPathFor(surface);
    mkdirSync(dirname(path), { recursive: true });
    const earlier = JSON.stringify([{ sessionId: 'sess-old', workspace: tmpDir, removedAt: Date.now() }]);
    writeFileSync(path, earlier);
    chmodSync(path, 0);
    try {
      recordRecoveryRemoval(surface, 'sess-new');
    } finally {
      chmodSync(path, 0o600);
    }

    expect(readFileSync(path, 'utf-8')).toBe(earlier);
  });

  test('a damaged ledger is kept beside the new one rather than overwritten', () => {
    const path = recoveryDecisionsPathFor(surface);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ torn');

    recordRecoveryRemoval(surface, 'sess-new');

    expect(readFileSync(`${path}.unreadable`, 'utf-8')).toBe('{ torn');
    expect(readRecoveryRemovals(surface).map((record) => record.sessionId)).toEqual(['sess-new']);
  });
});
