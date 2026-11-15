import { expect, test } from 'bun:test';
import { executeAdmittedHeadlessTurn } from '../../cli/native-headless-turn.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import type { NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';

const noDelegation = {
  agents: {
    contractRunner: { list: () => [], get: () => undefined, on: () => () => {}, cancel() {}, async join() {} },
    agentManager: { list: () => [], getStatus: () => undefined, cancel() {}, async join() {} },
  },
};

for (const response of ['', '   ', 'Completed answer']) test(`headless exit reflects the delivered response ${JSON.stringify(response)}`, async () => {
  const handlers = new Map<string, (event: { source?: string; payload: unknown }) => void>();
  const ctx = { runtime: { sessionId: 'session', model: 'model', provider: 'provider' }, uiServices: noDelegation,
    runtimeBus: { on(name: string, cb: (event: { source?: string; payload: unknown }) => void) { handlers.set(name, cb); return () => handlers.delete(name); } },
    orchestrator: { abort() {}, bindNativeConversationProject() {}, async handleUserInput() {
      handlers.get('TURN_COMPLETED')?.({ payload: { response, stopReason: response.trim() ? 'completed' : 'empty_response' } });
    } },
  } as unknown as BootstrapContext;
  const state = { turnReady: true, turnPermit: {}, result: { kind: 'turn', projectId: 'project', text: 'request' } } as unknown as NativeConversationIntakeState;
  const result = await executeAdmittedHeadlessTurn(ctx, state, new AbortController().signal, 'json');
  expect(result.exitCode).toBe(response.trim() ? 0 : 1);
  expect(handlers.size).toBe(0);
});

test('--max-turns aborts the admitted turn and reports max_turns', async () => {
  const handlers = new Map<string, (event: { source?: string; payload: unknown }) => void>();
  let aborted = 0;
  const ctx = { runtime: { sessionId: 'session', model: 'model', provider: 'provider' }, uiServices: noDelegation,
    runtimeBus: { on(name: string, cb: (event: { source?: string; payload: unknown }) => void) { handlers.set(name, cb); return () => handlers.delete(name); } },
    orchestrator: { abort() { aborted++; }, bindNativeConversationProject() {}, async handleUserInput() {
      handlers.get('LLM_RESPONSE_RECEIVED')?.({ source: 'orchestrator', payload: { turnId: 't', provider: 'p', model: 'm', toolCallCount: 2, inputTokens: 1, outputTokens: 1 } });
      handlers.get('TURN_CANCEL')?.({ payload: { stopReason: 'cancelled' } });
    } },
  } as unknown as BootstrapContext;
  const state = { turnReady: true, turnPermit: {}, result: { kind: 'turn', projectId: 'project', text: 'request' } } as unknown as NativeConversationIntakeState;
  const result = await executeAdmittedHeadlessTurn(ctx, state, new AbortController().signal, 'json', { maxTurns: 1 });
  expect(aborted).toBe(1);
  expect(result).toMatchObject({ exitCode: 1, stopReason: 'max_turns' });
});

test('delegated work that fails turns a completed foreground turn into a failed run', async () => {
  const handlers = new Map<string, (event: { source?: string; payload: unknown }) => void>();
  const contract = { id: 'contract-1', status: 'failed', error: 'tests did not pass' };
  let delegated = false;
  const cancelled: string[] = [];
  const ctx = { runtime: { sessionId: 'session', model: 'model', provider: 'provider' },
    uiServices: { agents: {
      contractRunner: {
        list: () => (delegated ? [contract] : []),
        get: () => contract,
        on: () => () => {},
        cancel(id: string) { cancelled.push(id); },
        async join() {},
      },
      agentManager: { list: () => [], getStatus: () => undefined, cancel() {}, async join() {} },
    } },
    runtimeBus: { on(name: string, cb: (event: { source?: string; payload: unknown }) => void) { handlers.set(name, cb); return () => handlers.delete(name); } },
    orchestrator: { abort() {}, bindNativeConversationProject() {}, async handleUserInput() {
      delegated = true;
      handlers.get('TURN_COMPLETED')?.({ payload: { response: 'Delegated to a contract.', stopReason: 'completed' } });
    } },
  } as unknown as BootstrapContext;
  const state = { turnReady: true, turnPermit: {}, result: { kind: 'turn', projectId: 'project', text: 'request' } } as unknown as NativeConversationIntakeState;
  const result = await executeAdmittedHeadlessTurn(ctx, state, new AbortController().signal, 'json');
  expect(result).toMatchObject({ exitCode: 1, stopReason: 'contract-failed' });
  expect(cancelled).toEqual([]);
});
