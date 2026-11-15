import { beforeEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import {
  readOnboardingRuntimeState,
  writeOnboardingAcknowledgementState,
} from '@/runtime/onboarding/state.ts';
import type { OnboardingShellPaths } from '@/runtime/onboarding/types.ts';
import { createOnboardingStateStorage } from '@goodvibes-jev/engine/terminal-shell/onboarding-state';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeShellPaths(base: string): OnboardingShellPaths {
  return {
    workingDirectory: base,
    resolveProjectPath: (...segments: string[]) => join(base, 'project', ...segments),
    resolveUserPath: (...segments: string[]) => join(base, 'user', ...segments),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('onboarding state', () => {
  let tmpDir: string;
  let shellPaths: OnboardingShellPaths;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-ob-state');
    shellPaths = makeShellPaths(tmpDir);
  });

  // ── read, missing file ─────────────────────────────────────────────────

  test('readOnboardingRuntimeState returns exists:false for missing file', () => {
    const result = readOnboardingRuntimeState(shellPaths, 'project');
    expect(result.exists).toBe(false);
    expect(result.payload).toBeNull();
  });

  // ── round-trip ──────────────────────────────────────────────────────────

  test('write + read round-trips a single acknowledgement', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers',
      acknowledged: true,
      source: 'test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.exists).toBe(true);
    expect(result.payload).not.toBeNull();
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.version).toBe(1);
    expect(result.payload!.source).toBe('test');
  });

  test('write + read round-trips multiple acknowledgements independently', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'test',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'subscriptions', acknowledged: true, source: 'test',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'auth', acknowledged: false, source: 'test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.acknowledgements['subscriptions']).toBe(true);
    expect(result.payload!.acknowledgements['auth']).toBe(false);
  });

  test('second write merges with existing acknowledgements (no lost updates)', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'first',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'subscriptions', acknowledged: true, source: 'second',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    // providers must survive the second write
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.acknowledgements['subscriptions']).toBe(true);
  });

  // ── scope, user vs project ─────────────────────────────────────────────

  test('user-scope and project-scope are independent files', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'test', scope: 'user',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: false, source: 'test', scope: 'project',
    });

    const user = readOnboardingRuntimeState(shellPaths, 'user');
    const project = readOnboardingRuntimeState(shellPaths, 'project');
    expect(user.payload!.acknowledgements['providers']).toBe(true);
    expect(project.payload!.acknowledgements['providers']).toBe(false);
  });

  // ── readVersioned integration: corrupt + unknown version ────────────────

  test('corrupt JSON is quarantined and read returns null payload', () => {
    // Pre-create directory so writeFileSync can place the corrupt file.
    const stateDir = join(tmpDir, 'project', 'tui');
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, 'onboarding-state.json');
    writeFileSync(statePath, '{ bad json }}');

    const result = readOnboardingRuntimeState(shellPaths, 'project');
    expect(result.payload).toBeNull();
    expect(result.parseError).toContain('quarantined');
    // Original file must be gone (quarantined).
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(`${statePath}.unrecognized`)).toBe(true);
  });

  test('a file written by a newer version is left in place and read returns null payload', () => {
    const stateDir = join(tmpDir, 'project', 'tui');
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, 'onboarding-state.json');
    writeFileSync(statePath, JSON.stringify({ version: 999, updatedAt: Date.now(), source: 'future', acknowledgements: {} }));

    const result = readOnboardingRuntimeState(shellPaths, 'project');
    expect(result.payload).toBeNull();
    expect(result.exists).toBe(true);
    // The newer process still needs its file; this reader just cannot use it.
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(`${statePath}.unrecognized`)).toBe(false);
  });

  // ── merging successive writes ───────────────────────────────────────────
  //
  // These run one write after another in one process, so they prove the merge
  // (a write keeps the keys already in the file), not exclusion. Exclusion
  // between writers is the lock tests below.

  test('a write to another target keeps the acknowledgement already stored', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'daemon',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'auth', acknowledged: true, source: 'tui',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['providers']).toBe(true);
    expect(result.payload!.acknowledgements['auth']).toBe(true);
  });

  test('a later write wins on the same target', () => {
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'first',
    });
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: false, source: 'second',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    // Last writer wins on same key.
    expect(result.payload!.acknowledgements['providers']).toBe(false);
  });

  // ── lock primitive tests ────────────────────────────────────────────────

  test('stale lockfile is taken over and write succeeds', () => {
    // Write an initial ack so there is a state file to lock against.
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'providers', acknowledged: true, source: 'setup',
    });

    // Create the lockfile and backdate its mtime by 6s (> LOCK_STALE_MS=5s).
    const stateDir = join(tmpDir, 'project', 'tui');
    const lockPath = join(stateDir, 'onboarding-state.json.lock');
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    const staleTs = new Date(Date.now() - 6_000);
    utimesSync(lockPath, staleTs, staleTs);

    // Despite the lockfile existing, writeOnboardingAcknowledgementState must
    // take over the stale lock and complete successfully.
    writeOnboardingAcknowledgementState(shellPaths, {
      target: 'subscriptions', acknowledged: true, source: 'stale-lock-test',
    });

    const result = readOnboardingRuntimeState(shellPaths);
    expect(result.payload!.acknowledgements['subscriptions']).toBe(true);
    // Stale lock should have been removed (or replaced and released).
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a lock that stays held is waited for, then the write proceeds and leaves the holder\'s lock alone', () => {
    const stateDir = join(tmpDir, 'project', 'tui');
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, 'onboarding-state.json.lock');
    writeFileSync(lockPath, 'another-process-token');
    let sleeps = 0;
    // A clock that never advances keeps the holder's lock fresh, so the wait
    // runs out without any real time passing.
    const storage = createOnboardingStateStorage('tui', { now: () => 0, sleep: () => { sleeps += 1; } });

    const record = storage.writeOnboardingAcknowledgementState(shellPaths, {
      target: 'auth', acknowledged: true, source: 'degraded-path-test',
    });

    // It waited between attempts rather than spinning through them.
    expect(sleeps).toBeGreaterThan(1);
    expect(record.payload!.acknowledgements['auth']).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('another-process-token');
  });

  test('a lock another writer took over while this one worked is not removed on release', () => {
    const stateDir = join(tmpDir, 'project', 'tui');
    const lockPath = join(stateDir, 'onboarding-state.json.lock');
    // The workspace root is read inside the locked read-modify-write, which is
    // where a slow writer finds its stale lock replaced by a new owner's.
    const takenOver: OnboardingShellPaths = {
      ...shellPaths,
      get workingDirectory(): string {
        writeFileSync(lockPath, 'the-new-owner');
        return tmpDir;
      },
    };

    writeOnboardingAcknowledgementState(takenOver, {
      target: 'providers', acknowledged: true, source: 'slow-writer',
    });

    expect(readFileSync(lockPath, 'utf8')).toBe('the-new-owner');
  });
});
