/**
 * companion-chat-turn-behaviour.test.ts
 *
 * What a chat turn does with the work it is given: a reply that keeps asking
 * for tools ends, a chat with no tools never records an unanswered tool call,
 * a steer reports what it really did, a message is marked queued by what is
 * running when it is stored, an edited or regenerated message reaches the model
 * with its files, and an attachment the model cannot read says so.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { settleEvents, waitFor } from './_helpers/test-timeout.js';
import { trackDisposables } from './_helpers/disposables.ts';
import {
  COMPANION_MAX_TOOL_ROUNDS,
  CompanionChatManager,
  companionChatContentScope,
} from '../platform/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionChatArtifactStore,
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../platform/src/platform/companion/companion-chat-manager.js';
import { buildProviderUserContent } from '../platform/src/platform/companion/companion-chat-attachments.js';
import { CompanionBrokerSync } from '../platform/src/platform/companion/companion-chat-broker-sync.js';
import type { CompanionChatSession } from '../platform/src/platform/companion/companion-chat-types.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { ProviderMessage } from '../platform/src/platform/providers/interface.js';
import {
  getProcessUntrustedContentLedger,
  resetProcessUntrustedContentLedgerForTests,
  withUntrustedContentScope,
} from '../platform/src/platform/security/untrusted-content.ts';

const disposables = trackDisposables();

beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });
afterEach(() => { resetProcessUntrustedContentLedgerForTests(); });

interface CapturedEvent { readonly name: string; readonly payload: Record<string, unknown> }

function makeManager(
  provider: CompanionLLMProvider,
  extra: { toolRegistry?: ToolRegistry; artifactStore?: CompanionChatArtifactStore } = {},
): { manager: CompanionChatManager; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const manager = disposables.add(new CompanionChatManager({
    provider,
    eventPublisher: { publishEvent(name: string, payload: unknown) { events.push({ name, payload: payload as Record<string, unknown> }); } },
    gcIntervalMs: 999_999,
    rateLimiter: false,
    ...extra,
  }));
  return { manager, events };
}

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}

function textOf(content: ProviderMessage['content'] | undefined): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

const FILE_ID = 'artifact-1';
function textArtifactStore(body: string, mimeType = 'text/plain'): CompanionChatArtifactStore {
  return {
    get: (id) => (id === FILE_ID ? {
      id: FILE_ID, kind: 'document', mimeType, filename: 'notes.txt', sizeBytes: body.length, createdAt: 1,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: {},
    } : null),
    readContent: async () => ({ record: { mimeType, filename: 'notes.txt' }, buffer: new TextEncoder().encode(body) }),
  };
}

describe('a reply that keeps asking for tools', () => {
  test('ends after the round limit with one final answer that has no tools', async () => {
    let toolRuns = 0;
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'again', description: 'always asks for more', parameters: { type: 'object', properties: {} } },
      async execute() { toolRuns += 1; return { success: true, output: 'more' }; },
    });
    let providerCalls = 0;
    let finalizerCalls = 0;
    const provider: CompanionLLMProvider = {
      async *chatStream(_messages, options) {
        providerCalls += 1;
        if (!options?.tools || options.tools.length === 0) {
          finalizerCalls += 1;
          yield { type: 'text_delta', delta: 'final answer' };
          yield { type: 'done' };
          return;
        }
        yield { type: 'tool_call', toolCallId: `call-${providerCalls}`, toolName: 'again', toolInput: {} };
        yield { type: 'done' };
      },
    };
    const { manager, events } = makeManager(provider, { toolRegistry: registry });
    const session = manager.createSession();
    const reply = await manager.postMessageAndWaitForReply(session.id, 'loop forever', '', { timeoutMs: 20_000 });

    expect(reply.response).toContain('final answer');
    expect(finalizerCalls).toBe(1);
    expect(providerCalls).toBe(COMPANION_MAX_TOOL_ROUNDS + 1);
    expect(toolRuns).toBeLessThanOrEqual(COMPANION_MAX_TOOL_ROUNDS - 1);
    // Every announced tool call got a result, including the one that was not run.
    const calls = events.filter((e) => e.name === 'companion-chat.turn.tool_call');
    const results = events.filter((e) => e.name === 'companion-chat.turn.tool_result');
    expect(results.length).toBe(calls.length);
    expect(events.some((e) => e.name === 'companion-chat.turn.completed')).toBe(true);
    expect(events.some((e) => e.name === 'companion-chat.turn.error')).toBe(false);
  });
});

describe('a chat with no tool registry', () => {
  test('keeps an unanswered tool call out of the history it sends on the next turn', async () => {
    const seen: ProviderMessage[][] = [];
    let call = 0;
    const provider: CompanionLLMProvider = {
      async *chatStream(messages) {
        seen.push([...messages]);
        call += 1;
        if (call === 1) {
          yield { type: 'text_delta', delta: 'let me look' };
          yield { type: 'tool_call', toolCallId: 'orphan', toolName: 'search', toolInput: {} };
        } else {
          yield { type: 'text_delta', delta: 'ok' };
        }
        yield { type: 'done' };
      },
    };
    const { manager } = makeManager(provider);
    const session = manager.createSession();
    await manager.postMessageAndWaitForReply(session.id, 'first', '', { timeoutMs: 5_000 });
    await manager.postMessageAndWaitForReply(session.id, 'second', '', { timeoutMs: 5_000 });

    expect(seen).toHaveLength(2);
    const secondTurn = seen[1]!;
    expect(secondTurn.some((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)).toBe(false);
    expect(secondTurn.some((message) => message.role === 'assistant' && textOf(message.content).includes('let me look'))).toBe(true);
  });
});

describe('steer', () => {
  test('stops the reply that started while the steer was being prepared, and reports its own turn started', async () => {
    const release = gate();
    let call = 0;
    const provider: CompanionLLMProvider = {
      async *chatStream(_messages, options) {
        const index = call++;
        yield { type: 'text_delta', delta: `reply-${index}` };
        if (index === 0) {
          await Promise.race([release.wait, new Promise<void>((resolve) => options?.abortSignal?.addEventListener('abort', () => resolve()))]);
        }
        yield { type: 'done' };
      },
    };
    const attachmentGate = gate();
    const store = textArtifactStore('file body');
    const slowStore: CompanionChatArtifactStore = {
      get: store.get,
      readContent: async (id) => { await attachmentGate.wait; return store.readContent(id); },
    };
    const { manager } = makeManager(provider, { artifactStore: slowStore });
    const session = manager.createSession();

    // The steer is still reading its attachment when an ordinary message starts a reply.
    const steering = manager.steerMessage(session.id, 'change course', '', { attachments: [{ artifactId: FILE_ID }] });
    await manager.postMessage(session.id, 'meanwhile');
    await waitFor(() => manager.getMessages(session.id).some((m) => m.content === 'meanwhile'));
    attachmentGate.open();
    const steered = await steering;

    expect(steered.cancelledTurnId).toBeDefined();
    expect(steered.turnStarted).toBe(true);
    release.open();
  });

  test('a stop that cannot be carried out does not throw after the message was queued, and says the turn did not start', async () => {
    const release = gate();
    const provider: CompanionLLMProvider = {
      async *chatStream() {
        yield { type: 'text_delta', delta: 'working' };
        await release.wait;
        yield { type: 'done' };
      },
    };
    const { manager } = makeManager(provider);
    const session = manager.createSession();
    await manager.postMessage(session.id, 'long task');
    await waitFor(() => manager.getMessages(session.id).length >= 1);
    await settleEvents(20);
    const cancelling = spyOn(manager, 'cancelTurn').mockRejectedValue(Object.assign(new Error('cannot stop'), { code: 'STORAGE_BROKEN' }));

    const result = await manager.steerMessage(session.id, 'urgent');
    expect(result.steered).toBe(true);
    expect(result.turnStarted).toBe(false);
    expect(result.cancelledTurnId).toBeUndefined();
    expect(manager.getMessages(session.id).filter((m) => m.content === 'urgent')).toHaveLength(1);
    cancelling.mockRestore();
    release.open();
  });
});

describe('queued marker', () => {
  test('a message stored while a reply runs is marked queued even when the reply started during its preparation', async () => {
    const release = gate();
    let call = 0;
    const provider: CompanionLLMProvider = {
      async *chatStream() {
        const index = call++;
        yield { type: 'text_delta', delta: `reply-${index}` };
        if (index === 0) await release.wait;
        yield { type: 'done' };
      },
    };
    const attachmentGate = gate();
    const store = textArtifactStore('file body');
    const slowStore: CompanionChatArtifactStore = {
      get: store.get,
      readContent: async (id) => { await attachmentGate.wait; return store.readContent(id); },
    };
    const { manager } = makeManager(provider, { artifactStore: slowStore });
    const session = manager.createSession();

    const withFile = manager.postMessage(session.id, 'with a file', '', { attachments: [{ artifactId: FILE_ID }] });
    await manager.postMessage(session.id, 'plain');
    await waitFor(() => manager.getMessages(session.id).some((m) => m.content === 'plain'));
    attachmentGate.open();
    const withFileId = await withFile;

    expect(manager.getMessages(session.id).find((m) => m.id === withFileId)?.deliveryState).toBe('queued');
    release.open();
  });
});

describe('edit and regenerate', () => {
  async function settledChat(store: CompanionChatArtifactStore, seen: ProviderMessage[][]) {
    const provider: CompanionLLMProvider = {
      async *chatStream(messages) {
        seen.push([...messages]);
        yield { type: 'text_delta', delta: 'reply' } satisfies CompanionProviderChunk;
        yield { type: 'done' };
      },
    };
    const made = makeManager(provider, { artifactStore: store });
    const session = made.manager.createSession();
    return { ...made, session };
  }

  test('an edit that adds a text file sends the file body to the model', async () => {
    const seen: ProviderMessage[][] = [];
    const { manager, session } = await settledChat(textArtifactStore('SECRET-BODY-12345'), seen);
    const original = await manager.postMessage(session.id, 'hello');
    await waitFor(() => manager.getMessages(session.id).some((m) => m.role === 'assistant'));
    await settleEvents(20);

    manager.editMessage(session.id, { messageId: original, content: 'read this', attachments: [{ artifactId: FILE_ID }] });
    await waitFor(() => seen.length === 2);
    const lastUser = [...seen[1]!].reverse().find((message) => message.role === 'user');
    expect(textOf(lastUser?.content)).toContain('SECRET-BODY-12345');
  });

  test('a regenerated reply to a message with a text file still sends the file body to the model', async () => {
    const seen: ProviderMessage[][] = [];
    const { manager, session } = await settledChat(textArtifactStore('REGEN-BODY-98765'), seen);
    await manager.postMessage(session.id, 'look at this', '', { attachments: [{ artifactId: FILE_ID }] });
    await waitFor(() => manager.getMessages(session.id).some((m) => m.role === 'assistant'));
    await settleEvents(20);

    manager.regenerateMessage(session.id);
    await waitFor(() => seen.length === 2);
    const lastUser = [...seen[1]!].reverse().find((message) => message.role === 'user');
    expect(textOf(lastUser?.content)).toContain('REGEN-BODY-98765');
  });

  test('an owner-driven edit restarts the untrusted-content window and an unattested one does not', async () => {
    const seen: ProviderMessage[][] = [];
    const { manager, session } = await settledChat(textArtifactStore('x'), seen);
    const original = await manager.postMessage(session.id, 'hello');
    await waitFor(() => manager.getMessages(session.id).some((m) => m.role === 'assistant'));
    await settleEvents(20);
    const ledger = getProcessUntrustedContentLedger();
    const readAPage = (): void => ledger.record({ surface: 'web-page', origin: 'https://news.example', at: new Date().toISOString(), content: 'stranger text' });

    readAPage();
    const unattested = manager.editMessage(session.id, { messageId: original, content: 'edit one' });
    const inChat = (): boolean => withUntrustedContentScope(companionChatContentScope(session.id), () => ledger.hasIngestedThisTurn());
    expect(inChat()).toBe(true);
    await waitFor(() => seen.length === 2);
    await settleEvents(20);

    manager.editMessage(session.id, { messageId: unattested.messageId, content: 'edit two' }, { ownerDirect: true });
    expect(inChat()).toBe(false);
  });
});

describe('an attachment the model cannot read', () => {
  const attachment = {
    id: FILE_ID, artifactId: FILE_ID, kind: 'document' as const, mimeType: 'application/pdf', filename: 'report.pdf', sizeBytes: 900_000,
    createdAt: 1, acquisitionMode: 'inline-data' as const, fetchMode: 'not-applicable' as const, metadata: {},
  };

  test('a file type that is not read in is named as not included', async () => {
    const content = await buildProviderUserContent('summarise', [attachment], textArtifactStore('x', 'application/pdf'));
    const text = textOf([{ type: 'text', text: typeof content === 'string' ? content : '' }]);
    expect(text).toContain('Not included: report.pdf');
    expect(text).toContain('tell the user so');
  });

  test('a file whose read fails is named as not included', async () => {
    const failing: CompanionChatArtifactStore = {
      get: () => null,
      readContent: async () => { throw new Error('gone'); },
    };
    const small = { ...attachment, mimeType: 'text/plain', sizeBytes: 10 };
    const content = await buildProviderUserContent('summarise', [small], failing);
    expect(typeof content === 'string' ? content : '').toContain('Not included: report.pdf (it could not be read)');
  });

  test('a file that is read in is not reported as missing', async () => {
    const small = { ...attachment, mimeType: 'text/plain', sizeBytes: 10 };
    const content = await buildProviderUserContent('summarise', [small], textArtifactStore('HELLO-BODY'));
    const text = typeof content === 'string' ? content : '';
    expect(text).toContain('HELLO-BODY');
    expect(text).not.toContain('Not included');
  });
});

describe('the broker mirror', () => {
  test('forgets a session once its last operation has settled', async () => {
    const calls: string[] = [];
    const sync = new CompanionBrokerSync({
      register: async () => { calls.push('register'); },
      closeSession: async () => { calls.push('close'); },
      deleteSession: async () => { calls.push('delete'); },
    });
    const meta = { id: 'chat-1', title: 'Chat' } as CompanionChatSession;
    sync.track('chat-1', () => sync.registerSession(meta));
    sync.track('chat-1', () => sync.closeSession('chat-1'));
    await sync.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['register', 'close']);
    const pending = Reflect.get(sync, 'pendingOps') as Map<string, Promise<void>>;
    expect(pending.size).toBe(0);
  });
});
