import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { SystemMessageRouter, createSystemMessageRouter, type SystemMessageKind, type SystemMessagePriority, type SystemMessageTarget } from '../../core/system-message-router.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { ActivityFeed } from '../../core/activity-feed.ts';
import type { ConversationManager } from '../../core/conversation';

// The router consumes a semantic priority reading it does not compute itself. The fake answers per message
// text, so a case only passes when the router asked about that message and delivered that message's answer;
// asking about any other text fails loudly.
const judged = new Map<string, SystemMessagePriority>();
let previousJudgmentPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  judged.clear();
  previousJudgmentPort = installJudgmentPort(fakePort((name, question, state) => {
    if (name !== 'priority') throw new Error(`Unexpected priority question: ${name}`);
    const answer = judged.get(String(state));
    if (answer === undefined) throw new Error(`Priority asked about an unexpected message: ${String(state)}`);
    return choiceAnswer(question, answer, 0.97);
  }).port);
});
afterEach(() => { installJudgmentPort(previousJudgmentPort); });

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeConversation(): { addSystemMessage: ReturnType<typeof mock>; _messages: string[] } {
  const _messages: string[] = [];
  const addSystemMessage = mock((msg: string) => { _messages.push(msg); });
  return { addSystemMessage, _messages } as unknown as { addSystemMessage: ReturnType<typeof mock>; _messages: string[] };
}

function makePanel(): { push: ReturnType<typeof mock>; handleInput: ReturnType<typeof mock>; _pushed: { text: string; priority: SystemMessagePriority }[] } {
  const _pushed: { text: string; priority: SystemMessagePriority }[] = [];
  const push = mock((text: string, priority: SystemMessagePriority) => { _pushed.push({ text, priority }); });
  const handleInput = mock((_key: string): boolean => true);
  return { push, handleInput, _pushed } as unknown as { push: ReturnType<typeof mock>; handleInput: ReturnType<typeof mock>; _pushed: { text: string; priority: SystemMessagePriority }[] };
}

function makeTargetResolver(
  overrides: Partial<Record<SystemMessageKind, SystemMessageTarget>> = {},
): (kind: SystemMessageKind) => SystemMessageTarget {
  return (kind) => overrides[kind] ?? (kind === 'contract' ? 'both' : 'panel');
}

// ---------------------------------------------------------------------------
// routeAuto: the judged priority reaches the feed with its own message
// ---------------------------------------------------------------------------

describe('routeAuto priority delivery', () => {
  let conv: ReturnType<typeof makeConversation>;
  let panel: ReturnType<typeof makePanel>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    panel = makePanel();
    router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver(),
    );
  });

  const cases: readonly (readonly [string, SystemMessagePriority])[] = [
    ['[Model] Switched to gpt-5 (openai)', 'high'],
    ['[Session] saved abc123', 'high'],
    ['[Recovery] Failed to restore: disk error', 'high'],
    ['A fatal error occurred', 'high'],
    ['[Scan] Found ollama at localhost:11434', 'low'],
    ['[MCP] Discovered server myserver (npx myserver-mcp).', 'low'],
    ['[Agents] ✓ abc12345 completed', 'low'],
  ];

  test('each message reaches the feed with the priority judged for that message', async () => {
    for (const [text, priority] of cases) judged.set(text, priority);
    for (const [text] of cases) await router.routeAuto(text);
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel._pushed).toEqual(cases.map(([text, priority]) => ({ text, priority })));
  });

  test('the same text takes whichever priority is judged, so the feed priority is not fixed by the router', async () => {
    const text = '[Scan] Found ollama at localhost:11434';
    judged.set(text, 'high');
    await router.routeAuto(text);
    judged.set(text, 'low');
    await router.routeAuto(text);
    expect(panel._pushed.map((entry) => entry.priority)).toEqual(['high', 'low']);
  });

  test('[Agents] periodic running-snapshot is dropped by the noise gate whatever its priority', async () => {
    // The 30s "[Agents] N running:" churn is dropped from the feed; the live
    // detail stays on the fleet/agents surface + footer count.
    judged.set('[Agents] 3 running:\n  abc12345: working', 'high');
    await router.routeAuto('[Agents] 3 running:\n  abc12345: working');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).not.toHaveBeenCalled();
  });

  test('[Tool] activity messages resolve to the operational target and can route separately', async () => {
    const opsRouter = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver({ operational: 'conversation' }),
    );
    judged.set('[Tool] edit applied to src/main.ts', 'low');
    await opsRouter.routeAuto('[Tool] edit applied to src/main.ts');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('[Tool] edit applied to src/main.ts');
    expect(panel.push).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// routeSystemMessage
// ---------------------------------------------------------------------------

describe('routeSystemMessage', () => {
  let conv: ReturnType<typeof makeConversation>;
  let panel: ReturnType<typeof makePanel>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    panel = makePanel();
    router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver(),
    );
  });

  test('system messages respect panel-only default target', () => {
    router.routeSystemMessage('high message', 'high');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledWith('high message', 'high');
  });

  test('low priority routes to panel only', () => {
    router.routeSystemMessage('low message', 'low');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledWith('low message', 'low');
  });

  test('high convenience method routes high', () => {
    router.high('important!');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledWith('important!', 'high');
  });

  test('contract convenience method routes to both by default', () => {
    router.contract('[Contract] Chain abc started');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('[Contract] Chain abc started');
    expect(panel.push).toHaveBeenCalledWith('[Contract] Chain abc started', 'high');
  });

  test('low convenience method routes low (panel only)', () => {
    router.low('noisy status');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledWith('noisy status', 'low');
  });

  test('null panel does not throw on high route', () => {
    const noPanel = createSystemMessageRouter(conv as unknown as ConversationManager, null, makeTargetResolver({ system: 'conversation' }));
    expect(() => noPanel.high('msg')).not.toThrow();
    expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('null panel does not throw on low route', () => {
    const noPanel = createSystemMessageRouter(conv as unknown as ConversationManager, null);
    expect(() => noPanel.low('msg')).not.toThrow();
    expect(conv.addSystemMessage).toHaveBeenCalledWith('msg');
  });

  test('panel-targeted routes fall back to conversation when no panel is attached', () => {
    const noPanel = createSystemMessageRouter(conv as unknown as ConversationManager, null, makeTargetResolver({ system: 'panel' }));
    noPanel.routeSystemMessage('panel fallback', 'low');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('panel fallback');
  });

  test('custom system target can route to both', () => {
    const bothRouter = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver({ system: 'both' }),
    );
    bothRouter.routeSystemMessage('both message', 'high');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('both message');
    expect(panel.push).toHaveBeenCalledWith('both message', 'high');
  });
});

// ---------------------------------------------------------------------------
// routeAuto with no panel attached
// ---------------------------------------------------------------------------

describe('routeAuto without a panel', () => {
  const messages: readonly (readonly [string, SystemMessagePriority])[] = [
    ['[Model] Switched to claude-4', 'high'],
    ['fatal error in module', 'high'],
    ['[Scan] Found server at localhost', 'low'],
    ['[Plugin] loaded my-plugin', 'low'],
  ];

  test.each(messages)('delivers "%s" to the conversation whatever its priority', async (text, priority) => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, null, makeTargetResolver());
    judged.set(text, priority);
    await router.routeAuto(text);
    expect(conv.addSystemMessage).toHaveBeenCalledWith(text);
  });

  test('contract messages follow the contract target policy', async () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, null, makeTargetResolver());
    judged.set('[Contract] Chain abc123 started', 'high');
    await router.routeAuto('[Contract] Chain abc123 started');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('[Contract] Chain abc123 started');
  });
});

// ---------------------------------------------------------------------------
// Panel: push renders and handleInput scroll
// ---------------------------------------------------------------------------

describe('SystemMessagesPanel integration', () => {
  test('push sends to panel with correct priority', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver(),
    );

    router.low('[Scan] discovered server');
    expect(panel._pushed).toHaveLength(1);
    expect(panel._pushed[0]!.text).toBe('[Scan] discovered server');
    expect(panel._pushed[0]!.priority).toBe('low');
  });

  test('high push is captured in panel with high priority', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver(),
    );

    router.high('[Model] switched');
    expect(panel._pushed[0]!.priority).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// getPanel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Noise gate, router integration
// ---------------------------------------------------------------------------

describe('noise gate', () => {
  test('the terminal captured-write notice reaches neither the feed nor the conversation', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver({ system: 'both' }), // even a "both" target must not leak it
    );
    // This is exactly what main.ts routes the guard notice through (.low).
    router.low('[Terminal] Captured 4 direct stdout writes that would have corrupted the TUI: boot plumbing');
    expect(panel.push).not.toHaveBeenCalled();
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
  });

  test('a genuine lifecycle message is NOT suppressed (classifier specificity)', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver(),
    );
    router.low('[Terminal] resized to 120x40');
    expect(panel.push).toHaveBeenCalledWith('[Terminal] resized to 120x40', 'low');
  });

  describe('provider "from last session" replay', () => {
    const replay = (name: string, models: number) => `[Local] ${name} at localhost:11434 (${models} models) — from last session`;

    function setup() {
      const conv = makeConversation();
      const panel = makePanel();
      const router = createSystemMessageRouter(
        conv as unknown as ConversationManager,
        panel as unknown as ActivityFeed,
        makeTargetResolver(),
      );
      return { conv, panel, router };
    }

    test('stays off the feed and the conversation, and each burst is folded into its own logged summary', async () => {
      const info = spyOn(logger, 'info').mockImplementation(() => {});
      try {
        const { conv, panel, router } = setup();
        router.low(replay('ollama', 2));
        router.low(replay('lmstudio', 1));
        // Nothing is logged until the microtask that closes the burst has run.
        expect(info).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0]?.[0]).toBe('[Local] Restored 2 providers from last session (ollama, lmstudio)');

        // A later burst starts from an empty buffer instead of accumulating onto the first.
        router.low(replay('vllm', 3));
        await Promise.resolve();
        expect(info).toHaveBeenCalledTimes(2);
        expect(info.mock.calls[1]?.[0]).toBe('[Local] Restored 1 provider from last session (vllm)');

        expect(panel.push).not.toHaveBeenCalled();
        expect(conv.addSystemMessage).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    });

    test('a flush with nothing buffered logs nothing', () => {
      const info = spyOn(logger, 'info').mockImplementation(() => {});
      try {
        setup().router.flushProviderReplay();
        expect(info).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    });
  });

  test('a WRFC replay for a terminal chain is dropped when isChainTerminal says so', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver({ contract: 'both' }),
      { isChainTerminal: (id) => id === 'chain-9' },
    );
    router.contract('[Replay] WRFC chain chain-9 transitioned pending → review — waiting for action (first notified 3 turns ago)');
    expect(panel.push).not.toHaveBeenCalled();
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
  });
});

describe('getFeed', () => {
  test('returns the panel passed at construction', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as ActivityFeed,
      makeTargetResolver(),
    );
    expect(router.getFeed()).toBe(panel as unknown as ActivityFeed);
  });

  test('returns null when no panel passed', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager);
    expect(router.getFeed()).toBeNull();
  });
});

describe('direct user-action results', () => {
  test.each(['panel', 'conversation', 'both'] as const)('remains visible exactly once with %s ambient routing', target => {
    const conv = makeConversation(); const feed = makePanel();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, feed as unknown as ActivityFeed,
      makeTargetResolver({ system: target }));
    const message = 'Connected-host operator token is required. No ordinary turn was started.';
    router.userAction(message);
    expect(conv._messages).toEqual([message]);
    expect(feed._pushed).toEqual([{ text: message, priority: 'high' }]);
  });
});
