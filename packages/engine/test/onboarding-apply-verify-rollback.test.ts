import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnboardingApplyPipeline } from '../terminal-shell/src/onboarding-apply-pipeline.js';
import { createOnboardingStateStorage } from '../terminal-shell/src/onboarding-state.js';
import type { OnboardingShellPaths } from '../terminal-shell/src/onboarding-state-types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Op = { readonly kind: 'set-config' | 'set-secret'; readonly key: string };
function pipeline(verify: () => Promise<{ items: { id: string; status: string; message: string }[] }>) {
  const log: string[] = [];
  const port = createOnboardingApplyPipeline<null, Op, { operations: readonly Op[] }, { kind: Op['kind']; summary: string }>({
    prevalidate: () => [],
    order: (operations) => operations,
    rollbackFor: async (_deps, operation) => () => {
      log.push(`rollback ${operation.key}`);
    },
    apply: (_deps, _request, operation) => {
      log.push(`apply ${operation.key}`);
      return { kind: operation.kind, summary: operation.key };
    },
    rollback: async (actions) => {
      for (const action of [...actions].reverse()) await action();
      return [];
    },
    verify: verify as never,
    verificationFailureKind: () => 'set-config',
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return { log, ...port };
}

describe('onboarding apply with a verifier that throws', () => {
  test('every applied operation is rolled back in reverse order and the result is a failure, not a rejection', async () => {
    const { log, applyOnboardingRequest } = pipeline(async () => {
      throw new Error('keychain locked');
    });
    const result = await applyOnboardingRequest(null, { operations: [{ kind: 'set-secret', key: 'a' }, { kind: 'set-config', key: 'b' }] });
    expect(result.ok).toBe(false);
    expect(result.applied).toHaveLength(0);
    expect(log).toEqual(['apply a', 'apply b', 'rollback b', 'rollback a']);
    expect(result.errors.map((error) => error.message).join(' ')).toContain('keychain locked');
  });

  test('a passing verification keeps the writes', async () => {
    const { log, applyOnboardingRequest } = pipeline(async () => ({ items: [{ id: 'config:a', status: 'pass', message: '' }] }));
    const result = await applyOnboardingRequest(null, { operations: [{ kind: 'set-config', key: 'a' }] });
    expect(result.ok).toBe(true);
    expect(log).toEqual(['apply a']);
  });
});

describe('onboarding acknowledgement state lock', () => {
  function shellPaths(root: string): OnboardingShellPaths {
    return {
      workingDirectory: root,
      resolveProjectPath: (...segments: string[]) => join(root, '.goodvibes', ...segments),
      resolveUserPath: (...segments: string[]) => join(root, 'home', ...segments),
    } as unknown as OnboardingShellPaths;
  }
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-lock-'));
    roots.push(root);
    const paths = shellPaths(root);
    return { root, paths };
  }

  test('a writer waits for the holder and then merges instead of overwriting', () => {
    const { paths } = setup();
    const probe = createOnboardingStateStorage('tui');
    const statePath = probe.getOnboardingRuntimeStatePath(paths, 'project');
    mkdirSync(join(statePath, '..'), { recursive: true });
    const lock = `${statePath}.lock`;
    writeFileSync(lock, 'other-writer');
    let sleeps = 0;
    const storage = createOnboardingStateStorage('tui', {
      sleep: () => {
        sleeps += 1;
        // The holder finishes its write (acknowledging providers) and releases after a few waits.
        if (sleeps === 3) {
          writeFileSync(statePath, JSON.stringify({ version: 1, updatedAt: 1, source: 'holder', acknowledgements: { providers: true } }));
          rmSync(lock);
        }
      },
    });
    const record = storage.writeOnboardingAcknowledgementState(paths, { target: 'auth', acknowledged: true, source: 'second' });
    expect(sleeps).toBe(3);
    expect(record.payload?.acknowledgements).toEqual({ providers: true, auth: true });
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock left by a crashed writer is taken over once it is stale, without waiting', () => {
    const { paths } = setup();
    const probe = createOnboardingStateStorage('tui');
    const statePath = probe.getOnboardingRuntimeStatePath(paths, 'project');
    mkdirSync(join(statePath, '..'), { recursive: true });
    const lock = `${statePath}.lock`;
    writeFileSync(lock, 'crashed-writer');
    let sleeps = 0;
    const storage = createOnboardingStateStorage('tui', { now: () => Date.now() + 60_000, sleep: () => { sleeps += 1; } });
    const record = storage.writeOnboardingAcknowledgementState(paths, { target: 'auth', acknowledged: true, source: 'x' });
    expect(sleeps).toBe(0);
    expect(record.payload?.acknowledgements).toEqual({ auth: true });
    expect(readFileSync(statePath, 'utf-8')).toContain('"auth": true');
    expect(existsSync(lock)).toBe(false);
  });
});
