/**
 * The agent side of ACP while a prompt is being submitted: a turn that ends
 * before `submit` returns, a cancel that arrives during it, overlapping prompts,
 * a failed turn's text, and a client connection that rejects notifications.
 * The substrate is a fake EmbeddedSession around a real RuntimeEventBus.
 */
import { describe, expect, test } from 'bun:test';
import { GoodVibesAcpAgent, turnFailureText } from '../platform/src/platform/acp/agent.ts';
import type { EmbeddedSession } from '../platform/src/platform/embed/session.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createEventEnvelope } from '../platform/src/platform/runtime/event-envelope.ts';
import type { SharedSessionSubmission } from '../platform/src/platform/control-plane/session-types.ts';
import type { TurnEvent } from '../platform/src/events/turn.ts';

const RUNTIME_SESSION = 'runtime-session';

function substrate(options: { onSubmit?: (bus: RuntimeEventBus) => Promise<void> } = {}) {
  const bus = new RuntimeEventBus();
  const cancelledAgents: string[] = [];
  const cancelledInputs: string[] = [];
  const emitTurn = (event: TurnEvent): void => {
    bus.emit('turn', createEventEnvelope(event.type, event, { sessionId: RUNTIME_SESSION, source: 'test' }));
  };
  const fake: Partial<EmbeddedSession> = {
    workspace: '/w',
    url: 'http://127.0.0.1:0',
    events: bus,
    submit: async () => {
      await options.onSubmit?.(bus);
      return { session: { id: RUNTIME_SESSION }, input: { id: 'input-1' }, activeAgentId: 'agent-1', mode: 'spawn', created: true } as unknown as SharedSessionSubmission;
    },
    cancelActive: (ids) => {
      let count = 0;
      for (const id of ids) if (id === 'agent-1') { cancelledAgents.push(id); count += 1; }
      return count;
    },
    sessions: {
      cancelInput: async (sessionId: string, inputId: string) => { cancelledInputs.push(`${sessionId}:${inputId}`); return null; },
    } as unknown as EmbeddedSession['sessions'],
    stop: async () => {},
  };
  return { bus, emitTurn, cancelledAgents, cancelledInputs, factory: async () => fake as EmbeddedSession };
}

function client(sessionUpdate?: (params: unknown) => Promise<void>) {
  const updates: Array<{ update: { sessionUpdate: string; content?: { text?: string } } }> = [];
  return {
    updates,
    conn: {
      sessionUpdate: sessionUpdate ?? (async (params: unknown) => { updates.push(params as (typeof updates)[number]); }),
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    } as unknown as ConstructorParameters<typeof GoodVibesAcpAgent>[0],
  };
}

async function openSession(sub: ReturnType<typeof substrate>, conn: ConstructorParameters<typeof GoodVibesAcpAgent>[0]) {
  const agent = new GoodVibesAcpAgent(conn, { sessionFactory: sub.factory });
  const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
  return { agent, sessionId };
}

const prompt = (sessionId: string) => ({ sessionId, prompt: [{ type: 'text' as const, text: 'go' }] });

describe('a turn that ends while submit is still resolving', () => {
  test('the prompt resolves instead of waiting forever, and the editor is told why it failed', async () => {
    const sub = substrate({
      onSubmit: async (bus) => {
        bus.emit('turn', createEventEnvelope('TURN_ERROR', { type: 'TURN_ERROR', turnId: 't', error: 'no provider key configured', stopReason: 'provider_error' } as TurnEvent, { sessionId: RUNTIME_SESSION, source: 'test' }));
        await Promise.resolve();
      },
    });
    const c = client();
    const { agent, sessionId } = await openSession(sub, c.conn);
    const result = await agent.prompt(prompt(sessionId));
    expect(result.stopReason).toBe('refusal');
    const texts = c.updates.map((u) => u.update.content?.text ?? '');
    expect(texts.some((t) => t.includes('no provider key configured') && t.includes('provider_error'))).toBe(true);
  });

  test('a failed turn text names the stop reason and the error', () => {
    expect(turnFailureText({ type: 'TURN_ERROR', turnId: 't', error: 'boom', stopReason: 'provider_error' } as TurnEvent)).toBe('Turn failed (provider_error): boom');
    expect(turnFailureText({ type: 'TURN_COMPLETED', turnId: 't', response: 'r', stopReason: 'completed' } as TurnEvent)).toBeNull();
  });
});

describe('session/cancel during submit', () => {
  test('is applied once the submission names the agent, and the prompt ends as cancelled', async () => {
    let releaseSubmit!: () => void;
    const submitting = new Promise<void>((resolve) => { releaseSubmit = resolve; });
    const sub = substrate({ onSubmit: () => submitting });
    const { agent, sessionId } = await openSession(sub, client().conn);
    const pending = agent.prompt(prompt(sessionId));
    await agent.cancel({ sessionId });
    // Nothing was running yet to abort.
    expect(sub.cancelledAgents).toEqual([]);
    releaseSubmit();
    const result = await pending;
    expect(result.stopReason).toBe('cancelled');
    expect(sub.cancelledAgents).toEqual(['agent-1']);
    expect(sub.cancelledInputs).toEqual([`${RUNTIME_SESSION}:input-1`]);
  });
});

describe('overlapping prompts', () => {
  test('a second prompt on a busy session is refused and the first still completes', async () => {
    let releaseSubmit!: () => void;
    const submitting = new Promise<void>((resolve) => { releaseSubmit = resolve; });
    const sub = substrate({ onSubmit: () => submitting });
    const { agent, sessionId } = await openSession(sub, client().conn);
    const first = agent.prompt(prompt(sessionId));
    await expect(agent.prompt(prompt(sessionId))).rejects.toThrow('already has a prompt running');
    releaseSubmit();
    await Promise.resolve();
    sub.emitTurn({ type: 'TURN_COMPLETED', turnId: 't', response: 'done', stopReason: 'completed' } as TurnEvent);
    expect((await first).stopReason).toBe('end_turn');
    // The session accepts a new prompt once the first has ended.
    const next = agent.prompt(prompt(sessionId));
    await Promise.resolve();
    await Promise.resolve();
    sub.emitTurn({ type: 'TURN_COMPLETED', turnId: 't2', response: 'done', stopReason: 'completed' } as TurnEvent);
    expect((await next).stopReason).toBe('end_turn');
  });
});

describe('a client connection that rejects session updates', () => {
  test('does not produce an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const sub = substrate();
      const { agent, sessionId } = await openSession(sub, client(async () => { throw new Error('connection closed'); }).conn);
      const pending = agent.prompt(prompt(sessionId));
      await new Promise((resolve) => setImmediate(resolve));
      sub.emitTurn({ type: 'STREAM_DELTA', turnId: 't', content: 'hello', accumulated: 'hello' } as TurnEvent);
      sub.emitTurn({ type: 'TURN_COMPLETED', turnId: 't', response: 'hello', stopReason: 'completed' } as TurnEvent);
      expect((await pending).stopReason).toBe('end_turn');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
