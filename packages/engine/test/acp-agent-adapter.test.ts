/**
 * acp-agent-adapter.test.ts
 *
 * The agent-side ACP adapter (GoodVibesAcpAgent) over an injected embedded
 * session: honest capabilities, one embedded session per ACP session, a prompt
 * driven by the submission's completion handle (streamed text, tool calls, the
 * run's outcome), cancellation, permission asks shown in the asking thread and
 * session close. The handle and the daemon the embedded sessions of one home
 * share are exercised for real in embed-session.test.ts; here they are driven
 * directly.
 */
import { describe, expect, test } from 'bun:test';
import {
  GoodVibesAcpAgent,
  mapPermissionOutcome,
  outcomeText,
  promptText,
  stopReasonFor,
  translateAcpMcpServers,
} from '../platform/src/platform/acp/agent.ts';
import type {
  EmbeddedCompletion,
  EmbeddedRunEvent,
  EmbeddedRunOutcome,
  EmbeddedSession,
  EmbeddedSessionInput,
  EmbeddedSubmission,
} from '../platform/src/platform/embed/session.ts';
import type { PermissionPromptRequest, PermissionRequestHandler } from '../platform/src/platform/permissions/prompt.ts';
import type { McpServerConfig } from '../platform/src/platform/mcp/config.ts';
import { waitFor } from './_helpers/test-timeout.js';

interface RecordedUpdate {
  sessionId: string;
  update: Record<string, unknown> & { content?: { text?: string } };
}

function makeConn(options: { permissionOptionId?: string; sessionUpdate?: (params: unknown) => Promise<void> } = {}) {
  const updates: RecordedUpdate[] = [];
  const permissionRequests: Record<string, unknown>[] = [];
  return {
    updates,
    permissionRequests,
    conn: {
      sessionUpdate: options.sessionUpdate ?? (async (params: unknown) => { updates.push(params as RecordedUpdate); }),
      requestPermission: async (params: unknown) => {
        permissionRequests.push(params as Record<string, unknown>);
        return { outcome: { outcome: 'selected', optionId: options.permissionOptionId ?? 'allow-once' } };
      },
    } as unknown as ConstructorParameters<typeof GoodVibesAcpAgent>[0],
  };
}

/** A run the test drives: events before the first listener are replayed to it, like the real handle. */
function fakeRun(agentId: string) {
  const held: EmbeddedRunEvent[] = [];
  const listeners = new Set<(event: EmbeddedRunEvent) => void>();
  let attached = false;
  let settle!: (outcome: EmbeddedRunOutcome) => void;
  const done = new Promise<EmbeddedRunOutcome>((resolve) => { settle = resolve; });
  const completion: EmbeddedCompletion = {
    agentId,
    onEvent(listener) {
      listeners.add(listener);
      if (!attached) { attached = true; for (const event of held.splice(0)) listener(event); }
      return () => { listeners.delete(listener); };
    },
    done,
  };
  return {
    completion,
    emit(event: EmbeddedRunEvent) { if (!attached) held.push(event); else for (const listener of listeners) listener(event); },
    end(outcome: EmbeddedRunOutcome) { settle(outcome); },
  };
}

function makeSubstrate(options: { onSubmit?: (run: ReturnType<typeof fakeRun>) => Promise<void> } = {}) {
  const boots: { workspace: string; mcpServers: readonly McpServerConfig[] | undefined }[] = [];
  const permissionHandlers: PermissionRequestHandler[] = [];
  const submitted: { body: string; sessionId: string | undefined }[] = [];
  const runs: ReturnType<typeof fakeRun>[] = [];
  const cancelledAgents: string[] = [];
  const cancelledInputs: string[] = [];
  const closedSessions: string[] = [];
  let stops = 0;
  let nextSession = 0;
  let nextAgent = 0;
  const factory = async (boot: { workspace: string; requestPermission: PermissionRequestHandler; mcpServers?: readonly McpServerConfig[] | undefined }): Promise<EmbeddedSession> => {
    boots.push({ workspace: boot.workspace, mcpServers: boot.mcpServers });
    permissionHandlers.push(boot.requestPermission);
    const fake: Partial<EmbeddedSession> = {
      workspace: boot.workspace,
      url: 'http://127.0.0.1:0',
      submit: async (input: string | EmbeddedSessionInput): Promise<EmbeddedSubmission> => {
        const structured = typeof input === 'string' ? { body: input } : input;
        submitted.push({ body: structured.body, sessionId: structured.sessionId });
        const run = fakeRun(`agent-${++nextAgent}`);
        runs.push(run);
        await options.onSubmit?.(run);
        return {
          session: { id: structured.sessionId ?? 'unknown' },
          input: { id: `input-${nextAgent}` },
          activeAgentId: run.completion.agentId,
          mode: 'spawn',
          created: false,
          completion: run.completion,
        } as unknown as EmbeddedSubmission;
      },
      cancelActive: (agentIds) => {
        let count = 0;
        for (const id of agentIds) { cancelledAgents.push(id); count += 1; }
        return count;
      },
      sessions: {
        createSession: async () => ({ id: `shared-${++nextSession}` }),
        closeSession: async (id: string) => { closedSessions.push(id); return null; },
        cancelInput: async (sessionId: string, inputId: string) => { cancelledInputs.push(`${sessionId}:${inputId}`); return null; },
      } as unknown as EmbeddedSession['sessions'],
      stop: async () => { stops += 1; },
    };
    return fake as EmbeddedSession;
  };
  return {
    factory, boots, permissionHandlers, submitted, runs, cancelledAgents, cancelledInputs, closedSessions,
    stops: () => stops,
  };
}

const prompt = (sessionId: string, text = 'go') => ({ sessionId, prompt: [{ type: 'text' as const, text }] });

function permissionRequest(callId: string, agentId?: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'write_file',
    args: { path: 'x.ts' },
    category: 'write',
    analysis: { classification: 'write', riskLevel: 'medium', summary: 'write a file', reasons: [] },
    ...(agentId ? { attribution: { kind: 'background-agent', agentId } } : {}),
  } as PermissionPromptRequest;
}

describe('pure mappings', () => {
  test('promptText joins text blocks and resource links, skipping unsupported kinds', () => {
    expect(
      promptText([
        { type: 'text', text: 'fix the bug' },
        { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
      ]),
    ).toBe('fix the bug\n\nfile:///a.ts');
  });

  test('a run outcome maps to a stop reason and, when the stream did not say it, a line for the editor', () => {
    expect(stopReasonFor({ outcome: 'completed', agentId: 'a', output: 'done' })).toBe('end_turn');
    expect(stopReasonFor({ outcome: 'cancelled', reason: 'x' })).toBe('cancelled');
    expect(stopReasonFor({ outcome: 'failed', agentId: 'a', error: 'boom' })).toBe('refusal');
    expect(stopReasonFor({ outcome: 'not-started', state: 'queued', reason: 'busy' })).toBe('refusal');
    expect(outcomeText({ outcome: 'failed', agentId: 'a', error: 'no provider key configured' }, true)).toContain('no provider key configured');
    expect(outcomeText({ outcome: 'completed', agentId: 'a', output: 'final answer' }, false)).toBe('final answer');
    expect(outcomeText({ outcome: 'completed', agentId: 'a', output: 'final answer' }, true)).toBeNull();
  });

  test('mapPermissionOutcome maps selections and cancellation', () => {
    expect(mapPermissionOutcome({ outcome: 'selected', optionId: 'allow-once' })).toEqual({ approved: true });
    expect(mapPermissionOutcome({ outcome: 'selected', optionId: 'allow-always' })).toEqual({ approved: true, remember: true });
    expect(mapPermissionOutcome({ outcome: 'selected', optionId: 'reject-once' })).toEqual({ approved: false });
    expect(mapPermissionOutcome({ outcome: 'cancelled' })).toEqual({ approved: false });
  });
});

describe('initialize reports honest capabilities', () => {
  test('unsupported protocol features are false, session close is offered', async () => {
    const agent = new GoodVibesAcpAgent(makeConn().conn);
    const response = await agent.initialize({ protocolVersion: 1 });
    const capabilities = response.agentCapabilities!;
    expect(capabilities.loadSession).toBe(false);
    expect(capabilities.promptCapabilities).toEqual({ image: false, audio: false, embeddedContext: false });
    expect(capabilities.mcpCapabilities).toEqual({ http: false, sse: false });
    expect(capabilities.sessionCapabilities).toEqual({ close: {} });
    expect(response.authMethods).toEqual([]);
  });
});

describe('a prompt follows the run its input started', () => {
  test('text and tool calls stream, and the prompt ends when the run completes', async () => {
    const sub = makeSubstrate();
    const { conn, updates } = makeConn();
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: sub.factory });
    const { sessionId } = await agent.newSession({ cwd: '/work/project', mcpServers: [] });
    const pending = agent.prompt(prompt(sessionId, 'do the thing'));
    await waitFor(() => sub.runs.length > 0);
    const run = sub.runs[0]!;
    run.emit({ type: 'text', text: 'hello ' });
    run.emit({ type: 'tool-started', callId: 'c1', tool: 'read_file' });
    run.emit({ type: 'tool-settled', callId: 'c1', tool: 'read_file', ok: true });
    run.end({ outcome: 'completed', agentId: 'agent-1', output: 'hello world' });

    expect((await pending).stopReason).toBe('end_turn');
    expect(sub.submitted).toEqual([{ body: 'do the thing', sessionId: 'shared-1' }]);
    const kinds = updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update']);
    expect(updates[0]!.update.content?.text).toBe('hello ');
    expect(updates[2]!.update).toMatchObject({ toolCallId: 'c1', status: 'completed' });
  });

  test('a run that fails before submit returns still ends the prompt, and the editor is told why', async () => {
    const sub = makeSubstrate({ onSubmit: async (run) => { run.end({ outcome: 'failed', agentId: 'agent-1', error: 'no provider key configured' }); } });
    const { conn, updates } = makeConn();
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: sub.factory });
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    expect((await agent.prompt(prompt(sessionId))).stopReason).toBe('refusal');
    expect(updates.some((u) => (u.update.content?.text ?? '').includes('no provider key configured'))).toBe(true);
  });

  test('cancel ends the prompt as cancelled and aborts the agent and the queued input', async () => {
    const sub = makeSubstrate();
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const pending = agent.prompt(prompt(sessionId));
    await waitFor(() => sub.runs.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    await agent.cancel({ sessionId });
    expect((await pending).stopReason).toBe('cancelled');
    expect(sub.cancelledAgents).toEqual(['agent-1']);
    expect(sub.cancelledInputs).toEqual(['shared-1:input-1']);
  });

  test('a cancel during submit is applied once the submission names the agent', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sub = makeSubstrate({ onSubmit: () => held });
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const pending = agent.prompt(prompt(sessionId));
    await waitFor(() => sub.runs.length > 0);
    await agent.cancel({ sessionId });
    expect(sub.cancelledAgents).toEqual([]);
    release();
    expect((await pending).stopReason).toBe('cancelled');
    expect(sub.cancelledAgents).toEqual(['agent-1']);
  });

  test('a second prompt on a busy session is refused and the first still completes', async () => {
    const sub = makeSubstrate();
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const first = agent.prompt(prompt(sessionId));
    await expect(agent.prompt(prompt(sessionId))).rejects.toThrow('already has a prompt running');
    await waitFor(() => sub.runs.length > 0);
    sub.runs[0]!.end({ outcome: 'completed', agentId: 'agent-1', output: '' });
    expect((await first).stopReason).toBe('end_turn');
  });

  test('a client connection that rejects session updates does not produce an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const sub = makeSubstrate();
      const { conn } = makeConn({ sessionUpdate: async () => { throw new Error('connection closed'); } });
      const agent = new GoodVibesAcpAgent(conn, { sessionFactory: sub.factory });
      const { sessionId } = await agent.newSession({ cwd: '/w', mcpServers: [] });
      const pending = agent.prompt(prompt(sessionId));
      await waitFor(() => sub.runs.length > 0);
      sub.runs[0]!.emit({ type: 'text', text: 'hello' });
      sub.runs[0]!.end({ outcome: 'completed', agentId: 'agent-1', output: 'hello' });
      expect((await pending).stopReason).toBe('end_turn');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('one embedded session per ACP session', () => {
  test('each session holds its own embedded session in its cwd; closing it stops that one', async () => {
    const sub = makeSubstrate();
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    const a = await agent.newSession({ cwd: '/work/one', mcpServers: [] });
    const b = await agent.newSession({ cwd: '/work/one', mcpServers: [] });
    await agent.newSession({ cwd: '/work/two', mcpServers: [] });
    expect(sub.boots.map((boot) => boot.workspace)).toEqual(['/work/one', '/work/one', '/work/two']);

    await agent.closeSession({ sessionId: a.sessionId });
    expect(sub.stops()).toBe(1);
    await agent.closeSession({ sessionId: b.sessionId });
    expect(sub.stops()).toBe(2);
    expect(sub.closedSessions).toEqual(['shared-1', 'shared-2']);
    await expect(agent.prompt(prompt(a.sessionId))).rejects.toThrow('Unknown ACP session');
  });

  test('a permission ask is shown in the thread of the session it came from', async () => {
    const sub = makeSubstrate();
    const { conn, permissionRequests } = makeConn({ permissionOptionId: 'allow-always' });
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: sub.factory });
    const first = await agent.newSession({ cwd: '/w', mcpServers: [] });
    const second = await agent.newSession({ cwd: '/w', mcpServers: [] });

    const decision = await sub.permissionHandlers[1]!(permissionRequest('call-9', 'agent-1'));
    expect(decision).toEqual({ approved: true, remember: true });
    expect(permissionRequests[0]!.sessionId).toBe(second.sessionId);
    expect((permissionRequests[0]!.options as { kind: string }[]).map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    await sub.permissionHandlers[0]!(permissionRequest('call-10'));
    expect(permissionRequests[1]!.sessionId).toBe(first.sessionId);
  });

  test('dispose stops every embedded session', async () => {
    const sub = makeSubstrate();
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    await agent.newSession({ cwd: '/work/p4', mcpServers: [] });
    await agent.newSession({ cwd: '/work/p5', mcpServers: [] });
    await agent.dispose();
    expect(sub.stops()).toBe(2);
  });
});

describe('ACP MCP-server passthrough (session/new)', () => {
  test('translateAcpMcpServers keeps stdio servers and reports http/sse as unsupported', () => {
    const { configs, unsupported } = translateAcpMcpServers([
      { name: 'fs', command: '/usr/bin/mcp-fs', args: ['--root', '/w'], env: [{ name: 'TOKEN', value: 'x' }] },
      { type: 'http', name: 'remote', url: 'https://example.com/mcp' },
      { type: 'sse', name: 'events', url: 'https://example.com/sse' },
    ]);
    expect(configs).toEqual([
      { name: 'fs', command: '/usr/bin/mcp-fs', args: ['--root', '/w'], env: { TOKEN: 'x' } },
    ]);
    expect(unsupported).toEqual(['remote (http)', 'events (sse)']);
  });

  test('newSession threads declared stdio MCP servers into the embedded daemon', async () => {
    const sub = makeSubstrate();
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    await agent.newSession({ cwd: '/work/mcp', mcpServers: [{ name: 'fs', command: '/usr/bin/mcp-fs', args: [], env: [] }] } as never);
    expect(sub.boots[0]!.mcpServers).toEqual([{ name: 'fs', command: '/usr/bin/mcp-fs' }]);
  });

  test('newSession rejects an http/sse MCP server by name', async () => {
    const sub = makeSubstrate();
    const agent = new GoodVibesAcpAgent(makeConn().conn, { sessionFactory: sub.factory });
    await expect(agent.newSession({
      cwd: '/work/mcp2',
      mcpServers: [{ type: 'http', name: 'remote', url: 'https://x/mcp' }],
    } as never)).rejects.toThrow(/unsupported transport.*remote/);
  });
});
