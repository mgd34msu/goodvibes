/** What a channel sender is told when their message or answer cannot be acted on, and which credentials delivery uses. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { gateSurfaceSpawn, type ConversationGateDeps } from '../platform/src/platform/daemon/surface-conversation-gate.js';
import { tryResolveWorkProposalReplyFromChannel } from '../platform/src/platform/daemon/work-proposal-reply.js';
import { WorkProposalStore } from '../platform/src/platform/agents/work-proposal-store.js';
import { postHomeAssistantSurfaceChatMessage } from '../platform/src/platform/daemon/surface-homeassistant-reply.js';
import { DaemonSurfaceDeliveryHelper } from '../platform/src/platform/daemon/surface-delivery.js';
import type { ChannelIngressPolicyInput, RouteBindingManager } from '../platform/src/platform/channels/index.js';
import type { PendingSurfaceReply } from '../platform/src/platform/daemon/types.js';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let answer: string;
let confidence: number;

beforeEach(() => {
  answer = 'approve';
  confidence = 0.99;
  const fake = fakePort((name, question) => {
    if (name === 'kind' && question.type === 'choice' && 'other' in question.criteria) return choiceAnswer(question, 'other', 0.99);
    return choiceAnswer(question, answer, confidence);
  });
  const port: JudgmentPort = { model: fake.port.model, async ask(request) { return fake.port.ask(request); } };
  log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });

function proposalHarness() {
  const store = new WorkProposalStore();
  const notices: string[] = [];
  const input: ChannelIngressPolicyInput = { surface: 'ntfy', userId: 'owner', channelId: 'channel', text: 'yes please' };
  const created = store.create({ surfaceKind: 'ntfy', userId: 'owner', channelId: 'channel', task: 'Fix login', summary: 'Fix login', ttlMs: 60_000 });
  store.markDelivered(created.id);
  return { store, notices, input, created };
}

describe('a reply to a work proposal is never met with silence', () => {
  test('a reply that cannot be read tells the sender to resend it', async () => {
    const h = proposalHarness();
    confidence = 0.5;
    try {
      const outcome = await tryResolveWorkProposalReplyFromChannel(h.input, {
        proposals: h.store, startAgreedWork: async () => {}, replyOnChannel: async (_proposal, text) => { h.notices.push(text); },
      });
      expect(outcome).toEqual({ consumed: true, action: 'unsettled' });
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('send it again');
      expect(h.store.listPending()).toHaveLength(1);
    } finally { h.store.dispose(); }
  });

  test('agreed work that fails to start says so instead of leaving the owner waiting', async () => {
    const h = proposalHarness();
    const settled: string[] = [];
    try {
      const outcome = await tryResolveWorkProposalReplyFromChannel(h.input, {
        proposals: h.store,
        startAgreedWork: async () => { throw new Error('spawn refused'); },
        replyOnChannel: async (_proposal, text) => { h.notices.push(text); },
        settleUnstartedWork: async (proposal, reason) => { settled.push(`${proposal.id}: ${reason}`); },
      });
      expect(outcome).toEqual({ consumed: true, action: 'start-failed' });
      expect(settled).toEqual([`${h.created.id}: The agreed work could not be started. Send the message again.`]);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain('Could not start: Fix login');
    } finally { h.store.dispose(); }
  });

  test('a second "yes" that loses the race is told the work is under way, not that it expired', async () => {
    const h = proposalHarness();
    try {
      const outcome = await tryResolveWorkProposalReplyFromChannel(h.input, {
        proposals: {
          listPending: h.store.listPending.bind(h.store),
          resolve: () => null,
          get: () => ({ ...h.created, status: 'accepted' }),
        },
        startAgreedWork: async () => {},
        replyOnChannel: async (_proposal, text) => { h.notices.push(text); },
      });
      expect(outcome).toEqual({ consumed: true, action: 'already-accepted' });
      expect(h.notices[0]).toContain('under way');
      expect(h.notices[0]).not.toContain('expired');
    } finally { h.store.dispose(); }
  });
});

describe('the conversation gate answers a message it could not read', () => {
  test('an unsettled reading sends a resend notice and spawns nothing', async () => {
    const store = new WorkProposalStore();
    const notices: string[] = [];
    const spawns: unknown[] = [];
    const deps: ConversationGateDeps = {
      configManager: { get: () => undefined },
      routeBindings: { getBinding: () => undefined, resolve: () => undefined },
      sessionBroker: { getSession: () => null, bindAgent: async () => null },
      trySpawnAgent: (input) => { spawns.push(input); return Response.json({ spawned: true }); },
      queueSurfaceReplyFromBinding: () => {},
      workProposals: store,
      deliverSurfaceNotice: async (_binding, text) => { notices.push(text); return { delivered: true }; },
    };
    answer = 'conversation';
    confidence = 0.5;
    try {
      const response = await gateSurfaceSpawn(deps, { surface: 'ntfy', text: 'hello' }, { mode: 'spawn', task: 'hello' }) as Response;
      expect(await response.json()).toMatchObject({ outcome: 'work-intent-unsettled' });
      expect(spawns).toEqual([]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('send it again');
    } finally { store.dispose(); }
  });
});

describe('an undelivered final reply is ledgered with where its answer is kept', () => {
  test('the failed entry names the session that holds the answer', () => {
    const entries: Array<{ phase: string; error?: string | undefined }> = [];
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
      routeBindings: { getBinding: () => undefined } as unknown as RouteBindingManager,
      recordDeliveryAttempt: (entry: { phase: string; error?: string | undefined }) => { entries.push(entry); },
    } as never);
    helper.recordUndeliveredReply({ surfaceKind: 'slack', agentId: 'a1', sessionId: 'sess-1', routeId: 'r1', phase: 'final', body: 'the answer', reason: '429' });
    helper.recordUndeliveredReply({ surfaceKind: 'slack', agentId: 'a2', routeId: 'r1', phase: 'final', body: 'x', reason: '500' });
    expect(entries).toEqual([
      expect.objectContaining({ phase: 'failed', error: '429 (the answer is kept in session sess-1)' }),
      expect.objectContaining({ phase: 'failed', error: '500 (no session copy exists; the answer began: x)' }),
    ]);
  });

  test('when the session write also failed, the ledger carries a bounded body instead of claiming a copy', () => {
    const entries: Array<{ phase: string; error?: string | undefined }> = [];
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
      routeBindings: { getBinding: () => undefined } as unknown as RouteBindingManager,
      recordDeliveryAttempt: (entry: { phase: string; error?: string | undefined }) => { entries.push(entry); },
    } as never);
    helper.recordUndeliveredReply(
      { surfaceKind: 'slack', agentId: 'a3', sessionId: 'sess-1', routeId: 'r1', phase: 'final', body: 'z'.repeat(5000), reason: '429' },
      { sessionCopyKept: false },
    );
    const error = entries[0]?.error ?? '';
    expect(error).not.toContain('kept in session');
    expect(error).toContain('z'.repeat(2000));
    expect(error).not.toContain('z'.repeat(2001));
    expect(error).toContain('3000 more characters');
  });
});

describe('an answer whose session copy failed to write and whose channel send then fails', () => {
  test('the poll path ledger entry carries the answer excerpt instead of claiming a session copy', async () => {
    const entries: Array<{ phase: string; error?: string | undefined }> = [];
    const pending = { agentId: 'a9', surfaceKind: 'slack', task: 't', createdAt: 1, sessionId: 'sess-9', routeId: 'r1' } as PendingSurfaceReply;
    const pendingSurfaceReplies = new Map<string, PendingSurfaceReply>([['a9', pending]]);
    let helper!: DaemonSurfaceDeliveryHelper;
    helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies,
      routeBindings: { getBinding: () => undefined } as unknown as RouteBindingManager,
      recordDeliveryAttempt: (entry: { phase: string; error?: string | undefined }) => { entries.push(entry); },
      agentManager: { getStatus: () => ({ id: 'a9', status: 'completed', task: 't', fullOutput: 'the only copy of the answer' }) },
      sessionBroker: { completeAgent: async () => { throw new Error('disk full'); } },
      // The real pipeline swallows the send error and reports through the reporter with no options.
      channelReplyPipeline: {
        has: () => true,
        untrack: () => {},
        deliverFinal: async (agentId: string, body: string) => {
          helper.recordUndeliveredReply({ surfaceKind: 'slack', agentId, sessionId: 'sess-9', routeId: 'r1', phase: 'final', body, reason: '429' });
          return null;
        },
      },
    } as never);
    await helper.pollPendingSurfaceReplies(() => {});
    const failed = entries.find((entry) => entry.phase === 'failed');
    expect(failed?.error).not.toContain('kept in session');
    expect(failed?.error).toContain('the only copy of the answer');
  });
});

describe('delivery credentials come from one place', () => {
  function build(config: Record<string, unknown>) {
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: new Map<string, PendingSurfaceReply>(),
      channelReplyPipeline: {},
      configManager: { get: (key: string) => config[key] },
      secretsManager: { get: async () => null, getGlobalHome: () => null },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: { getStatus: () => null },
      sessionBroker: {},
      routeBindings: {} as RouteBindingManager,
      channelPlugins: {},
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as never);
    return helper;
  }

  async function captureHeaders(run: () => Promise<void>): Promise<Headers[]> {
    const seen: Headers[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { headers?: HeadersInit }) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try { await run(); } finally { globalThis.fetch = original; }
    return seen;
  }

  test('the configured ntfy default priority is sent with the agent reply and the approval update', async () => {
    const helper = build({ 'surfaces.ntfy.defaultPriority': 5, 'surfaces.ntfy.baseUrl': 'https://ntfy.example.test' });
    const pending = { agentId: 'a1', surfaceKind: 'ntfy', task: 't', createdAt: 1, topic: 'priority-topic' } as PendingSurfaceReply;
    const headers = await captureHeaders(async () => {
      await helper.deliverNtfyAgentReply(pending, 'done with priority');
      await helper.deliverNtfyApprovalUpdate(
        { id: 'ap2', status: 'pending', request: { tool: 'run', analysis: { summary: 'y' } } } as never,
        { id: 'r2', channelId: 'priority-topic', metadata: {} } as never,
      );
    });
    expect(headers).toHaveLength(2);
    expect(headers.map((header) => header.get('priority'))).toEqual(['5', '5']);
  });

  test('an ntfy token set in the settings is sent with the agent reply and the approval update', async () => {
    const saved = process.env.NTFY_ACCESS_TOKEN;
    delete process.env.NTFY_ACCESS_TOKEN;
    try {
      const helper = build({ 'surfaces.ntfy.token': 'settings-token', 'surfaces.ntfy.baseUrl': 'https://ntfy.example.test' });
      const pending = { agentId: 'a1', surfaceKind: 'ntfy', task: 't', createdAt: 1, topic: 'owner-topic' } as PendingSurfaceReply;
      const headers = await captureHeaders(async () => {
        await helper.deliverNtfyAgentReply(pending, 'done');
        await helper.deliverNtfyApprovalUpdate(
          { id: 'ap1', status: 'pending', request: { tool: 'run', analysis: { summary: 'x' } } } as never,
          { id: 'r1', channelId: 'owner-topic', metadata: {} } as never,
        );
      });
      expect(headers.length).toBeGreaterThanOrEqual(2);
      expect(headers.every((header) => header.get('authorization') === 'Bearer settings-token')).toBe(true);
    } finally {
      if (saved !== undefined) process.env.NTFY_ACCESS_TOKEN = saved;
    }
  });
});

describe('a Home Assistant reply that cannot be published keeps the finished turn', () => {
  test('the session and answer are returned with a publish error, not reported as a failed turn', async () => {
    const binding = { id: 'binding-1', metadata: {} };
    const session = { id: 'chat-1', title: 'Home', status: 'open', updatedAt: Date.now() };
    const deps = {
      serviceRegistry: { resolveSecret: async () => null },
      secretsManager: { get: async () => null, getGlobalHome: () => null },
      // No Home Assistant URL or token anywhere, so publishing the reply fails after the turn succeeded.
      configManager: { get: () => undefined },
      routeBindings: { start: async () => {}, upsertBinding: async () => binding, patchBinding: async () => binding },
      companionChatManager: {
        init: async () => {},
        getSession: () => null,
        createSession: () => session,
        closeSession: () => {},
        updateSession: () => session,
        postMessageAndWaitForReply: async () => ({ messageId: 'm1', assistantMessageId: 'a1', response: 'It is 21 degrees' }),
      },
    };
    const result = await postHomeAssistantSurfaceChatMessage(deps as never, {
      body: 'how warm is it', messageId: 'in-1', conversationId: 'conv-1', surfaceId: 'ha', channelId: 'room', title: 'Home',
    });
    expect(result.sessionId).toBe('chat-1');
    expect(result.response).toBe('It is 21 degrees');
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('could not be published');
  });
});
