import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import {
  readOnboardingRuntimeState,
  writeOnboardingAcknowledgementState,
} from '@/runtime/onboarding/state.ts';
import type { OnboardingShellPaths } from '@/runtime/onboarding/types.ts';

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
  // (a write keeps the keys already in the file), not exclusion between
  // processes, which the kernel-released process lock provides.

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
});
