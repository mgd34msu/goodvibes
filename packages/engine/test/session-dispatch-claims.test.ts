import { describe, expect, test } from 'bun:test';
import { createWireSessionDispatch } from '../platform/src/platform/runtime/client/session-dispatch.ts';
import type { SessionInputsWireClient, SurfaceAgentOutcome } from '../platform/src/platform/runtime/client/session-dispatch.ts';

const quiet = { debug: () => {}, info: () => {}, warn: () => {} };
// The dispatch owns its interval timer, so the tests wait for the outcome they
// need instead of a fixed wall-clock budget; the ceiling only bounds a hang.
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`never reached: ${what}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

interface Delivery { readonly sessionId: string; readonly inputId: string; readonly options: Parameters<SessionInputsWireClient['deliverInput']>[2] }

function flakyWire(options: { failDeliveries: number; failListFor?: string }) {
  const deliveries: Delivery[] = [];
  let remainingFailures = options.failDeliveries;
  const consumed = new Set<string>();
  const client: SessionInputsWireClient = {
    listInputs: async (sessionId) => {
      if (sessionId === options.failListFor) throw new Error('unknown session');
      return { inputs: [{ id: `${sessionId}-i1`, intent: 'submit', body: 'answer me' }].filter((input) => !consumed.has(input.id)) } as never;
    },
    deliverInput: async (sessionId, inputId, deliverOptions) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('daemon rejected deliver');
      }
      deliveries.push({ sessionId, inputId, options: deliverOptions });
      if (deliverOptions?.agentId !== undefined || deliverOptions?.consumed) consumed.add(inputId);
    },
  };
  return { client, deliveries };
}

describe('wire session dispatch claims', () => {
  test('a rejected acknowledgement retries only the acknowledgement, never the spawn', async () => {
    const wire = flakyWire({ failDeliveries: 3 });
    let spawns = 0;
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['s1'], intervalMs: 5, log: quiet });
    dispatch.setContinuationRunner(() => { spawns += 1; return { agentId: `agent-${spawns}` } as never; });
    dispatch.activate(wire.client);
    await until(() => wire.deliveries.length > 0, 'the acknowledgement is delivered after three rejections');
    dispatch.stop();
    expect(spawns).toBe(1);
    expect(wire.deliveries.map((delivery) => delivery.options?.agentId)).toEqual(['agent-1']);
  });

  test('a rejected answer report is retried, not lost', async () => {
    const wire = flakyWire({ failDeliveries: 0 });
    const outcome: SurfaceAgentOutcome = { status: 'completed', answer: 'done' };
    let failAnswer = 2;
    const original = wire.client.deliverInput;
    wire.client.deliverInput = async (sessionId, inputId, options) => {
      if (options?.answer !== undefined && failAnswer > 0) {
        failAnswer -= 1;
        throw new Error('daemon rejected answer');
      }
      return original(sessionId, inputId, options);
    };
    const dispatch = createWireSessionDispatch({
      hostedSessionIds: () => ['s1'],
      intervalMs: 5,
      log: quiet,
      readAgentOutcome: () => outcome,
    });
    dispatch.setContinuationRunner(() => ({ agentId: 'agent-1' }) as never);
    dispatch.activate(wire.client);
    await until(() => wire.deliveries.some((delivery) => delivery.options?.answer === 'done'), 'the answer is delivered after two rejections');
    dispatch.stop();
    expect(failAnswer).toBe(0);
    expect(wire.deliveries.filter((delivery) => delivery.options?.answer === 'done')).toHaveLength(1);
  });

  test('one session that cannot be listed does not starve the others', async () => {
    const wire = flakyWire({ failDeliveries: 0, failListFor: 'broken' });
    const ran: string[] = [];
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => ['broken', 's2'], intervalMs: 5, log: quiet });
    dispatch.setContinuationRunner(({ sessionId }) => { ran.push(sessionId); return { agentId: 'agent-1' } as never; });
    dispatch.activate(wire.client);
    await until(() => ran.length > 0, 'the healthy session is run');
    dispatch.stop();
    expect(ran).toEqual(['s2']);
  });
});
