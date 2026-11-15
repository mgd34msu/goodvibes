/**
 * The Usage tracker's per-turn history and agent ledger against a fake event
 * feed: a resumed session's restored history is not one giant turn, and a
 * cancelled agent settles instead of staying "running" forever.
 */
import { expect, test } from 'bun:test';
import type { AgentEvent, TurnEvent } from '@goodvibes-jev/engine/platform/events';
import type { AgentRecord } from '@goodvibes-jev/engine/platform/platform/tools';
import type { UiEventFeed } from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import { UsageTracker, type UsageTotals } from '../../runtime/usage-tracker.ts';

function fakeFeed<T extends { readonly type: string }>() {
  const handlers = new Map<string, Array<(event: never) => void>>();
  const feed = {
    on: (type: string, handler: (event: never) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return () => {};
    },
    onAny: () => () => {},
  } as unknown as UiEventFeed<T extends TurnEvent ? TurnEvent : AgentEvent>;
  const emit = (event: T): void => { for (const h of handlers.get(event.type) ?? []) h(event as never); };
  return { feed, emit };
}

function makeTracker(usage: { value: UsageTotals }, agents: Map<string, AgentRecord> = new Map()) {
  const turns = fakeFeed<TurnEvent>();
  const agentFeed = fakeFeed<AgentEvent>();
  const config = { get: () => undefined, set: () => {} };
  const tracker = new UsageTracker({
    turnEvents: turns.feed as never,
    agentEvents: agentFeed.feed as never,
    getUsage: () => ({ ...usage.value, model: 'test:model' }),
    getContextTokens: () => 0,
    getContextWindow: () => 0,
    getModelId: () => 'test:model',
    getAgentStatus: (id) => agents.get(id) ?? null,
    configManager: config as never,
  });
  return { tracker, turns, agents: agentFeed };
}

const submit = (turnId: string): TurnEvent => ({ type: 'TURN_SUBMITTED', turnId, prompt: 'p' });
const complete = (turnId: string): TurnEvent => ({ type: 'TURN_COMPLETED', turnId, response: 'r', stopReason: 'completed' });

test('after a resume the first turn records only its own usage, not the restored history', () => {
  const usage = { value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { tracker, turns } = makeTracker(usage);
  // The session is resumed: the orchestrator's cumulative usage is re-hydrated between turns.
  usage.value = { input: 50_000, output: 8_000, cacheRead: 0, cacheWrite: 0 };
  turns.emit(submit('t1'));
  usage.value = { input: 50_300, output: 8_100, cacheRead: 0, cacheWrite: 0 };
  turns.emit(complete('t1'));
  expect(tracker.turns().map((t) => [t.input, t.output])).toEqual([[300, 100]]);
});

test('after a rewind lowers the cumulative, the next turn still records its own usage', () => {
  const usage = { value: { input: 90_000, output: 9_000, cacheRead: 0, cacheWrite: 0 } };
  const { tracker, turns } = makeTracker(usage);
  turns.emit(submit('t1'));
  turns.emit(complete('t1'));
  usage.value = { input: 20_000, output: 2_000, cacheRead: 0, cacheWrite: 0 };
  turns.emit(submit('t2'));
  usage.value = { input: 20_400, output: 2_050, cacheRead: 0, cacheWrite: 0 };
  turns.emit(complete('t2'));
  expect(tracker.turns().map((t) => [t.input, t.output])).toEqual([[0, 0], [400, 50]]);
});

test('a submission inside an open turn (a failover retry) keeps the turn baseline', () => {
  const usage = { value: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 } };
  const { tracker, turns } = makeTracker(usage);
  turns.emit(submit('t1'));
  usage.value = { input: 1_200, output: 120, cacheRead: 0, cacheWrite: 0 };
  turns.emit(submit('t1'));
  usage.value = { input: 1_500, output: 150, cacheRead: 0, cacheWrite: 0 };
  turns.emit(complete('t1'));
  expect(tracker.turns().map((t) => [t.input, t.output])).toEqual([[500, 50]]);
});

test('a cancelled agent settles with its final usage and is no longer polled', () => {
  const usage = { value: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const agents = new Map<string, AgentRecord>();
  const { tracker, agents: feed } = makeTracker(usage, agents);
  feed.emit({ type: 'AGENT_SPAWNING', agentId: 'a1', task: 'work' } as AgentEvent);
  expect(tracker.agents()[0]?.status).toBe('running');
  agents.set('a1', { model: 'test:model', usage: { inputTokens: 700, outputTokens: 40 } } as unknown as AgentRecord);
  feed.emit({ type: 'AGENT_CANCELLED', agentId: 'a1' });
  const settled = tracker.agents()[0];
  expect(settled?.status).toBe('cancelled');
  expect(settled?.inputTokens).toBe(700);
  // Later changes to the record are not re-read: the entry is no longer running.
  agents.set('a1', { model: 'test:model', usage: { inputTokens: 900, outputTokens: 60 } } as unknown as AgentRecord);
  expect(tracker.pollRunningAgents()).toBe(false);
  expect(tracker.agents()[0]?.inputTokens).toBe(700);
});

test('after a failed turn, a rewind and a new submission re-baseline instead of recording the restored history', () => {
  const usage = { value: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 } };
  const { tracker, turns } = makeTracker(usage);
  turns.emit(submit('t1'));
  turns.emit({ type: 'TURN_ERROR', turnId: 't1', error: 'boom', stopReason: 'provider_error' });
  // A resume or rewind re-hydrates the cumulative usage between turns.
  usage.value = { input: 60_000, output: 6_000, cacheRead: 0, cacheWrite: 0 };
  turns.emit(submit('t2'));
  usage.value = { input: 60_200, output: 6_040, cacheRead: 0, cacheWrite: 0 };
  turns.emit(complete('t2'));
  expect(tracker.turns().map((t) => [t.input, t.output])).toEqual([[200, 40]]);
});
