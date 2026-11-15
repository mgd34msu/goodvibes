import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createOnboardingApplyPipeline } from '../terminal-shell/src/onboarding-apply-pipeline.js';

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
