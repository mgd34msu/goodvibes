/**
 * A permission ask raised on the daemon and answered somewhere else must arrive
 * here with everything the answer carried, and an ask this surface walks away
 * from must not stay "Approval required" on every other surface.
 */
import { expect, test } from 'bun:test';
import { createClientApprovalRaiser } from '../platform/src/platform/runtime/client/approval-raiser.ts';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from '../platform/src/platform/runtime/client/approval-updates.ts';
import type { PermissionExecutionOptions, PermissionPromptDecision, PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.ts';

const REQUEST: PermissionPromptRequest = {
  callId: 'call-1', tool: 'edit', args: { edits: [{ path: 'a.ts', find: 'a', replace: 'b' }, { path: 'b.ts', find: 'c', replace: 'd' }] },
  category: 'write', analysis: { classification: 'file-write', riskLevel: 'medium', summary: 'edit two files', reasons: [] },
};

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('did not settle'); await turn(); }
}

function wire(coalesced?: boolean) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    caller: {
      probe: () => ({ available: true as const }),
      async invoke<T>(method: string, input?: unknown): Promise<T> {
        calls.push({ method, input });
        if (method === 'approvals.raise') {
          return { approval: { id: 'approval-1' }, holdId: 'hold-1', ...(coalesced === undefined ? {} : { coalesced }) } as T;
        }
        if (method === 'approvals.list') return [] as T;
        return {} as T;
      },
    },
  };
}

function streamed() {
  let push: ((notice: ApprovalUpdateNotice) => void) | null = null;
  const subscribe = async (onUpdate: (notice: ApprovalUpdateNotice) => void): Promise<ApprovalUpdateSubscription> => {
    push = onUpdate;
    return { close: () => {} };
  };
  return { subscribe, push: (notice: ApprovalUpdateNotice) => push!(notice), ready: () => push !== null };
}

test('a partial approval made on another surface arrives with its modified arguments', async () => {
  const { caller } = wire(false);
  const stream = streamed();
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', localPrompt: () => () => new Promise<never>(() => {}), subscribeApprovalUpdates: stream.subscribe });
  const pending = raise({ request: REQUEST });
  await until(stream.ready); await turn();
  const subset = { edits: [{ path: 'a.ts', find: 'a', replace: 'b' }] };
  const decision = { approved: true, remember: false, modifiedArgs: subset, rememberTier: 'tool', disposition: 'approved' };
  stream.push({ approval: { id: 'approval-1', status: 'approved', decision }, createdAt: 1 });
  expect(await pending).toEqual({ approved: true, remember: false, rememberTier: 'tool', modifiedArgs: subset });
});

test('a denial made on another surface carries its reason to the model', async () => {
  const { caller } = wire(false);
  const stream = streamed();
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', localPrompt: () => () => new Promise<never>(() => {}), subscribeApprovalUpdates: stream.subscribe });
  const pending = raise({ request: REQUEST });
  await until(stream.ready); await turn();
  const decision = { approved: false, reason: 'use the other file' };
  stream.push({ approval: { id: 'approval-1', status: 'denied', decision }, createdAt: 1 });
  expect(await pending).toEqual({ approved: false, remember: false, reason: 'use the other file' });
});

test('a remote decision clears the local prompt instead of leaving it waiting for a key', async () => {
  const { caller } = wire(false);
  const stream = streamed();
  let promptSignal: AbortSignal | undefined;
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', subscribeApprovalUpdates: stream.subscribe,
    localPrompt: () => (_request: PermissionPromptRequest, options?: PermissionExecutionOptions) => {
      promptSignal = options?.signal;
      return new Promise<PermissionPromptDecision>(() => {});
    } });
  const pending = raise({ request: REQUEST });
  await until(stream.ready); await turn();
  expect(promptSignal?.aborted).toBe(false);
  stream.push({ approval: { id: 'approval-1', status: 'approved', decision: { approved: true } }, createdAt: 1 });
  await pending;
  expect(promptSignal?.aborted).toBe(true);
});

test('every raise carries a deadline so an abandoned record expires', async () => {
  const { caller, calls } = wire(false);
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', localPrompt: () => async () => ({ approved: true }) });
  await raise({ request: REQUEST });
  const raised = calls.find((call) => call.method === 'approvals.raise')!.input as { timeoutMs?: number };
  expect(raised.timeoutMs).toBe(12 * 60 * 60 * 1000);
});

test('a caller that created the record and leaves without a decision cancels it', async () => {
  const { caller, calls } = wire(false);
  const controller = new AbortController();
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', localPrompt: () => () => new Promise<never>(() => {}), pollIntervalMs: 60_000 });
  const pending = raise({ request: REQUEST, signal: controller.signal }).then(() => null, (error: unknown) => error);
  await until(() => calls.some((call) => call.method === 'approvals.raise')); await turn();
  controller.abort();
  expect(await pending).toMatchObject({ kind: 'aborted' });
  await until(() => calls.some((call) => call.method === 'approvals.cancel'));
  expect(calls.find((call) => call.method === 'approvals.cancel')!.input).toMatchObject({ approvalId: 'approval-1', release: true, holdId: 'hold-1' });
});

test('a caller that joined an identical earlier ask releases it instead of denying the surfaces still waiting', async () => {
  const { caller, calls } = wire(true);
  const controller = new AbortController();
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', localPrompt: () => () => new Promise<never>(() => {}), pollIntervalMs: 60_000 });
  const pending = raise({ request: REQUEST, signal: controller.signal }).then(() => null, (error: unknown) => error);
  await until(() => calls.some((call) => call.method === 'approvals.raise')); await turn();
  controller.abort();
  await pending;
  await until(() => calls.some((call) => call.method === 'approvals.cancel'));
  expect(calls.find((call) => call.method === 'approvals.cancel')!.input).toMatchObject({ approvalId: 'approval-1', release: true });
});

test('a card answered and then aborted in the same keystroke does not leave the record pending', async () => {
  const { caller, calls } = wire(false);
  const controller = new AbortController();
  // The terminal resolves the card and aborts the turn synchronously (Ctrl+C on a card).
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', pollIntervalMs: 60_000,
    localPrompt: () => () => { const answered = Promise.resolve({ approved: false }); controller.abort(); return answered; } });
  const result = await raise({ request: REQUEST, signal: controller.signal }).then(() => null, (error: unknown) => error);
  expect(result).toMatchObject({ kind: 'aborted' });
  await until(() => calls.some((call) => call.method === 'approvals.cancel' || call.method === 'approvals.deny'));
});

test('an approval whose typed answer the daemon withheld is declined, not typed into the program as the placeholder', async () => {
  const { caller } = wire(false);
  const stream = streamed();
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'test', localPrompt: () => () => new Promise<never>(() => {}), subscribeApprovalUpdates: stream.subscribe });
  const pending = raise({ request: REQUEST });
  await until(stream.ready); await turn();
  const decision = { approved: true, remember: false, modifiedArgs: { answer: '[answer withheld]' }, disposition: 'approved' };
  stream.push({ approval: { id: 'approval-1', status: 'approved', decision }, createdAt: 1 });
  const result = await pending;
  expect(result.approved).toBe(false);
  expect(result.modifiedArgs).toBeUndefined();
  expect(result.reason).toContain('another surface');
});
