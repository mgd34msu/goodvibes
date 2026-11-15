/**
 * native-routes-error-mapping.test.ts
 *
 * What a caller of the native intake and submission verbs is told when the
 * stored record, not the request, is the problem, and when access changes after
 * the work was already recorded.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog, type GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog.js';
import { registerNativeConversationIntakeGatewayMethods } from '../platform/src/platform/control-plane/routes/native-intake.js';
import { registerNativeWorkExecutionGatewayMethods } from '../platform/src/platform/control-plane/routes/native-work-execution.js';
import { NativeWorkExecutionError } from '../platform/src/platform/workflow/work-ledger/native-execution-types.js';
import { NativeConversationMoveRefused } from '../platform/src/platform/knowledge/store-native-refusal.js';
import { registerNativeWorkSubmissionGatewayMethods } from '../platform/src/platform/control-plane/routes/native-work-submission.js';
import type { NativeConversationIntakeHost } from '../platform/src/platform/workflow/work-ledger/native-intake.js';
import { NativeConversationStorageError } from '../platform/src/platform/workflow/work-ledger/native-intake-types.js';
import { NativeWorkSubmissionError } from '../platform/src/platform/workflow/work-ledger/native-submission.js';
import type { NativePairedSnapshot } from '../platform/src/platform/security/http-auth.js';

const scopes = ['read:work-ledger', 'write:work-ledger'];
const current: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'token-1', principalId: 'pairing:token-1', authorityId: 'pairing:token-1', authorityRevision: 'token-1', scopes };

function invocation(body: unknown, authorized: () => boolean): GatewayMethodInvocation {
  return {
    body,
    context: { admin: true, principalKind: 'token', principalId: 'pairing:token-1', scopes },
    isAuthorized: authorized,
    nativeExecutionAuthority: { current: () => current, withCurrent: async (_expected, operation) => operation(() => current) },
  };
}

describe('native intake: a stored record that cannot be used', () => {
  function intake(fail: () => never) {
    const catalog = new GatewayMethodCatalog();
    registerNativeConversationIntakeGatewayMethods(catalog, {
      capture: async () => fail(), get: async () => fail(), admit: async () => fail(), resume: async () => fail(), cancel: async () => fail(),
    } as unknown as Pick<NativeConversationIntakeHost, 'capture' | 'get' | 'admit' | 'resume' | 'cancel'>);
    return catalog;
  }

  test('a record from a newer daemon says to upgrade, with its own code and a 409', async () => {
    const catalog = intake(() => { throw new NativeConversationStorageError('future-version'); });
    const error = await catalog.invoke('workLedger.intake.get', invocation({ inputId: 'input-1' }, () => true)).then(() => null, (caught: unknown) => caught) as { status: number; code: string; message: string };
    expect(error.status).toBe(409);
    expect(error.code).toBe('NATIVE_INTAKE_STORAGE_FUTURE_VERSION');
    expect(error.message).toContain('Upgrade the daemon');
    expect(error.message).not.toContain('retain the original input');
  });

  test('a conflicting record keeps the allowed moves the store named', async () => {
    const catalog = intake(() => { throw new NativeConversationMoveRefused('conflict', 'Only cancel or admit may follow here.'); });
    const error = await catalog.invoke('workLedger.intake.get', invocation({ inputId: 'input-1' }, () => true)).then(() => null, (caught: unknown) => caught) as { status: number; code: string; message: string };
    expect(error.status).toBe(409);
    expect(error.code).toBe('NATIVE_INTAKE_STORAGE_CONFLICT');
    expect(error.message).toContain('Only cancel or admit may follow here.');
  });

  test('an unreadable record is not blamed on the request and does not ask for a retry', async () => {
    const catalog = intake(() => { throw new NativeConversationStorageError('invalid'); });
    const error = await catalog.invoke('workLedger.intake.get', invocation({ inputId: 'input-1' }, () => true)).then(() => null, (caught: unknown) => caught) as { status: number; code: string; message: string };
    expect(error.status).toBe(500);
    expect(error.code).toBe('NATIVE_INTAKE_STORAGE_INVALID');
  });
});

describe('native submission', () => {
  const submitBody = { requestId: 'r1', inputId: 'i1', expectedRevision: 1, goal: 'Do the thing', criteria: ['It is done'] };

  test('access revoked after the submission was recorded says it was recorded, keeping the 403', async () => {
    let authorized = true;
    const catalog = new GatewayMethodCatalog();
    registerNativeWorkSubmissionGatewayMethods(catalog, {
      submit: async () => { authorized = false; return {} as never; },
      get: async () => ({}) as never,
    });
    const error = await catalog.invoke('workLedger.submit', invocation(submitBody, () => authorized)).then(() => null, (caught: unknown) => caught) as { status: number; code: string; message: string };
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toContain('The submission was recorded.');
  });

  test('a read whose access changed is a plain refusal, since nothing was recorded', async () => {
    let authorized = true;
    const catalog = new GatewayMethodCatalog();
    registerNativeWorkSubmissionGatewayMethods(catalog, {
      submit: async () => ({}) as never,
      get: async () => { authorized = false; return {} as never; },
    });
    const error = await catalog.invoke('workLedger.submission.get', invocation({ requestId: 'r1' }, () => authorized)).then(() => null, (caught: unknown) => caught) as { status: number; message: string };
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('was recorded');
  });

  test('a refusal from the submission host keeps the host\'s wording, not only its code', async () => {
    const catalog = new GatewayMethodCatalog();
    registerNativeWorkSubmissionGatewayMethods(catalog, {
      submit: async () => { throw new NativeWorkSubmissionError('stale'); },
      get: async () => { throw new NativeWorkSubmissionError('stale'); },
    });
    const error = await catalog.invoke('workLedger.submission.get', invocation({ requestId: 'r1' }, () => true)).then(() => null, (caught: unknown) => caught) as { status: number; code: string; message: string };
    expect(error.status).toBe(409);
    expect(error.code).toBe('NATIVE_SUBMISSION_STALE');
    expect(error.message).toBe(new NativeWorkSubmissionError('stale').message);
  });
});

describe('native execution', () => {
  const executionScopes = ['read:work-ledger', 'write:fleet'];
  const executionCurrent: NativePairedSnapshot = { ...current, scopes: executionScopes };
  const executionInvocation: GatewayMethodInvocation = {
    body: { projectId: 'p1', workId: 'w1', attemptId: 'a1', expectedRevision: { work: 1, criteria: 1, attempt: 1 } },
    context: { admin: true, principalKind: 'token', principalId: 'pairing:token-1', scopes: executionScopes },
    isAuthorized: () => true,
    nativeExecutionAuthority: { current: () => executionCurrent, withCurrent: async (_expected, operation) => operation(() => executionCurrent) },
  };

  test('a stale refusal from the host reaches the caller with its next step, a 409 and its own code', async () => {
    const catalog = new GatewayMethodCatalog();
    registerNativeWorkExecutionGatewayMethods(catalog, { projectId: 'p1', acquire: async () => { throw new NativeWorkExecutionError('stale'); } });
    const error = await catalog.invoke('workLedger.execution.status', executionInvocation).then(() => null, (caught: unknown) => caught) as { status: number; code: string; message: string };
    expect(error.status).toBe(409);
    expect(error.code).toBe('NATIVE_EXECUTION_STALE');
    expect(error.message).toContain('read the work again');
  });
});

describe('native execution status: a failed settlement', () => {
  const scopesWithFleet = ['read:work-ledger', 'write:fleet'];
  const paired: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'token-1', principalId: 'pairing:token-1', authorityId: 'pairing:token-1', authorityRevision: 'token-1', scopes: scopesWithFleet };
  const target = { workId: 'w1', workRevision: 1, criteriaRevision: 1, attemptId: 'a1', attemptRevision: 1 };

  async function statusOf(settlementFailure: string | undefined) {
    const catalog = new GatewayMethodCatalog();
    const execution = {
      statusByAttempt: () => ({
        kind: 'execution', execution: { projectId: 'p1', target, state: 'prepared', receipt: null },
        contract: null, currentTarget: target, currentAttempt: true, recovery: 'available',
        settlement: { state: 'failed' }, integration: { state: 'unavailable', reason: 'no-receipt' },
        ...(settlementFailure !== undefined ? { settlementFailure } : {}),
      }),
    };
    registerNativeWorkExecutionGatewayMethods(catalog, { projectId: 'p1', acquire: async () => execution as never });
    return catalog.invoke('workLedger.execution.status', {
      body: { projectId: 'p1', workId: 'w1', attemptId: 'a1', expectedRevision: { work: 1, criteria: 1, attempt: 1 } },
      context: { admin: true, principalKind: 'token', principalId: 'pairing:token-1', scopes: scopesWithFleet },
      isAuthorized: () => true,
      nativeExecutionAuthority: { current: () => paired, withCurrent: async (_expected, operation) => operation(() => paired) },
    }) as Promise<{ settlement?: { state: string; reason?: string } }>;
  }

  test('carries the fixed reason code to the caller', async () => {
    expect((await statusOf('artifact-too-large')).settlement).toEqual({ state: 'failed', reason: 'artifact-too-large' });
  });

  test('has no reason when the host recorded none', async () => {
    expect((await statusOf(undefined)).settlement).toEqual({ state: 'failed' });
  });
});
