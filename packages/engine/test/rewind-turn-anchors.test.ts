import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestSurface } from './_helpers/session-surface.ts';
import {
  clearTurnAnchors,
  getTurnAnchors,
  persistTurnAnchors,
  recordTurnAnchor,
  resolveTurnAnchor,
  restoreTurnAnchors,
  type TurnAnchor,
} from '../platform/src/platform/rewind/turn-anchors.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const tempDirs: string[] = [];
function makeWorkingDir(): string {
  const dir = makeProjectTempDir('gv-anchors');
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function anchor(turnId: string, messageCount: number): TurnAnchor {
  return { turnId, label: `turn ${turnId}`, messageCount, at: 1_000 + messageCount };
}

describe('rewind-turn-anchors persistence', () => {
  test('anchors survive a simulated resume: persist, clear the in-memory registry, restore', () => {
    const workingDir = makeWorkingDir();
    const sessionId = 'user-resume-roundtrip';

    recordTurnAnchor(sessionId, anchor('t1', 6));
    recordTurnAnchor(sessionId, anchor('t2', 14));
    persistTurnAnchors(sessionId, makeTestSurface(workingDir));

    // Simulate a fresh process: the in-memory registry is gone.
    clearTurnAnchors(sessionId);
    expect(getTurnAnchors(sessionId)).toHaveLength(0);

    const restored = restoreTurnAnchors(sessionId, makeTestSurface(workingDir));
    expect(restored).toBe(2);

    const anchors = getTurnAnchors(sessionId);
    expect(anchors.map((a) => a.turnId)).toEqual(['t1', 't2']);
    expect(resolveTurnAnchor(sessionId, 't2')?.messageCount).toBe(14);
    clearTurnAnchors(sessionId);
  });

  test('persist reports false when the sidecar cannot be written, true when it was', () => {
    const sessionId = 'sess-persist-result';
    recordTurnAnchor(sessionId, { turnId: 't1', label: 'x', messageCount: 1, at: 1 });
    const workingDir = makeWorkingDir();
    expect(persistTurnAnchors(sessionId, makeTestSurface(workingDir))).toBe(true);

    const blocker = join(workingDir, 'blocker');
    writeFileSync(blocker, '');
    const unwritable = { ...makeTestSurface(workingDir), sessionsDir: join(blocker, 'sessions') };
    expect(persistTurnAnchors(sessionId, unwritable)).toBe(false);
    clearTurnAnchors(sessionId);
  });

  test('restore is a no-op (returns 0) when no sidecar exists', () => {
    const workingDir = makeWorkingDir();
    expect(restoreTurnAnchors('user-never-saved', makeTestSurface(workingDir))).toBe(0);
  });

  test('a malformed sidecar restores nothing and does not throw', () => {
    const workingDir = makeWorkingDir();
    const sessionId = 'user-corrupt';
    const sessionsDir = makeTestSurface(workingDir).sessionsDir;
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${sessionId}.anchors.json`), '{ not valid json');
    expect(restoreTurnAnchors(sessionId, makeTestSurface(workingDir))).toBe(0);
    expect(getTurnAnchors(sessionId)).toHaveLength(0);
  });

  test('restore keeps a single entry per turnId when a turn is re-recorded (idempotent)', () => {
    const workingDir = makeWorkingDir();
    const sessionId = 'user-idempotent';
    recordTurnAnchor(sessionId, anchor('t1', 6));
    persistTurnAnchors(sessionId, makeTestSurface(workingDir));
    clearTurnAnchors(sessionId);

    restoreTurnAnchors(sessionId, makeTestSurface(workingDir));
    // A live turn re-records the same turnId after resume, must not duplicate.
    recordTurnAnchor(sessionId, anchor('t1', 6));
    expect(getTurnAnchors(sessionId)).toHaveLength(1);
    clearTurnAnchors(sessionId);
  });

  test('persist writes nothing (no crash) for an empty registry', () => {
    const workingDir = makeWorkingDir();
    persistTurnAnchors('user-empty', makeTestSurface(workingDir));
    expect(restoreTurnAnchors('user-empty', makeTestSurface(workingDir))).toBe(0);
  });

  test('a sessionId with a path separator is refused (no directory escape)', () => {
    const workingDir = makeWorkingDir();
    const surface = makeTestSurface(workingDir);
    recordTurnAnchor('../escape', anchor('t1', 3));
    // Refusal is reported as success-with-nothing-written: the persist is skipped, not failed.
    persistTurnAnchors('../escape', surface);
    // The unguarded path would be <sessionsDir>/../escape.anchors.json.
    expect(existsSync(join(surface.sessionsDir, '..', 'escape.anchors.json'))).toBe(false);
    expect(existsSync(join(surface.sessionsDir, '..', '..', 'escape.anchors.json'))).toBe(false);
    expect(restoreTurnAnchors('../escape', surface)).toBe(0);
    clearTurnAnchors('../escape');
  });
});
