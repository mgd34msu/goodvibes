/**
 * homeassistant-grounding.test.ts
 *
 * The Home Assistant conversation turn can reference the pre-registered
 * home-graph knowledge space: when the input carries a grounding reference and
 * a home-graph reader is wired, the turn consults the graph as a read-only ask
 * bounded by the caller's deadline and carries the answer in the user message.
 * The system prompt stays the same across turns. Without a reference (or
 * reader) the turn stays ungrounded, and a graph failure never breaks the turn.
 */
import { describe, expect, test } from 'bun:test';
import {
  postHomeAssistantChatMessage,
  type HomeAssistantChatInput,
  type HomeAssistantChatRuntime,
  type HomeGraphGroundingReader,
} from '../platform/src/platform/daemon/homeassistant-chat.js';
import type { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatSession } from '../platform/src/platform/companion/companion-chat-types.js';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.js';
import type { HomeGraphAskInput, HomeGraphAskResult } from '../platform/src/platform/knowledge/home-graph/types.js';

interface Harness {
  runtime: HomeAssistantChatRuntime;
  lastSystemPrompt(): string | undefined;
  lastMessage(): string | undefined;
  askedQueries: HomeGraphAskInput[];
}

function makeHarness(reader?: HomeGraphGroundingReader): Harness {
  let created: string | undefined;
  let posted: string | undefined;
  const askedQueries: HomeGraphAskInput[] = [];
  const session = (systemPrompt: string): CompanionChatSession => {
    created = systemPrompt;
    return {
      id: 'chat-1',
      title: 'Home Assistant',
      status: 'active',
      updatedAt: Date.now(),
    } as unknown as CompanionChatSession;
  };
  const chatManager = {
    init: async () => {},
    getSession: () => null,
    closeSession: () => {},
    createSession: (input: { systemPrompt: string }) => session(input.systemPrompt),
    updateSession: (_id: string, input: { systemPrompt: string }) => session(input.systemPrompt),
    postMessage: async (_id: string, text: string) => { posted = text; return 'msg-1'; },
  } as unknown as CompanionChatManager;
  // A real binding. Behind the cast this was `{ id, metadata }`, missing all
  // seven required fields, including the surface it routes to, which is the
  // thing the grounding under test keys off.
  const binding: AutomationRouteBinding = {
    id: 'bind-1',
    kind: 'channel',
    surfaceKind: 'homeassistant',
    surfaceId: 'ha-1',
    externalId: 'entity.living_room',
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    metadata: {},
  };
  const routeBindings = {
    start: async () => {},
    upsertBinding: async () => binding,
    patchBinding: async () => binding,
  };
  const wrappedReader: HomeGraphGroundingReader | undefined = reader && {
    ask: (input) => {
      askedQueries.push(input);
      return reader.ask(input);
    },
  };
  const runtime: HomeAssistantChatRuntime = {
    configManager: { get: () => undefined },
    routeBindings: routeBindings as unknown as HomeAssistantChatRuntime['routeBindings'],
    chatManager,
    ...(wrappedReader ? { homeGraph: wrappedReader } : {}),
  };
  return { runtime, lastSystemPrompt: () => created, lastMessage: () => posted, askedQueries };
}

function makeInput(overrides: Partial<HomeAssistantChatInput> = {}): HomeAssistantChatInput {
  return {
    text: 'What thermostats are in the living room?',
    messageId: 'm-1',
    conversationId: 'conv-1',
    surfaceId: 'homeassistant',
    channelId: 'living_room',
    title: 'Home Assistant',
    remoteSessionTtlMs: 60_000,
    ...overrides,
  };
}

function askResult(text: string, confidence: number): HomeGraphAskResult {
  return {
    ok: true,
    spaceId: 'homeassistant:home-1',
    query: 'q',
    answer: { text, mode: 'concise', confidence, sources: [], linkedObjects: [] },
  } as unknown as HomeGraphAskResult;
}

function post(harness: Harness, input: HomeAssistantChatInput) {
  return postHomeAssistantChatMessage(harness.runtime, input, { wait: false });
}

describe('Home Assistant home-graph grounding', () => {
  test('a grounding reference carries the graph answer in the user message, read-only and bounded', async () => {
    const reader: HomeGraphGroundingReader = {
      ask: async () => askResult('The living room has a Nest thermostat (climate.living_room).', 0.9),
    };
    const harness = makeHarness(reader);
    await post(harness, makeInput({ grounding: { installationId: 'home-1' } }));
    const message = harness.lastMessage();
    expect(message).toContain('Home graph grounding');
    expect(message).toContain('Nest thermostat');
    expect(message).toContain('confidence 90%');
    expect(harness.lastSystemPrompt()).not.toContain('Home graph grounding');
    // A conversation token holds no graph-write authority: grounding never repairs or refreshes.
    expect(harness.askedQueries[0]!.readOnly).toBe(true);
    expect(harness.askedQueries[0]!.timeoutMs).toBeGreaterThan(0);
    // the turn's actual question is the query sent to the graph
    expect(harness.askedQueries[0]!.query).toBe('What thermostats are in the living room?');
    expect(harness.askedQueries[0]!.installationId).toBe('home-1');
  });

  test('no grounding reference -> no graph query, no grounding block', async () => {
    const reader: HomeGraphGroundingReader = { ask: async () => askResult('unused', 0.5) };
    const harness = makeHarness(reader);
    await post(harness, makeInput());
    expect(harness.askedQueries).toHaveLength(0);
    expect(harness.lastMessage()).not.toContain('Home graph grounding');
  });

  test('an empty graph answer adds no grounding block', async () => {
    const reader: HomeGraphGroundingReader = { ask: async () => askResult('   ', 0.0) };
    const harness = makeHarness(reader);
    await post(harness, makeInput({ grounding: { knowledgeSpaceId: 'homeassistant:home-1' } }));
    expect(harness.lastMessage()).not.toContain('Home graph grounding');
  });

  test('a graph failure degrades to an ungrounded turn, never breaking it', async () => {
    const reader: HomeGraphGroundingReader = {
      ask: async () => {
        throw new Error('graph unavailable');
      },
    };
    const harness = makeHarness(reader);
    const resolution = await post(harness, makeInput({ grounding: { installationId: 'home-1' } }));
    expect(resolution.session.id).toBe('chat-1');
    expect(harness.lastMessage()).not.toContain('Home graph grounding');
  });
});
