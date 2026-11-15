/**
 * Which session input an agent answers, and what a second message does while
 * the first one's agent is still being started. Real session broker and real
 * conversation gate; the agent manager and the judgment reading are stubs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { WorkProposalStore } from '../platform/src/platform/agents/work-proposal-store.ts';
import {
  gateSurfaceSpawn,
  settleUnstartedWork,
  startAgreedWork,
  type ConversationGateDeps,
} from '../platform/src/platform/daemon/surface-conversation-gate.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const dirs: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
let reading: 'work' | 'conversation';
beforeEach(() => {
  reading = 'work';
  const fake = fakePort((_name, question) => choiceAnswer(question, question.type === 'choice' && 'other' in question.criteria ? 'other' : reading, 0.99));
  previous = installJudgmentPort(fake.port);
});
afterEach(() => { installJudgmentPort(previous); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-spawn-owner-'));
  dirs.push(dir);
  const running = new Set<string>();
  const broker = disposables.add(new SharedSessionBroker({
    storePath: join(dir, 'sessions.json'),
    routeBindings: { start: async () => {}, getBinding: () => null, resolve: () => null, patchBinding: async () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: (id) => (running.has(id) ? { id, status: 'running' } : null) },
    messageSender: { send: () => false },
  }));
  const store = new WorkProposalStore();
  const spawned: string[] = [];
  let spawnResult: () => { id: string } | Response = () => ({ id: 'agent-1' });
  const deps: ConversationGateDeps = {
    configManager: { get: () => undefined },
    routeBindings: { getBinding: () => undefined, resolve: () => undefined },
    sessionBroker: broker,
    trySpawnAgent: (input) => { spawned.push(String(input.task)); return spawnResult() as never; },
    queueSurfaceReplyFromBinding: () => {},
    workProposals: store,
    deliverSurfaceNotice: async () => ({ delivered: true }),
  };
  const submit = (body: string) => broker.submitMessage({ sessionId: 's1', surfaceKind: 'ntfy', surfaceId: 'surface:ntfy', body });
  const stateOf = (id: string) => broker.getInputs('s1').find((entry) => entry.id === id)?.state;
  return { broker, store, deps, running, spawned, submit, stateOf, setSpawn: (fn: typeof spawnResult) => { spawnResult = fn; }, dispose: () => store.dispose() };
}

describe('a held message is settled by its own row', () => {
  test('agreeing to a later proposal starts that message, not the oldest queued one', async () => {
    const h = setup();
    try {
      await h.broker.createSession({ id: 's1' });
      const first = await h.submit('fix A');
      await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text: 'fix A' }, { mode: 'spawn', task: 'fix A' }, undefined, 's1');
      const second = await h.submit('fix B');
      await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text: 'fix B' }, { mode: 'spawn', task: 'fix B' }, undefined, 's1');
      expect(h.store.listPending().map((proposal) => proposal.inputId).sort()).toEqual([first.input.id, second.input.id].sort());
      const forB = h.store.listPending().find((proposal) => proposal.inputId === second.input.id)!;
      await startAgreedWork(h.deps, forB);
      expect(h.stateOf(second.input.id)).toBe('spawned');
      expect(h.stateOf(first.input.id)).toBe('queued');
    } finally { h.dispose(); }
  });

  test('a message the gate could not read is closed with the reason instead of staying queued', async () => {
    const h = setup();
    try {
      await h.broker.createSession({ id: 's1' });
      const sent = await h.submit('hello');
      const confident = fakePort((_name, question) => choiceAnswer(question, 'conversation', 0.4));
      const restore = installJudgmentPort(confident.port);
      try { await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text: 'hello' }, { mode: 'spawn', task: 'hello' }, undefined, 's1'); }
      finally { installJudgmentPort(restore); }
      expect(h.stateOf(sent.input.id)).toBe('failed');
      expect(h.broker.getInputs('s1').find((entry) => entry.id === sent.input.id)?.error).toContain('could not be read');
    } finally { h.dispose(); }
  });

  test('a refused spawn closes the message it was for', async () => {
    const h = setup();
    try {
      reading = 'conversation';
      h.setSpawn(() => Response.json({ error: 'busy' }, { status: 429 }));
      await h.broker.createSession({ id: 's1' });
      const sent = await h.submit('hello');
      await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text: 'hello' }, { mode: 'spawn', task: 'hello' }, undefined, 's1');
      expect(h.stateOf(sent.input.id)).toBe('failed');
    } finally { h.dispose(); }
  });

  test('declining a proposal closes its message', async () => {
    const h = setup();
    try {
      await h.broker.createSession({ id: 's1' });
      const sent = await h.submit('fix A');
      await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text: 'fix A' }, { mode: 'spawn', task: 'fix A' }, undefined, 's1');
      await settleUnstartedWork(h.deps, h.store.listPending()[0]!, 'The owner declined this work.');
      expect(h.stateOf(sent.input.id)).toBe('failed');
    } finally { h.dispose(); }
  });
});

describe('a second message while the first one\'s agent is being started', () => {
  test('queues behind it, and runs once that agent finishes', async () => {
    const h = setup();
    try {
      reading = 'conversation';
      const runs: string[] = [];
      h.broker.setContinuationRunner((request) => { runs.push(request.input.body); return { agentId: 'agent-2' }; });
      await h.broker.createSession({ id: 's1' });
      const first = await h.submit('hello');
      const release1 = h.broker.beginSpawn('s1');
      const second = await h.submit('and also this');
      expect(second.mode).toBe('queued-follow-up');
      expect(h.stateOf(second.input.id)).toBe('queued');
      h.running.add('agent-1');
      await h.broker.bindAgent('s1', 'agent-1', first.input.id);
      release1();
      expect(runs).toEqual([]);
      h.running.delete('agent-1');
      await h.broker.completeAgent('s1', 'agent-1', 'done', { status: 'completed' });
      expect(runs).toEqual(['and also this']);
    } finally { h.dispose(); }
  });

  test('runs at once when the start ended without an agent', async () => {
    const h = setup();
    try {
      const runs: string[] = [];
      h.broker.setContinuationRunner((request) => { runs.push(request.input.body); return { agentId: 'agent-2' }; });
      await h.broker.createSession({ id: 's1' });
      await h.submit('hello');
      const release = h.broker.beginSpawn('s1');
      const second = await h.submit('and also this');
      expect(second.mode).toBe('queued-follow-up');
      release();
      await Promise.resolve(); await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runs).toEqual(['and also this']);
    } finally { h.dispose(); }
  });

  test('a message with no start in flight is told to spawn as before', async () => {
    const h = setup();
    try {
      await h.broker.createSession({ id: 's1' });
      expect((await h.submit('hello')).mode).toBe('spawn');
    } finally { h.dispose(); }
  });
});
