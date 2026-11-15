/**
 * Every queued session input ends somewhere a person can see, and a report or
 * claim on the wrong row changes nothing. A row left queued with nobody to run
 * it keeps the daemon "busy" forever (no update swap, no consolidation, no idle
 * reap) and leaves the web polling a dispatch that never resolves.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY } from '../platform/src/platform/control-plane/session-intents.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-session-settle-'));
  dirs.push(dir);
  return join(dir, 'sessions.json');
}

function makeBroker(path = storePath()) {
  const running = new Set<string>();
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const broker = disposables.add(new SharedSessionBroker({
    storePath: path,
    routeBindings: { start: async () => {}, getBinding: () => null, resolve: () => null, patchBinding: async () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: (id) => (running.has(id) ? { id, status: 'running' } : null) },
    messageSender: { send: () => false },
  }));
  broker.setEventPublisher((_channel, payload) => { events.push(payload as { event: string; payload: Record<string, unknown> }); });
  return { broker, running, events, path };
}

const message = (sessionId: string, body: string) => ({ sessionId, surfaceKind: 'web' as const, surfaceId: 'surface:web', body });
const pending = (broker: SharedSessionBroker, sessionId: string) => broker.getSession(sessionId)?.pendingInputCount;
const stateOf = (broker: SharedSessionBroker, sessionId: string, inputId: string) => broker.getInputs(sessionId).find((entry) => entry.id === inputId)?.state;

/** A session with agent-1 running on its first input and one follow-up queued behind it. */
async function withQueuedFollowUp() {
  const fixture = makeBroker();
  const { broker, running } = fixture;
  await broker.createSession({ id: 's1' });
  const first = await broker.submitMessage(message('s1', 'first'));
  running.add('agent-1');
  await broker.bindAgent('s1', 'agent-1', first.input.id);
  const followUp = await broker.followUpMessage(message('s1', 'and then this'));
  expect(followUp.mode).toBe('queued-follow-up');
  return { ...fixture, first, followUp };
}

describe('a queued input never outlives everything that could run it', () => {
  test('a follow-up the runner holds is failed with the reason instead of staying queued', async () => {
    const { broker, running, followUp } = await withQueuedFollowUp();
    broker.setContinuationRunner(() => ({ disposition: 'held', reason: 'work-proposal-unavailable' }));
    running.delete('agent-1');
    await broker.completeAgent('s1', 'agent-1', 'done', { status: 'completed' });
    expect(stateOf(broker, 's1', followUp.input.id)).toBe('failed');
    expect(broker.getInputs('s1').find((entry) => entry.id === followUp.input.id)?.error).toContain('work-proposal-unavailable');
    expect(pending(broker, 's1')).toBe(0);
  });

  test('closing a session cancels what was queued in it and starts nothing afterwards', async () => {
    const { broker, running, followUp } = await withQueuedFollowUp();
    let runs = 0;
    broker.setContinuationRunner(() => { runs += 1; return { agentId: 'agent-2' }; });
    await broker.closeSession('s1');
    expect(stateOf(broker, 's1', followUp.input.id)).toBe('cancelled');
    running.delete('agent-1');
    await broker.completeAgent('s1', 'agent-1', 'done', { status: 'completed' });
    expect(runs).toBe(0);
    expect(broker.getSession('s1')?.activeAgentId).toBeUndefined();
    expect(pending(broker, 's1')).toBe(0);
  });

  test('a restart cancels a queued delegated row whose binding died, and keeps ordinary queued rows', async () => {
    const path = storePath();
    const now = Date.now();
    const row = (id: string, metadata: Record<string, unknown>) => ({ id, sessionId: 's1', intent: 'submit', state: 'queued',
      correlationId: `session-input:${id}`, body: 'held', createdAt: now, updatedAt: now, metadata });
    writeFileSync(path, JSON.stringify({ sessions: [{ id: 's1', title: 's1', status: 'active', createdAt: now, updatedAt: now, lastActivityAt: now,
      messageCount: 0, pendingInputCount: 2, routeIds: [], surfaceKinds: [], participants: [], metadata: {} }], messages: [],
    inputs: [row('sin-delegated', { [SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY]: true }), row('sin-ordinary', {})] }));
    const { broker } = makeBroker(path);
    await broker.start();
    expect(stateOf(broker, 's1', 'sin-delegated')).toBe('cancelled');
    expect(stateOf(broker, 's1', 'sin-ordinary')).toBe('queued');
    expect(pending(broker, 's1')).toBe(1);
  });
});

describe('claims and reports land on the row they name', () => {
  test('binding an agent to a named input leaves an older queued input alone', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 's1' });
    const older = await broker.submitMessage(message('s1', 'left over'));
    const mine = await broker.submitMessage(message('s1', 'this one'));
    await broker.bindAgent('s1', 'agent-7', mine.input.id);
    expect(stateOf(broker, 's1', older.input.id)).toBe('queued');
    expect(stateOf(broker, 's1', mine.input.id)).toBe('spawned');
  });

  test('cancelling an input that is already being answered publishes no cancel', async () => {
    const { broker, events } = makeBroker();
    await broker.createSession({ id: 's1' });
    const submitted = await broker.submitMessage(message('s1', 'go'));
    await broker.bindAgent('s1', 'agent-1', submitted.input.id);
    events.length = 0;
    const result = await broker.cancelInput('s1', submitted.input.id);
    expect(result?.state).toBe('spawned');
    expect(events.some((entry) => entry.event === 'session-input-cancelled')).toBe(false);
  });

  test('a surface report on a cancelled input binds no agent and announces nothing', async () => {
    const { broker, events } = makeBroker();
    const announced: unknown[] = [];
    broker.setSurfaceReplyBinder((binding) => { announced.push(binding); });
    await broker.createSession({ id: 's1' });
    const submitted = await broker.submitMessage({ ...message('s1', 'steer'), surfaceKind: 'telegram' as const });
    await broker.cancelInput('s1', submitted.input.id);
    events.length = 0;
    const result = await broker.markInputDelivered('s1', submitted.input.id, { consumed: true, agentId: 'surface-agent' });
    expect(result?.state).toBe('cancelled');
    expect(events.some((entry) => entry.event === 'session-agent-bound')).toBe(false);
    expect(announced).toEqual([]);
    expect(broker.getSession('s1')?.activeAgentId).toBeUndefined();
  });

  test('an answer reported after a restart cancelled its delivered row completes that row', async () => {
    const first = makeBroker();
    await first.broker.createSession({ id: 's1' });
    const submitted = await first.broker.submitMessage(message('s1', 'answer me'));
    await first.broker.markInputDelivered('s1', submitted.input.id, { consumed: false });
    const restarted = makeBroker(first.path);
    await restarted.broker.start();
    expect(stateOf(restarted.broker, 's1', submitted.input.id)).toBe('cancelled');
    const result = await restarted.broker.markInputDelivered('s1', submitted.input.id, { consumed: true });
    expect(result?.state).toBe('completed');
  });
});

describe('session status reads current', () => {
  test('a successful run clears the previous run\'s error', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 's1' });
    await broker.completeAgent('s1', 'agent-1', 'it broke', { status: 'failed' });
    expect(broker.getSession('s1')?.lastError).toBe('it broke');
    await broker.completeAgent('s1', 'agent-2', 'all good', { status: 'completed' });
    expect(broker.getSession('s1')?.lastError).toBeUndefined();
  });
});
