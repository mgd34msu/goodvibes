/**
 * An acknowledgement the daemon applied but whose reply was lost, a stop/start
 * of the dispatcher, and an input the daemon keeps rejecting must neither start
 * a second agent, lose the answer, nor block the inputs behind them.
 */
import { expect, test } from 'bun:test';
import { createWireSessionDispatch } from '../platform/src/platform/runtime/client/session-dispatch.ts';
import type { SessionInputsWireClient } from '../platform/src/platform/runtime/client/session-dispatch.ts';

const quiet = { debug: () => {}, info: () => {}, warn: () => {} };

type Deliver = Parameters<SessionInputsWireClient['deliverInput']>;

function daemon(inputIds: readonly string[], onDeliver: (inputId: string, options: Deliver[2]) => 'ok' | 'lost-reply' | 'reject') {
  const consumed = new Set<string>();
  const delivered: Array<{ inputId: string; options: Deliver[2] }> = [];
  const client: SessionInputsWireClient = {
    listInputs: async () => ({
      inputs: inputIds.filter((id) => !consumed.has(id)).map((id) => ({ id, intent: 'submit', body: `body ${id}` })),
    }) as never,
    deliverInput: async (_sessionId, inputId, options) => {
      const outcome = onDeliver(inputId, options);
      if (outcome === 'reject') throw new Error('daemon rejected deliver');
      delivered.push({ inputId, options });
      if (options?.agentId !== undefined || options?.consumed) consumed.add(inputId);
      if (outcome === 'lost-reply') throw new Error('connection reset after the daemon applied it');
    },
  };
  return { client, delivered };
}

test('an acknowledgement whose reply was lost still ends in the answer reaching the sender', async () => {
  let lose = true;
  const wire = daemon(['i1'], (_inputId, options) => {
    if (lose && options?.answer === undefined) { lose = false; return 'lost-reply'; }
    return 'ok';
  });
  let spawns = 0;
  const dispatch = createWireSessionDispatch({
    hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000,
    readAgentOutcome: () => ({ status: 'completed', answer: 'done' }),
  });
  dispatch.setContinuationRunner(() => { spawns += 1; return { agentId: 'agent-1' } as never; });
  dispatch.activate(wire.client);
  await dispatch.pollNow();
  await dispatch.pollNow();
  dispatch.stop();
  expect(spawns).toBe(1);
  expect(wire.delivered.filter((entry) => entry.options?.answer === 'done')).toHaveLength(1);
});

test('stopping and activating again does not start an unacknowledged input a second time', async () => {
  let reject = true;
  const wire = daemon(['i1'], () => (reject ? 'reject' : 'ok'));
  let spawns = 0;
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000 });
  dispatch.setContinuationRunner(() => { spawns += 1; return { agentId: 'agent-1' } as never; });
  dispatch.activate(wire.client);
  await dispatch.pollNow();
  dispatch.stop();
  reject = false;
  dispatch.activate(wire.client);
  await dispatch.pollNow();
  dispatch.stop();
  expect(spawns).toBe(1);
  expect(wire.delivered.map((entry) => entry.inputId)).toEqual(['i1']);
});

test('one input the daemon keeps rejecting does not block the ones behind it', async () => {
  const wire = daemon(['i1', 'i2'], (inputId) => (inputId === 'i1' ? 'reject' : 'ok'));
  const ran: string[] = [];
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000 });
  dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: `agent-${task}` } as never; });
  dispatch.activate(wire.client);
  await dispatch.pollNow();
  // The first poll started i1, failed to acknowledge it, and still went on to i2.
  expect(ran).toEqual(['body i1', 'body i2']);
  await dispatch.pollNow();
  dispatch.stop();
  // Re-acknowledging i1 failed again; i2 was already acknowledged and is not run again.
  expect(ran).toEqual(['body i1', 'body i2']);
  expect(wire.delivered.map((entry) => entry.inputId)).toEqual(['i2']);
});

test('an input that appears while an earlier one keeps failing its re-acknowledgement is still dispatched', async () => {
  let poll = 0;
  const consumed = new Set<string>();
  const delivered: string[] = [];
  const client: SessionInputsWireClient = {
    listInputs: async () => {
      const ids = poll === 0 ? ['i1'] : ['i1', 'i2'];
      return { inputs: ids.filter((id) => !consumed.has(id)).map((id) => ({ id, intent: 'submit', body: `body ${id}` })) } as never;
    },
    deliverInput: async (_sessionId, inputId) => {
      if (inputId === 'i1') throw new Error('daemon rejected deliver');
      delivered.push(inputId);
      consumed.add(inputId);
    },
  };
  const ran: string[] = [];
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000 });
  dispatch.setContinuationRunner(({ task }) => { ran.push(task); return { agentId: `agent-${task}` } as never; });
  dispatch.activate(client);
  await dispatch.pollNow();
  expect(ran).toEqual(['body i1']);
  poll = 1;
  await dispatch.pollNow();
  dispatch.stop();
  // i1 is re-acknowledged (and rejected) without a second run; i2 is not blocked behind it.
  expect(ran).toEqual(['body i1', 'body i2']);
  expect(delivered).toEqual(['i2']);
});

test('a failed list of claimed inputs does not forget a claim whose acknowledgement is still owed', async () => {
  let clock = 0;
  let rejectAck = true;
  let listDeliveredFails = false;
  const claimed = new Set<string>();
  const consumed = new Set<string>();
  const client: SessionInputsWireClient = {
    listInputs: async (_sessionId, options) => {
      if (options?.state === 'delivered') {
        if (listDeliveredFails) throw new Error('list unavailable');
        return { inputs: claimed.has('i1') && !consumed.has('i1') ? [{ id: 'i1', intent: 'submit', body: 'body i1', updatedAt: 0 }] : [] } as never;
      }
      return { inputs: claimed.has('i1') ? [] : [{ id: 'i1', intent: 'submit', body: 'body i1' }] } as never;
    },
    claimInput: async (_sessionId, inputId) => { claimed.add(inputId); },
    deliverInput: async (_sessionId, inputId) => {
      if (rejectAck) throw new Error('daemon rejected deliver');
      consumed.add(inputId);
    },
  };
  let spawns = 0;
  const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], log: quiet, intervalMs: 3_600_000, now: () => clock });
  dispatch.setContinuationRunner(() => { spawns += 1; return { agentId: 'agent-1' } as never; });
  dispatch.activate(client);
  await dispatch.pollNow();
  listDeliveredFails = true;
  await dispatch.pollNow();
  // Long enough that another surface's claim would have lapsed.
  clock = 10 * 60_000;
  listDeliveredFails = false;
  rejectAck = false;
  await dispatch.pollNow();
  dispatch.stop();
  expect(spawns).toBe(1);
  expect(consumed.has('i1')).toBe(true);
});
