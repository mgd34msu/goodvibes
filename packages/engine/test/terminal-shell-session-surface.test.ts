import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { readConversationMessageSnapshots } from '../terminal-shell/src/conversation-message-snapshot.ts';
import { createConversationRewindPort, type RewindConversation } from '../terminal-shell/src/conversation-rewind-port.ts';
import { callDaemonMethod } from '../terminal-shell/src/raw-reply-route.ts';
import type { RemoteDaemonTarget } from '../terminal-shell/src/cluster-remote-daemon-target.ts';
import { FilePickerModal } from '../terminal-shell/src/file-picker.ts';
import { startFreshConversation, type FreshConversationContext } from '../terminal-shell/src/fresh-conversation.ts';
import { createHerdrSessionReporter, type HerdrSessionUpdate } from '../terminal-shell/src/herdr-session-reporter.ts';
import { createHostPairingStore } from '../terminal-shell/src/host-pairing-store.ts';
import { createHostedSessionRegistry } from '../terminal-shell/src/hosted-session-registry.ts';
import { InputHistory } from '../terminal-shell/src/input-history.ts';
import { createInteractionModeCommand } from '../terminal-shell/src/interaction-mode-command.ts';
import { handleKnowledgeMutationCommand } from '../terminal-shell/src/knowledge-mutation-command.ts';
import { handleKnowledgeReadCommand, type KnowledgeReadPorts } from '../terminal-shell/src/knowledge-read-command.ts';
import { KeybindingsManager } from '../terminal-shell/src/keybindings.ts';

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-shell-surface-'));
  chmodSync(dir, 0o700);
  return dir;
}

describe('saved message snapshots keep what the platform wrote', () => {
  test('a tool result keeps its outcome and host evidence', () => {
    const evidence = { reads: [{ path: '/a', bytes: 3 }] };
    const [message] = readConversationMessageSnapshots([
      { role: 'tool', callId: 'c1', content: 'boom', outcome: 'error', hostEvidence: evidence },
    ]);
    expect(message).toMatchObject({ role: 'tool', outcome: 'error', hostEvidence: evidence });
  });

  test('an unknown outcome rejects the message and an absent one stays absent', () => {
    expect(() => readConversationMessageSnapshots([{ role: 'tool', callId: 'c', content: 'x', outcome: 'weird' }])).toThrow(/index 0/);
    const [legacy] = readConversationMessageSnapshots([{ role: 'tool', callId: 'c', content: 'x' }]);
    expect(legacy).not.toHaveProperty('outcome');
  });

  test('a system notice keeps its runtime event', () => {
    const [message] = readConversationMessageSnapshots([
      { role: 'system', content: 'note', runtimeEvent: { type: 'X', occurrenceId: 'o1' } },
    ]);
    expect(message).toMatchObject({ role: 'system', runtimeEvent: { type: 'X', occurrenceId: 'o1' } });
  });
});

describe('/clear never drops a conversation it could not save', () => {
  function fixture(options: { sessionManager?: FreshConversationContext['session']['sessionManager']; failRecovery?: boolean }) {
    const saved: Array<{ id: string; messages: unknown[] }> = [];
    const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    let resets = 0;
    let abandoned = 0;
    const conversation = {
      getMessageSnapshot: () => messages,
      toJSON: () => ({ messages }),
      title: 'T',
      getTitleSource: () => 'user',
      branchState: () => undefined,
      resetAll: () => { resets += 1; },
      rebuildHistory: () => {},
    };
    const sessionManager = 'sessionManager' in options ? options.sessionManager : {
      save: (id: string, saveMessages: unknown[]) => { saved.push({ id, messages: saveMessages }); },
    };
    const ctx = {
      session: {
        conversationManager: conversation,
        sessionManager,
        runtime: { sessionId: 'live', model: 'm', provider: 'p', systemPrompt: '' },
      },
      cancelPendingRecovery: options.failRecovery ? () => { throw new Error('recovery failed'); } : undefined,
      abandonHostedSession: () => { abandoned += 1; },
    } as unknown as FreshConversationContext;
    return { ctx, saved, resets: () => resets, abandoned: () => abandoned };
  }

  test('without a session store it refuses and leaves the conversation alone', () => {
    const f = fixture({ sessionManager: undefined });
    expect(() => startFreshConversation(f.ctx)).toThrow(/no session store/);
    expect(f.resets()).toBe(0);
    expect(f.abandoned()).toBe(0);
  });

  test('a failure after the live session was saved empty puts the conversation back on disk', () => {
    const f = fixture({ failRecovery: true });
    expect(() => startFreshConversation(f.ctx)).toThrow('recovery failed');
    expect(f.resets()).toBe(0);
    const last = f.saved.at(-1);
    expect(last?.id).toBe('live');
    expect(last?.messages).toHaveLength(2);
  });

  test('a successful clear tells the host to let go of its hosted session', () => {
    const f = fixture({});
    const result = startFreshConversation(f.ctx);
    expect(result.savedAs).toMatch(/^user-/);
    expect(f.resets()).toBe(1);
    expect(f.abandoned()).toBe(1);
  });
});

describe('host pairing attempts can be cleared exactly', () => {
  const store = createHostPairingStore({
    unavailableReason: 'unavailable',
    surfaceRoot: 'test',
    directory: 'creds',
    filename: 'credentials.json',
    strictOrigin: true,
  });
  const HOST = 'https://host.example';
  const attempt = { attemptId: 'attempt-1', name: 'laptop', startedAt: 1 };

  test('an unresolved attempt blocks a new one until it is cleared by its own id', async () => {
    const home = scratchDir();
    expect((await store.beginHostPairing(home, HOST, attempt)).status).toBe('begun');
    expect((await store.beginHostPairing(home, HOST, { ...attempt, attemptId: 'attempt-2' })).status).toBe('conflict');

    expect((await store.clearHostPairingAttempt(home, HOST, 'someone-else')).status).toBe('conflict');
    expect(store.readHostPairing(home, HOST).status).toBe('unknown');

    expect((await store.clearHostPairingAttempt(home, HOST, 'attempt-1')).status).toBe('cleared');
    expect(store.readHostPairing(home, HOST).status).toBe('missing');
    expect((await store.beginHostPairing(home, HOST, { ...attempt, attemptId: 'attempt-3' })).status).toBe('begun');
  });

  test('a completed pairing is never cleared', async () => {
    const home = scratchDir();
    await store.beginHostPairing(home, HOST, attempt);
    const secret = { token: 'gvp_token', tokenId: 'pair-1', name: 'laptop', createdAt: 2 };
    expect((await store.completeHostPairing(home, HOST, 'attempt-1', secret)).status).toBe('paired');
    expect((await store.clearHostPairingAttempt(home, HOST, 'attempt-1')).status).toBe('conflict');
    expect(store.readHostPairing(home, HOST).status).toBe('paired');
  });

  test('a saved credential is forgotten only by its own token id, and the host can then be paired again', async () => {
    const home = scratchDir();
    await store.beginHostPairing(home, HOST, attempt);
    await store.completeHostPairing(home, HOST, 'attempt-1', { token: 'gvp_token', tokenId: 'pair-1', name: 'laptop', createdAt: 2 });
    expect((await store.removeHostPairing(home, HOST, 'pair-other')).status).toBe('conflict');
    expect(store.readHostPairing(home, HOST).status).toBe('paired');
    expect((await store.removeHostPairing(home, HOST, 'pair-1')).status).toBe('removed');
    expect(store.readHostPairing(home, HOST).status).toBe('missing');
    expect((await store.beginHostPairing(home, HOST, { ...attempt, attemptId: 'attempt-2' })).status).toBe('begun');
  });
});

describe('a daemon call keeps a verb\'s own refusal', () => {
  const LOCAL: RemoteDaemonTarget = { baseUrl: 'http://127.0.0.1:3421', token: 't', isLocal: true };

  test("a handler's own 404 keeps its message instead of blaming the daemon build", async () => {
    const fetchImpl = async () => Response.json({ error: 'No session x', code: 'SESSION_NOT_FOUND' }, { status: 404 });
    const outcome = await callDaemonMethod(LOCAL, 'sessions.hosted.kill', { input: { sessionId: 'x' } }, fetchImpl);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.code).toBe('refused');
    expect(outcome.error).toContain('No session x');
  });

  test('an unknown verb is a missing route', async () => {
    const fetchImpl = async () => Response.json({ error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, { status: 404 });
    const outcome = await callDaemonMethod(LOCAL, 'sessions.hosted.kill', { input: { sessionId: 'x' } }, fetchImpl);
    expect(outcome.ok === false && outcome.code).toBe('route-missing');
  });
});

describe('the hosted session registry follows turns to their end', () => {
  function bus() {
    const handlers = new Map<string, Array<(envelope: unknown) => void>>();
    return {
      on: (type: string, callback: (envelope: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), callback]);
        return () => {};
      },
      emit(type: string, payload: Record<string, unknown>, sessionId?: string) {
        for (const callback of handlers.get(type) ?? []) callback({ sessionId, payload: { type, ...payload } });
      },
    };
  }
  const registryOn = (b: ReturnType<typeof bus>) => createHostedSessionRegistry(b as unknown as Parameters<typeof createHostedSessionRegistry>[0]);

  test('a turn that ends only with a preflight failure frees the session', () => {
    const b = bus();
    const registry = registryOn(b);
    registry.adopt('s1');
    b.emit('TURN_SUBMITTED', { turnId: 'T', prompt: 'p' }, 's1');
    expect(registry.countBusySessions()).toBe(1);
    b.emit('PREFLIGHT_FAIL', { turnId: 'T', reason: 'too big', stopReason: 'context_overflow' }, 's1');
    expect(registry.countBusySessions()).toBe(0);
  });

  test('a preflight failure for a turn never seen submitted leaves the running turn busy', () => {
    const b = bus();
    const registry = registryOn(b);
    registry.adopt('s1');
    b.emit('TURN_SUBMITTED', { turnId: 'T', prompt: 'p' }, 's1');
    b.emit('PREFLIGHT_FAIL', { turnId: 'duplicate', reason: 'busy', stopReason: 'preflight_failed' }, 's1');
    expect(registry.countBusySessions()).toBe(1);
  });

  test('an unattributed terminal event does not idle every other session', () => {
    const b = bus();
    const registry = registryOn(b);
    registry.adopt('s1');
    registry.adopt('s2');
    b.emit('TURN_SUBMITTED', { turnId: 'T1', prompt: 'p' }, 's1');
    b.emit('TURN_SUBMITTED', { turnId: 'T2', prompt: 'p' }, 's2');
    b.emit('TURN_COMPLETED', { turnId: 'unknown' });
    expect(registry.countBusySessions()).toBe(2);
    b.emit('TURN_COMPLETED', { turnId: 'T1' });
    expect(registry.countBusySessions()).toBe(1);
  });
});

describe('the Herdr reporter keeps the newest state when a report fails', () => {
  const environment = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/bin/herdr', HERDR_SOCKET_PATH: '/sock' };
  const update = (busy: boolean): HerdrSessionUpdate => ({ sessionId: 's', busy, waitingForOwner: false, resumeArgv: ['goodvibes', '--resume', 's'] });
  const stateOf = (argv: readonly string[]) => argv[argv.indexOf('--state') + 1];

  test('a state that arrived while a report was failing is sent afterwards', async () => {
    const reported: string[] = [];
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const firstReportStarted = new Promise<void>((resolve) => { started = resolve; });
    let failedOnce = false;
    const reporter = createHerdrSessionReporter({
      environment,
      transport: async (argv) => {
        if (argv[0] === '--version') return 'herdr 0.9.3';
        if (argv[1] !== 'report-agent') return;
        if (!failedOnce) {
          failedOnce = true;
          started?.();
          await new Promise<void>((resolve) => { release = resolve; });
          throw new Error('transport down');
        }
        reported.push(stateOf(argv) ?? '');
      },
    });
    const first = reporter.update(update(true));
    await firstReportStarted;
    const second = reporter.update(update(false));
    release?.();
    await Promise.all([first, second]);
    expect(reported).toEqual(['idle']);
    await reporter.close();
  });
});

describe('input history keeps secrets and other terminals out of the way', () => {
  test('passwords and tokens typed into secret-taking commands never reach the file', () => {
    const path = join(scratchDir(), 'history.json');
    const history = new InputHistory({ historyPath: path, persist: true });
    history.add('/login service daemon http://h alice hunter2');
    history.add('/auth login listener http://h bob s3cret mykey');
    history.add('/cloudflare create-token --account a --bootstrap-token cf_abc --operator-token=op_xyz');
    history.add('/auth local revoke-session sess_tok_123');
    history.add('/cloudflare status --token-ref MY_REF');
    const raw = readFileSync(path, 'utf-8');
    for (const secret of ['hunter2', 's3cret', 'cf_abc', 'op_xyz', 'sess_tok_123']) expect(raw).not.toContain(secret);
    expect(raw).toContain('--token-ref MY_REF');
    expect(raw).toContain('/login service daemon http://h alice <redacted>');
  });

  test('the expanded prompt of an injected file stays out of the file but recalls in this session', () => {
    const path = join(scratchDir(), 'history.json');
    const history = new InputHistory({ historyPath: path, persist: true });
    history.add('explain !@.env', { recallText: 'explain API_KEY=abc123' });
    expect(readFileSync(path, 'utf-8')).not.toContain('abc123');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(['explain !@.env']);
    expect(history.up('')).toBe('explain API_KEY=abc123');
  });

  test('two terminals adding entries both keep them', () => {
    const path = join(scratchDir(), 'history.json');
    const a = new InputHistory({ historyPath: path, persist: true });
    const b = new InputHistory({ historyPath: path, persist: true });
    a.add('from a');
    b.add('from b');
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as string[];
    expect(onDisk).toContain('from a');
    expect(onDisk).toContain('from b');
  });

  test('an unreadable history file is kept as a .bad copy before it is replaced', () => {
    const path = join(scratchDir(), 'history.json');
    writeFileSync(path, '{not json', 'utf-8');
    const history = new InputHistory({ historyPath: path, persist: true });
    history.add('fresh');
    expect(readFileSync(`${path}.bad`, 'utf-8')).toBe('{not json');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(['fresh']);
  });
});

describe('keybinding and mode feedback', () => {
  const catalog = {
    surfaceRoot: 'test',
    defaults: { quit: [{ key: 'q', ctrl: true }] },
    descriptions: { quit: 'Quit' },
  } as const;

  test('an override for an unknown action is reported', () => {
    const path = join(scratchDir(), 'keybindings.json');
    writeFileSync(path, JSON.stringify({ quit: { key: 'x', ctrl: true }, nonsense: { key: 'y' } }));
    const manager = new KeybindingsManager({ configPath: path }, catalog);
    const notices = manager.loadFromDisk();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('nonsense');
    expect(manager.matches('quit', { logicalName: 'x', ctrl: true })).toBe(true);
  });

  test('deleting the file returns to the defaults', () => {
    const path = join(scratchDir(), 'keybindings.json');
    writeFileSync(path, JSON.stringify({ quit: { key: 'x', ctrl: true } }));
    const manager = new KeybindingsManager({ configPath: path }, catalog);
    manager.loadFromDisk();
    expect(manager.matches('quit', { logicalName: 'x', ctrl: true })).toBe(true);
    rmSync(path);
    expect(manager.loadFromDisk()).toEqual([]);
    expect(manager.matches('quit', { logicalName: 'x', ctrl: true })).toBe(false);
    expect(manager.matches('quit', { logicalName: 'q', ctrl: true })).toBe(true);
  });

  test('/mode says when the new mode could not be saved', () => {
    const printed: string[] = [];
    const command = createInteractionModeCommand({
      description: 'd', usage: 'u', argsHint: 'a', confirmMutations: false, help: 'h',
      invalidVerbosity: (v) => v, domainSet: (d, v) => `${d}${v}`,
    });
    const preset = { name: 'quiet', description: 'Quiet mode' };
    const ctx = {
      ops: { modeManager: { setHITLMode: () => {}, getHITLPreset: () => preset } },
      platform: { configManager: { setDynamic: () => { throw new Error('disk full'); } } },
      print: (text: string) => { printed.push(text); },
      renderRequest: () => {},
    };
    void command.handler(['quiet'], ctx as never);
    expect(printed.join('\n')).toContain('could not be saved');
    expect(printed.join('\n')).toContain('disk full');
  });
});

describe('knowledge commands behave the same for every verb', () => {
  const staleError = new Error('session changed');
  const readPorts = (): KnowledgeReadPorts => ({
    status: async () => ({ ready: true, storagePath: '/s', sourceCount: 1, nodeCount: 1, edgeCount: 1, issueCount: 1 }),
    lint: async () => [{ id: 'i', severity: 'warn', code: 'C', message: 'm' }],
    candidates: () => [{ id: 'c', status: 's', score: 1, title: 't', candidateType: 'x' }],
    reports: () => [{ id: 'r', kind: 'k', title: 't', summary: 's' }],
    schedules: () => [{ id: 'sc', enabled: true, jobId: 'j', label: 'l' }],
    packet: async () => 'packet text',
    nodes: async () => [], issues: async () => [], sources: async () => [], search: async () => [], get: async () => null,
    assertCurrent: () => { throw staleError; },
  } as unknown as KnowledgeReadPorts);
  const presentation = { statusTitle: 'T', headingSuffix: ':', fieldSeparator: ': ', scoreSeparator: '=', nodeKind: 'kind' };

  test.each(['status', 'lint', 'candidates', 'reports', 'schedules', 'packet', 'explain'])('%s prints nothing once the session has changed', async (sub) => {
    const printed: string[] = [];
    await expect(handleKnowledgeReadCommand(sub, ['task'], (text) => printed.push(text), readPorts(), presentation)).rejects.toThrow('session changed');
    expect(printed).toEqual([]);
  });

  const mutationPorts = {
    reindex: async () => { throw new Error('index locked'); },
    run: async () => ({ id: 'run', status: 'ok' }),
    allow: () => true,
    describeError: (error: unknown) => (error as Error).message,
    sessionId: () => 's',
  };
  const mutationPresentation = { fieldSeparator: ': ', reviewer: 'me', confirmationSuffix: '', sourceLabel: 'source' };

  test('a failing mutation prints its error instead of throwing', async () => {
    const printed: string[] = [];
    const handled = await handleKnowledgeMutationCommand('reindex', [], (t) => printed.push(t), mutationPorts as never, mutationPresentation);
    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('index locked');
  });

  test('reindex names every source it could not recompile instead of reporting complete', async () => {
    const printed: string[] = [];
    const status = { sourceCount: 3, nodeCount: 4, edgeCount: 5, issueCount: 1 };
    const ports = { ...mutationPorts, reindex: async () => ({ status, issues: [], recompileFailures: [{ sourceId: 'source-bad', error: 'store unavailable' }] }) };
    await handleKnowledgeMutationCommand('reindex', [], (t) => printed.push(t), ports as never, mutationPresentation);
    const text = printed.join('\n');
    expect(text).not.toContain('Reindex complete');
    expect(text).toContain('1 source not recompiled');
    expect(text).toContain('source-bad - store unavailable');
  });

  test('reindex with no failures reports complete', async () => {
    const printed: string[] = [];
    const status = { sourceCount: 3, nodeCount: 4, edgeCount: 5, issueCount: 1 };
    const ports = { ...mutationPorts, reindex: async () => ({ status, issues: [] }) };
    await handleKnowledgeMutationCommand('reindex', [], (t) => printed.push(t), ports as never, mutationPresentation);
    expect(printed.join('\n')).toContain('Reindex complete');
  });

  test('consolidate refuses a mode it does not know instead of running the light job', async () => {
    const printed: string[] = [];
    let ran = false;
    const ports = { ...mutationPorts, run: async () => { ran = true; return { id: 'r', status: 'ok' }; } };
    await handleKnowledgeMutationCommand('consolidate', ['dep'], (t) => printed.push(t), ports as never, mutationPresentation);
    expect(ran).toBe(false);
    expect(printed.join('\n')).toContain('Unknown consolidation mode');
  });
});

describe('the file picker recovers when its cache is invalidated while open', () => {
  let previous: ReturnType<typeof installJudgmentPort> | undefined;
  afterEach(() => { if (previous) installJudgmentPort(previous); previous = undefined; });

  test('the open picker reloads instead of sitting empty', async () => {
    const root = scratchDir();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), '');
    previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    const picker = new FilePickerModal({ workingDirectory: root });
    const listed = () => new Promise<void>((resolve) => {
      const check = () => { if (picker.results.length > 0) resolve(); };
      picker.setOnUpdate(check);
      check();
    });
    picker.open(0);
    await listed();
    expect(picker.results).toContain('src/a.ts');
    picker.invalidateCache();
    expect(picker.results).toEqual([]);
    await listed();
    expect(picker.results).toContain('src/a.ts');
  });
});

describe('conversation rewind port refuses what it cannot place', () => {
  function conversation(count: number) {
    let messages = Array.from({ length: count }, (_, index) => `m${index}`);
    const port: RewindConversation = {
      getMessageCount: () => messages.length,
      toJSON: () => [...messages] as unknown as ReturnType<RewindConversation['toJSON']>,
      fromJSON(value) { messages = [...(value as unknown as string[])]; },
      rebuildHistory: () => {},
      removeMessagesAfter: (keep) => { messages = messages.slice(0, keep); },
    };
    return { port, count: () => messages.length };
  }

  test('a turn with no recorded boundary is unavailable, not a successful rewind of zero messages', async () => {
    const fixture = conversation(10);
    const port = createConversationRewindPort(() => fixture.port);
    const preview = await port.preview({ sessionId: 'unrecorded', turnId: 't-unknown' });
    expect(preview.available).toBe(false);
    expect(preview.unavailableReason).toContain('t-unknown');
    const outcome = await port.rewind({ sessionId: 'unrecorded', turnId: 't-unknown' });
    expect(outcome.available).toBe(false);
    expect(fixture.count()).toBe(10);
  });

  test('no turn id still means the latest turn and drops nothing', async () => {
    const fixture = conversation(10);
    const port = createConversationRewindPort(() => fixture.port);
    expect((await port.preview({ sessionId: 'unrecorded' })).available).not.toBe(false);
  });

  test('only the newest rewinds stay undoable', async () => {
    const session = 'bounded-rewinds';
    const fixture = conversation(4);
    const port = createConversationRewindPort(() => fixture.port);
    recordTurnAnchor(session, { turnId: 't', label: 'x', messageCount: 2, at: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await port.rewind({ sessionId: session, turnId: 't' })).undoSnapshotId);
    clearTurnAnchors(session);
    expect(port.restoreBefore(ids[0] as string)).toBe(false);
    expect(port.messagesSinceRewind(ids[0] as string)).toBeNull();
    expect(port.restoreBefore(ids[39] as string)).toBe(true);
  });
});
