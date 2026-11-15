/**
 * What this surface decided must reach the daemon's record whole, and an
 * approval stream that dies must not leave an ask waiting on a decision that was
 * already made elsewhere.
 */
import { expect, test } from 'bun:test';
import { createClientApprovalRaiser } from '../platform/src/platform/runtime/client/approval-raiser.ts';
import { awaitApprovalDecision } from '../platform/src/platform/runtime/client/approval-updates.ts';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from '../platform/src/platform/runtime/client/approval-updates.ts';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';

const REQUEST: PermissionPromptRequest = {
  callId: 'call-1', tool: 'edit', args: { edits: [] },
  category: 'write', analysis: { classification: 'file-write', riskLevel: 'medium', summary: 'edit', reasons: [] },
};

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i += 1) await turn();
  if (!predicate()) throw new Error('did not settle');
}

function wire(listed: () => unknown = () => []) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    caller: {
      probe: () => ({ available: true as const }),
      async invoke<T>(method: string, input?: unknown): Promise<T> {
        calls.push({ method, input });
        if (method === 'approvals.raise') return { approval: { id: 'approval-1' }, coalesced: false } as T;
        if (method === 'approvals.list') return listed() as T;
        return {} as T;
      },
    },
  };
}

test('an approval with changed arguments and a deny with a reason are written back with them', async () => {
  for (const decision of [
    { approved: true, remember: true, rememberTier: 'path' as const, modifiedArgs: { a: 1 } },
    { approved: false, reason: 'use the other file' },
  ]) {
    const { caller, calls } = wire();
    const raise = createClientApprovalRaiser({ verbs: caller, actor: 'tui', localPrompt: () => async () => decision });
    await raise({ request: REQUEST });
    const method = decision.approved ? 'approvals.approve' : 'approvals.deny';
    await until(() => calls.some((call) => call.method === method));
    const sent = calls.find((call) => call.method === method)!.input as Record<string, unknown>;
    if (decision.approved) {
      expect(sent).toMatchObject({ approvalId: 'approval-1', remember: true, modifiedArgs: { a: 1 } });
      // The tier stays with this surface's own rule store.
      expect(sent).not.toHaveProperty('rememberTier');
    } else {
      expect(sent).toMatchObject({ approvalId: 'approval-1', reason: 'use the other file' });
      expect(sent).not.toHaveProperty('modifiedArgs');
    }
    // Identity comes from the daemon's session, never from a claim in the body.
    expect(sent).not.toHaveProperty('actor');
    expect(sent).not.toHaveProperty('actorSurface');
  }
});

test('a stream that ends after opening falls back to reading the record', async () => {
  let reads = 0;
  const { caller } = wire(() => {
    reads += 1;
    return reads >= 2 ? [{ id: 'approval-1', status: 'approved', decision: { approved: true } }] : [{ id: 'approval-1', status: 'pending' }];
  });
  let terminate: (() => void) | null = null;
  const subscribeApprovalUpdates = async (_onUpdate: (notice: ApprovalUpdateNotice) => void, onTerminate?: () => void): Promise<ApprovalUpdateSubscription> => {
    terminate = onTerminate ?? null;
    return { close: () => {} };
  };
  const raise = createClientApprovalRaiser({
    verbs: caller, actor: 'tui', subscribeApprovalUpdates, sleep: async () => {},
    localPrompt: () => () => new Promise<never>(() => {}),
  });
  const pending = raise({ request: REQUEST });
  await until(() => terminate !== null && reads >= 1);
  terminate!();
  expect(await pending).toEqual({ approved: true, remember: false });
});

test('a stream that dies silently is cross-checked against the record', async () => {
  let answered = false;
  const { caller } = wire(() => (answered ? [{ id: 'approval-1', status: 'denied', decision: { approved: false } }] : []));
  let release: (() => void) | null = null;
  let sleeps = 0;
  const raise = createClientApprovalRaiser({
    verbs: caller, actor: 'tui', pollIntervalMs: 1,
    subscribeApprovalUpdates: async () => ({ close: () => {} }),
    // The first sleep is the reconcile wait; the test decides when it elapses.
    sleep: () => { sleeps += 1; return new Promise<void>((resolve) => { release = resolve; }); },
    localPrompt: () => () => new Promise<never>(() => {}),
  });
  const pending = raise({ request: REQUEST });
  await until(() => release !== null);
  expect(sleeps).toBe(1);
  answered = true;
  release!();
  expect(await pending).toEqual({ approved: false, remember: false });
});

test('awaitApprovalDecision resolves null when the stream ends without a decision', async () => {
  const result = await awaitApprovalDecision({
    subscribe: async (_onUpdate, onTerminate) => { queueMicrotask(() => onTerminate?.()); return { close: () => {} }; },
    approvalId: 'approval-1', isDecided: () => true, stop: () => false,
  });
  expect(result).toBeNull();
});

test('the daemon decides when another surface answered first, and an expired ask says so', async () => {
  for (const [record, expected] of [
    [{ id: 'approval-1', status: 'denied', decision: { approved: false, reason: 'denied on the phone' } }, { approved: false, reason: 'denied on the phone' }],
    [{ id: 'approval-1', status: 'expired' }, { approved: false }],
  ] as const) {
    const raised = Promise.withResolvers<void>();
    const raise = createClientApprovalRaiser({
      actor: 'tui',
      verbs: {
        probe: () => ({ available: true as const }),
        async invoke<T>(method: string): Promise<T> {
          if (method === 'approvals.raise') { raised.resolve(); return { approval: { id: 'approval-1' }, coalesced: false } as T; }
          if (method === 'approvals.approve') return { approval: record } as T;
          return [] as T;
        },
      },
      // The person answers after the raise landed, but after another surface did.
      localPrompt: () => async () => { await raised.promise; await turn(); return { approved: true, remember: false }; },
    });
    const decision = await raise({ request: REQUEST });
    expect(decision).toMatchObject(expected);
    if (record.status === 'expired') expect(decision.reason).toContain('expired');
  }
});
