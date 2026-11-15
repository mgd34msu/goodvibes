/**
 * A failed auto-save at the end of a turn is told to the user once per
 * failure streak, and the budget alert carries the session id current when it
 * fires.
 */
import { describe, test, expect, mock } from 'bun:test';
import { wireTurnEventHandlers } from '../../core/turn-event-wiring.ts';
import type { WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import { FocusTracker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { useTestWebhookNotifications, makeTestWebhookNotifier } from '../helpers/notification-transport.ts';

useTestWebhookNotifications();

type EventHandler<E> = (event: E) => void;

function makeFakeTurnEventBus() {
  const listeners = new Map<string, EventHandler<unknown>[]>();

  function on(type: string, handler: EventHandler<unknown>): () => void {
    const existing = listeners.get(type) ?? [];
    existing.push(handler);
    listeners.set(type, existing);
    return () => {
      const arr = listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function emit(type: string, event: unknown): void {
    for (const handler of listeners.get(type) ?? []) handler(event);
  }

  return { on, emit };
}

function makeFakeEvents() {
  const turns = makeFakeTurnEventBus();
  const tools = makeFakeTurnEventBus();
  const agents = makeFakeTurnEventBus();
  const contracts = makeFakeTurnEventBus();
  // UiRuntimeEvents shape: { turns, tools, agents, contracts, ... }, these
  // four are what wireTurnEventHandlers reads (added agents/contracts
  // for the agent/chain-failure desktop alerts).
  return {
    // @ts-expect-error, duck-typed minimal fake for UiRuntimeEvents
    events: { turns, tools, agents, contracts } as WireTurnEventHandlersOptions['events'],
    emitTurn: (type: string, payload: unknown) => turns.emit(type, payload),
    emitTool: (type: string, payload: unknown) => tools.emit(type, payload),
    emitAgent: (type: string, payload: unknown) => agents.emit(type, payload),
    emitContract: (type: string, payload: unknown) => contracts.emit(type, payload),
  };
}

function makeMinimalOptions(
  overrides: Partial<WireTurnEventHandlersOptions> = {},
): WireTurnEventHandlersOptions & {
  emitTurn: (type: string, payload: unknown) => void;
  emitAgent: (type: string, payload: unknown) => void;
  emitContract: (type: string, payload: unknown) => void;
} {
  const { events, emitTurn, emitAgent, emitContract } = makeFakeEvents();

  const defaults: WireTurnEventHandlersOptions = {
    events,
    conversation: {
      toJSON: () => { throw new Error('stub: no conversation'); },
      getTitleSource: () => 'stub',
      title: '',
      // Satisfy ConversationManager duck-type, only toJSON/getTitleSource/title used in TURN_COMPLETED.
      // ConversationManager is a real class with private fields, so the fake
      // can't satisfy it structurally, same `as unknown as` pattern already
      // used for this class in format-user-error.test.ts / system-message-router.test.ts.
    } as unknown as WireTurnEventHandlersOptions['conversation'],
    runtime: { sessionId: 'test-sess-id-001', model: 'test-model', provider: 'test-provider' },
    orchestrator: { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    configManager: {
      // Return 60s threshold so notifications fire when elapsedMs >= 60_000
      get: (key: string): unknown => (key === 'behavior.notifyAfterSeconds' ? 60 : key === 'behavior.notificationsMetadataOnly' ? false : undefined),
    },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000, id: 'test-model' }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: {
      high: () => {},
      low: () => {},
      routeSystemMessage: () => {},
    },
    hookDispatcher: {
      fire: mock(async () => ({ ok: true })) as WireTurnEventHandlersOptions['hookDispatcher']['fire'],
    } as WireTurnEventHandlersOptions['hookDispatcher'],
    surface: makeTestSurface('/tmp/test-workdir', '/tmp/test-home'),
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({ pendingApprovals: 0 }),
    render: () => {},
    webhookNotifier: null,
    _clock: () => 0,
  };

  return { ...defaults, ...overrides, emitTurn, emitAgent, emitContract };
}


const SNAPSHOT_FAILS = { toJSON: () => { throw new Error('disk full'); }, getTitleSource: () => 'stub', title: '' } as unknown as WireTurnEventHandlersOptions['conversation'];
const completed = (turnId: string) => ({ type: 'TURN_COMPLETED', turnId, response: 'hi', stopReason: 'completed' });

describe('auto-save failure notice', () => {
  test('a save that throws is shown to the user, once for the whole failure streak', () => {
    const warnings: string[] = [];
    const opts = makeMinimalOptions({
      conversation: SNAPSHOT_FAILS,
      systemMessageRouter: { high: (m) => { warnings.push(m); }, low: () => {}, routeSystemMessage: () => {} },
    });
    wireTurnEventHandlers(opts);
    opts.emitTurn('TURN_COMPLETED', completed('t1'));
    opts.emitTurn('TURN_COMPLETED', completed('t2'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not be saved');
    expect(warnings[0]).toContain('disk full');
  });
});

describe('budget alert session id', () => {
  test('the webhook fact names the session in force when the budget is crossed', () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeTestWebhookNotifier(['https://example.com/budget']);
    const runtime = { sessionId: 'sess-before', model: 'claude-sonnet-4-6', provider: 'anthropic' };
    const opts = makeMinimalOptions({
      runtime,
      focusTracker: tracker,
      webhookNotifier: notifier,
      orchestrator: { lastInputTokens: 0, usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      providerRegistry: { getCurrentModel: () => ({ contextWindow: 200_000, id: 'claude-sonnet-4-6' }), getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow },
      configManager: { get: (key: string): unknown => (key === 'behavior.budgetAlertUsd' ? 1 : undefined) },
    });
    wireTurnEventHandlers(opts);
    runtime.sessionId = 'sess-after-resume';
    opts.emitTurn('TURN_COMPLETED', completed('t1'));
    const calls = (notifier.sendNotification as unknown as { mock: { calls: Array<[{ kind: string; facts?: { sessionId?: string } }]> } }).mock.calls;
    const budget = calls.map((c) => c[0]).find((n) => n.kind === 'budget');
    expect(budget?.facts?.sessionId).toBe('sess-after-resume');
  });
});
