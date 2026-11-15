/**
 * session-save-source.test.ts, who caused each save.
 *
 * The session-conversations retention sweep expires automatic saves and
 * spares ones the user explicitly asked for, which only works if the consumer
 * says which is which. The honest split:
 *
 *   'user', the operator directly asked for this file to exist: /save,
 *            /session save, /session fork, /session rename's backfill, and
 *            the crash-recovery restore they accepted in the startup modal.
 *   'auto', machinery: per-turn persistence and the write that closes a
 *            replayed journal gap (covered in core/session-resume-core.test.ts).
 *
 * Getting this backwards is silent and slow: a session the user deliberately
 * kept quietly disappears on a later sweep, and nothing points at the save
 * that failed to say so.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { SessionSurface } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { wireTurnEventHandlers, type WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { registerSessionContentCommands } from '../../input/commands/session-content.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-save-source');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function makeCtx(sm: SessionManager, printed: string[], seed: Array<{ role: string; content: string }> = [{ role: 'user', content: 'hello' }]): CommandContext {
  const conversation = new ConversationManager(() => 80);
  conversation.fromJSON({ messages: seed as never[], title: 'Working title', titleSource: 'auto' as never });
  conversation.rebuildHistory();
  return {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    session: {
      conversationManager: conversation,
      runtime: { sessionId: 'current-session', model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium' },
      sessionManager: sm,
    },
    workspace: {
      shellPaths: { workingDirectory: tmpDir, homeDirectory: tmpDir },
      surface,
    },
    platform: { configManager: { get: () => 'off', getCategory: () => ({}) } },
    clients: { providerApi: { selectModel: async (model: string) => ({ registryKey: model, providerId: 'p' }) } },
  } as unknown as CommandContext;
}

describe('user-directed saves are stamped as user saves', () => {
  test('/session save', async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];

    await handleSessionWorkflowCommand(['save', 'kept-by-hand'], makeCtx(sm, printed));

    expect(printed.join('\n')).toContain('Session saved');
    expect(sm.getMeta('kept-by-hand')?.saveSource).toBe('user');
  });

  test('/session fork', async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];

    await handleSessionWorkflowCommand(['fork', 'a-branch'], makeCtx(sm, printed));

    const forked = sm.list().find((s) => s.title === 'a-branch');
    expect(forked).toBeDefined();
    expect(sm.getMeta(forked!.name)?.saveSource).toBe('user');
  });

  test("/session rename's backfill save: naming a session is an act of curation", async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];
    // No file exists for 'current-session' yet, so rename materializes one.
    await handleSessionWorkflowCommand(['rename', 'a deliberate name'], makeCtx(sm, printed));

    expect(printed.join('\n')).toContain('Session renamed');
    const renamed = sm.list().find((s) => s.title === 'a deliberate name' || s.name.includes('deliberate'));
    expect(renamed).toBeDefined();
    expect(sm.getMeta(renamed!.name)?.saveSource).toBe('user');
    expect(sm.getMeta(renamed!.name)?.titleSource).toBe('user');
    const persisted = JSON.parse(readFileSync(renamed!.filePath, 'utf8').split('\n')[0]!);
    expect(persisted).toMatchObject({ title: 'a deliberate name', titleSource: 'user', model: 'm', provider: 'p', saveSource: 'user' });
    expect(sm.load(renamed!.name).messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'hello' }));
  });

  test('renaming an already saved session preserves its original transcript and metadata without recapturing the live conversation', async () => {
    const sm = new SessionManager(tmpDir, { surface }), ctx = makeCtx(sm, []);
    sm.save('current-session', [{ role: 'user', content: 'Original saved history' }], {
      title: 'Original title', titleSource: 'user', model: 'saved-model', provider: 'saved-provider', timestamp: 1234, saveSource: 'user',
    });
    const capture = spyOn(ctx.session.conversationManager, 'toJSON').mockImplementation(() => { throw new Error('Existing rename must not capture live history'); });
    try {
      await handleSessionWorkflowCommand(['rename', 'Renamed original'], ctx);
      expect(capture).not.toHaveBeenCalled();
      expect(sm.getMeta('current-session')).toMatchObject({ title: 'Renamed original', titleSource: 'user', model: 'saved-model', provider: 'saved-provider', timestamp: 1234, saveSource: 'user' });
      expect(sm.load('current-session').messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'Original saved history' }));
    } finally { capture.mockRestore(); }
  });
});

describe('the standalone /save command', () => {
  test('/save is the plainest "keep this" act there is, and says so', async () => {
    const sm = new SessionManager(tmpDir, { surface });
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);
    // /save also exports agent state alongside the conversation.
    (ctx as unknown as { ops: unknown }).ops = { agentManager: { exportState: () => [] } };

    const registry = new CommandRegistry();
    registerSessionContentCommands(registry);
    await registry.execute('save', ['saved-by-command'], ctx);

    expect(printed.join('\n')).toContain('Session saved');
    expect(sm.getMeta('saved-by-command')?.saveSource).toBe('user');
  });
});

describe('automatic persistence is stamped as automatic', () => {
  test('the save at the end of a turn is an automatic save', () => {
    const sm = new SessionManager(tmpDir, { surface });
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const bus = { on: (type: string, handler: (event: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), handler]); return () => {}; } };
    const conversation = new ConversationManager(() => 80);
    conversation.fromJSON({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] as never[], title: 'Turn title', titleSource: 'auto' as never });
    wireTurnEventHandlers({
      events: { turns: bus, tools: bus, agents: bus, contracts: bus } as unknown as WireTurnEventHandlersOptions['events'],
      conversation,
      runtime: { sessionId: 'per-turn-session', model: 'm', provider: 'p' },
      orchestrator: { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      configManager: { get: (): unknown => undefined },
      providerRegistry: {
        getCurrentModel: () => ({ contextWindow: 200_000, id: 'm' }),
        getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
      },
      systemMessageRouter: { high: () => {}, low: () => {}, routeSystemMessage: () => {} },
      hookDispatcher: { fire: async () => ({ ok: true }) } as unknown as WireTurnEventHandlersOptions['hookDispatcher'],
      surface,
      gitStatusProvider: { refresh: async () => null },
      lastGitInfoRef: { value: null },
      buildSessionContinuityHints: () => ({ pendingApprovals: 0 }),
      render: () => {},
      webhookNotifier: null,
      _clock: () => 0,
    });

    for (const handler of listeners.get('TURN_COMPLETED') ?? []) handler({ type: 'TURN_COMPLETED', turnId: 't1', response: 'hi', stopReason: 'completed' });

    expect(sm.getMeta('per-turn-session')?.saveSource).toBe('auto');
  });
});

test.each([{ args: [] }, { args: ['Finish', 'the', 'existing', 'review.'] }])('/retry preserves completed tool receipts while submitting the requested retry', async ({ args }) => {
  const sm = new SessionManager(tmpDir, { surface }), ctx = makeCtx(sm, []);
  const conversation = ctx.session.conversationManager;
  conversation.resetAll();
  conversation.addUserMessage('Review the repository and deliver review.md.');
  conversation.addAssistantMessage('', { toolCalls: [{ id: 'write-review', name: 'write', arguments: { path: 'review.md', content: 'Completed findings.' } }] });
  conversation.addToolResults([{ callId: 'write-review', success: true, output: 'Wrote review.md with completed findings.' }]);
  conversation.addSystemMessage('[Response cancelled]');
  const before = conversation.getMessageSnapshot();
  const submitted: string[] = [];
  ctx.submitInput = text => { submitted.push(text); };
  const registry = new CommandRegistry(); registerSessionContentCommands(registry);
  await registry.execute('retry', [...args], ctx);
  expect(submitted).toEqual([args.length ? args.join(' ') : 'Review the repository and deliver review.md.']);
  expect(conversation.getMessageSnapshot()).toEqual(before);
  expect(conversation.getMessageSnapshot().some(message => message.role === 'tool' && message.content.includes('completed findings'))).toBe(true);
});

for (const command of ['fork', 'save', 'resume'] as const) {
  test(`/session ${command} revokes pending native retry admission before changing session identity/history`, async () => {
    const { heldNativeRetry } = await import('../helpers/held-native-retry.ts');
    const native = await heldNativeRetry(); const result = native.start();
    const sm = new SessionManager(tmpDir, { surface }); const printed: string[] = [];
    sm.save('destination', [{ role: 'user', content: 'saved' }], { title: 'Destination', model: 'm', provider: 'p', timestamp: Date.now() });
    const ctx = makeCtx(sm, printed); let cancelled = 0;
    ctx.cancelPendingRecovery = () => {
      expect(ctx.session.runtime.sessionId).toBe('current-session');
      expect(ctx.session.conversationManager.getMessageCount()).toBe(1);
      cancelled++; return native.cancel();
    };
    try {
      await native.waiting; expect(native.orchestrator.isThinking).toBe(false);
      // The destination holds another conversation, so saving over it is confirmed.
      await handleSessionWorkflowCommand(command === 'save' ? [command, 'destination', '--yes'] : [command, 'destination'], ctx);
      expect(cancelled).toBe(1); expect(ctx.session.runtime.sessionId).not.toBe('current-session');
      native.release(); expect(await result).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' }, signalAborted: true, messageCount: 0 });
      expect(native.conversation.getMessageCount()).toBe(0);
    } finally { native.dispose(); await result; }
  });
}
