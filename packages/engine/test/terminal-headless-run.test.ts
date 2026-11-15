import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeadlessPermissionInput, extractHeadlessRunFlags, headlessRunFlagErrors, observeHeadlessTurn } from '../terminal-shell/src/native/headless-turn-events.ts';
import { executeNativeHeadless, nativeHeadlessFailureCause, runWithHeadlessTimeout, writeNativeHeadlessResult } from '../terminal-shell/src/native/native-headless.ts';
import { NativeIntakeJournalError } from '../terminal-shell/src/native/native-conversation-intake-journal.ts';
import { NativeIntakeFailure } from '../terminal-shell/src/native/native-conversation-intake.ts';
import { NativeHostSelectionChangedError } from '../terminal-shell/src/native/native-host-fetch.ts';

type Listener = (envelope: { payload: Record<string, unknown>; source: string }) => void;
function fakeBus() {
  const listeners = new Map<string, Listener>();
  return {
    bus: { on: (type: string, listener: Listener) => { listeners.set(type, listener); return () => { listeners.delete(type); }; } },
    emit: (type: string, payload: Record<string, unknown>, source = 'orchestrator') => listeners.get(type)?.({ payload: { type, ...payload }, source }),
  };
}

const realWrite = process.stdout.write.bind(process.stdout);
afterEach(() => { process.stdout.write = realWrite; });
function captureStdout(): unknown[] {
  const frames: unknown[] = [];
  process.stdout.write = ((chunk: string) => { frames.push(JSON.parse(chunk)); return true; }) as typeof process.stdout.write;
  return frames;
}

const runtime = { sessionId: 'session-1', model: 'model', provider: 'provider' };
const response = (toolCallCount: number, extra: Record<string, unknown> = {}) => ({ turnId: 't', provider: 'provider', model: 'model', toolCallCount,
  inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, costUsdCents: 2, contentSummary: '', ...extra });

describe('headless stream-json frames', () => {
  test('tool, permission and usage events become versioned frames without tool arguments', () => {
    const { bus, emit } = fakeBus(); const frames = captureStdout();
    const observer = observeHeadlessTurn(bus as never, 'stream-json', 'unsettled', { omitAccumulated: true });
    emit('STREAM_DELTA', { turnId: 't', content: 'Hel', accumulated: 'Hel' });
    emit('GATE_REQUESTED', { callId: 'c1', tool: 'write', args: { content: 'secret file body' }, category: 'write', summary: 'write a.ts' });
    emit('DECISION_EMITTED', { callId: 'c1', tool: 'write', category: 'write', approved: true, source: 'preset' });
    emit('TOOL_EXECUTING', { turnId: 't', callId: 'c1', tool: 'write', startedAt: 1 });
    emit('TOOL_FAILED', { turnId: 't', callId: 'c1', tool: 'write', durationMs: 3, error: 'denied' });
    emit('LLM_RESPONSE_RECEIVED', response(0));
    emit('TURN_COMPLETED', { turnId: 't', response: 'Hello', stopReason: 'completed' });
    observer.dispose();
    expect(frames).toEqual([
      { schemaVersion: 1, type: 'STREAM_DELTA', content: 'Hel' },
      { schemaVersion: 1, type: 'PERMISSION_REQUESTED', callId: 'c1', tool: 'write', category: 'write', summary: 'write a.ts', ownerPrompt: false },
      { schemaVersion: 1, type: 'PERMISSION_DECIDED', callId: 'c1', tool: 'write', category: 'write', approved: true, source: 'preset', ownerPrompt: false },
      { schemaVersion: 1, type: 'TOOL_EXECUTING', turnId: 't', callId: 'c1', tool: 'write' },
      { schemaVersion: 1, type: 'TOOL_FAILED', turnId: 't', callId: 'c1', tool: 'write', durationMs: 3, error: 'denied' },
      { schemaVersion: 1, type: 'USAGE', turnId: 't', provider: 'provider', model: 'model', inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, costUsdCents: 2 },
    ]);
    expect(JSON.stringify(frames)).not.toContain('secret file body');
    expect(observer.result(new AbortController().signal, runtime)).toMatchObject({ exitCode: 0, response: 'Hello', sessionId: 'session-1',
      usage: { modelCalls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, costUsdCents: 2 } });
  });

  test('a gated call the owner was asked about says so on both permission frames', () => {
    const { bus, emit } = fakeBus(); const frames = captureStdout();
    const observer = observeHeadlessTurn(bus as never, 'stream-json', 'unsettled');
    emit('GATE_REQUESTED', { callId: 'c1', tool: 'bash', args: {}, category: 'exec' });
    emit('DECISION_EMITTED', { callId: 'c1', tool: 'bash', category: 'exec', approved: false, source: 'permission-manager', sourceLayer: 'user_prompt', reasonCode: 'user_denied' });
    observer.dispose();
    expect(frames).toEqual([
      { schemaVersion: 1, type: 'PERMISSION_REQUESTED', callId: 'c1', tool: 'bash', category: 'exec', ownerPrompt: true },
      { schemaVersion: 1, type: 'PERMISSION_DECIDED', callId: 'c1', tool: 'bash', category: 'exec', approved: false, source: 'permission-manager', ownerPrompt: true, reasonCode: 'user_denied' },
    ]);
  });

  test('a gate request that is never decided is still reported, with no claim about the owner', () => {
    const { bus, emit } = fakeBus(); const frames = captureStdout();
    const observer = observeHeadlessTurn(bus as never, 'stream-json', 'unsettled');
    emit('GATE_REQUESTED', { callId: 'c9', tool: 'bash', args: {}, category: 'exec' });
    expect(frames).toEqual([]);
    observer.dispose();
    expect(frames).toEqual([{ schemaVersion: 1, type: 'PERMISSION_REQUESTED', callId: 'c9', tool: 'bash', category: 'exec' }]);
  });

  test('deltas keep accumulated by default', () => {
    const { bus, emit } = fakeBus(); const frames = captureStdout();
    const observer = observeHeadlessTurn(bus as never, 'stream-json', 'unsettled');
    emit('STREAM_DELTA', { turnId: 't', content: 'lo', accumulated: 'Hello' });
    observer.dispose();
    expect(frames).toEqual([{ schemaVersion: 1, type: 'STREAM_DELTA', content: 'lo', accumulated: 'Hello' }]);
  });

  test('--max-turns stops a model that still wants tools and reports max_turns, not a cancellation', () => {
    const { bus, emit } = fakeBus(); let stops = 0;
    const observer = observeHeadlessTurn(bus as never, 'json', 'unsettled', { maxTurns: 2, stop: () => { stops++; } });
    emit('LLM_RESPONSE_RECEIVED', response(1));
    expect(stops).toBe(0);
    emit('LLM_RESPONSE_RECEIVED', response(2, { costUsdCents: undefined }));
    emit('TURN_CANCEL', { turnId: 't', stopReason: 'cancelled' });
    expect(stops).toBe(1);
    const result = observer.result(new AbortController().signal, runtime);
    expect(result).toMatchObject({ exitCode: 1, stopReason: 'max_turns', usage: { modelCalls: 2, inputTokens: 200 } });
    expect(result.error).toContain('--max-turns 2');
    expect(result.usage?.costUsdCents).toBeUndefined();
  });
});

describe('headless agent and contract frames', () => {
  test('delegated agents and contracts become frames with identifiers, states and outcomes, never task text', () => {
    const { bus, emit } = fakeBus(); const frames = captureStdout();
    const observer = observeHeadlessTurn(bus as never, 'stream-json', 'unsettled');
    emit('AGENT_SPAWNING', { agentId: 'a1', task: 'read /home/x/.ssh/id_rsa and report', parentAgentId: 'a0', contractId: 'c1', contractRole: 'unit' }, 'agent-orchestrator');
    emit('AGENT_COMPLETED', { agentId: 'a1', durationMs: 40, output: 'secret output', toolCallsMade: 3 }, 'agent-orchestrator');
    emit('CONTRACT_ESCALATED', { contractId: 'c1', escalationId: 'e1', scope: 'unit', targetId: 'u1', reason: 'owner-decision-needed', question: 'Retry or cancel?', unmetCriterionIds: [] });
    emit('CONTRACT_STATUS_CHANGED', { contractId: 'c1', from: 'running', to: 'awaiting-owner' });
    observer.dispose();
    expect(frames).toEqual([
      { schemaVersion: 1, type: 'AGENT_SPAWNING', agentId: 'a1', parentAgentId: 'a0', contractId: 'c1', contractRole: 'unit' },
      { schemaVersion: 1, type: 'AGENT_COMPLETED', agentId: 'a1', durationMs: 40, toolCallsMade: 3 },
      { schemaVersion: 1, type: 'CONTRACT_ESCALATED', contractId: 'c1', escalationId: 'e1', scope: 'unit', targetId: 'u1', reason: 'owner-decision-needed', question: 'Retry or cancel?' },
      { schemaVersion: 1, type: 'CONTRACT_STATUS_CHANGED', contractId: 'c1', from: 'running', to: 'awaiting-owner' },
    ]);
    expect(JSON.stringify(frames)).not.toContain('id_rsa');
    expect(JSON.stringify(frames)).not.toContain('secret output');
  });
});

function fakeInput() {
  const listeners = { data: new Set<(chunk: string) => void>(), end: new Set<() => void>(), close: new Set<() => void>() };
  return {
    source: {
      on: (event: 'data' | 'end' | 'close', listener: never) => { (listeners[event] as Set<unknown>).add(listener); },
      off: (event: 'data' | 'end' | 'close', listener: never) => { (listeners[event] as Set<unknown>).delete(listener); },
    },
    write: (text: string) => { for (const listener of listeners.data) listener(text); },
    end: () => { for (const listener of listeners.end) listener(); },
    listenerCount: () => listeners.data.size + listeners.end.size + listeners.close.size,
  };
}
const promptRequest = (callId: string) => ({ callId, tool: 'bash', args: { content: 'secret file body' }, category: 'exec',
  analysis: { classification: 'exec', riskLevel: 'high', summary: 'run rm -rf x', reasons: [] } }) as never;

describe('answering permission prompts from stdin', () => {
  test('a prompt frame names the call and a PERMISSION_ANSWER line decides it, without the arguments', async () => {
    const input = fakeInput(); const frames: Record<string, unknown>[] = [];
    const answers = createHeadlessPermissionInput({ input: input.source as never, emit: (frame) => frames.push(frame), signal: new AbortController().signal });
    const decision = answers.prompt(promptRequest('call-1'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'PERMISSION_PROMPT', callId: 'call-1', tool: 'bash', category: 'exec', riskLevel: 'high', summary: 'run rm -rf x' });
    expect(JSON.stringify(frames)).not.toContain('secret file body');
    input.write('not json\n{"type":"OTHER"}\n{"type":"PERMISSION_ANSWER","callId":"call-1","approved":true,"remember":true}\n');
    expect(await decision).toEqual({ approved: true, remember: true });
    answers.dispose();
    expect(input.listenerCount()).toBe(0);
  });

  test('an answer split across chunks, with a note, refuses with the note', async () => {
    const input = fakeInput();
    const answers = createHeadlessPermissionInput({ input: input.source as never, emit: () => {}, signal: new AbortController().signal });
    const decision = answers.prompt(promptRequest('c2'));
    input.write('{"type":"PERMISSION_ANSWER","callId":"c2",');
    input.write('"approved":false,"note":"use a dry run"}\n');
    expect(await decision).toEqual({ approved: false, remember: false, reason: 'use a dry run' });
  });

  test('an answer for another call does not decide this one', async () => {
    const input = fakeInput();
    const answers = createHeadlessPermissionInput({ input: input.source as never, emit: () => {}, signal: new AbortController().signal });
    const decision = answers.prompt(promptRequest('c3'));
    input.write('{"type":"PERMISSION_ANSWER","callId":"other","approved":true}\n');
    input.end();
    expect(await decision).toMatchObject({ approved: false });
  });

  test('stdin ending refuses what is pending and every later prompt, naming the call', async () => {
    const input = fakeInput();
    const answers = createHeadlessPermissionInput({ input: input.source as never, emit: () => {}, signal: new AbortController().signal });
    const first = answers.prompt(promptRequest('c4'));
    input.end();
    const refused = await first;
    expect(refused.approved).toBe(false);
    expect(refused.reason).toContain('c4');
    expect((await answers.prompt(promptRequest('c5'))).reason).toContain('c5');
  });

  test('cancelling the run refuses a waiting prompt', async () => {
    const input = fakeInput(); const abort = new AbortController();
    const answers = createHeadlessPermissionInput({ input: input.source as never, emit: () => {}, signal: abort.signal });
    const decision = answers.prompt(promptRequest('c6'));
    abort.abort();
    expect(await decision).toMatchObject({ approved: false });
  });
});

describe('--max-turns', () => {
  test('counts only the top-level turn loop, while usage still sums every model call', () => {
    const { bus, emit } = fakeBus(); let stops = 0;
    const observer = observeHeadlessTurn(bus as never, 'json', 'unsettled', { maxTurns: 2, stop: () => { stops++; } });
    emit('LLM_RESPONSE_RECEIVED', response(1));
    // Delegated agents and helper models answer inside the same process and must not spend the caller's turns.
    emit('LLM_RESPONSE_RECEIVED', response(3), 'agent-orchestrator');
    emit('LLM_RESPONSE_RECEIVED', response(0), 'helper-model');
    emit('LLM_RESPONSE_RECEIVED', response(2), 'agent-orchestrator');
    expect(stops).toBe(0);
    emit('LLM_RESPONSE_RECEIVED', response(1));
    expect(stops).toBe(1);
    const result = observer.result(new AbortController().signal, runtime);
    expect(result).toMatchObject({ stopReason: 'max_turns', usage: { modelCalls: 5 } });
    expect(result.error).toContain('Stopped after 2 model responses');
  });
});

describe('headless final frame', () => {
  test('json and stream-json add schemaVersion, sessionId and usage and keep every existing field', () => {
    const lines: string[] = [];
    writeNativeHeadlessResult({ exitCode: 0, response: 'answer', stopReason: 'completed', sessionId: 's', model: 'm', provider: 'p', events: 4,
      usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 'stream-json', (line) => lines.push(line));
    writeNativeHeadlessResult({ exitCode: 1, response: '', error: 'Host unavailable.', stopReason: 'native-unavailable', kind: 'unavailable' }, 'json', (line) => lines.push(line));
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'TURN_RESULT', schemaVersion: 1, ok: true, response: 'answer', stopReason: 'completed', sessionId: 's',
      model: 'm', provider: 'p', events: 4, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(JSON.parse(lines[1]!)).toEqual({ schemaVersion: 1, ok: false, response: '', error: 'Host unavailable.', stopReason: 'native-unavailable',
      kind: 'unavailable', sessionId: null, usage: null });
  });

  test('text mode writes the answer to stdout and errors to stderr', () => {
    const out: string[] = []; const err: string[] = [];
    writeNativeHeadlessResult({ exitCode: 1, response: 'partial', error: 'Delegated work did not complete.', stopReason: 'contract-failed', sessionId: 's' },
      'text', (line) => out.push(line), false, (line) => err.push(line));
    writeNativeHeadlessResult({ exitCode: 1, response: 'Native host is unavailable.', stopReason: 'native-unavailable' }, 'text', (line) => out.push(line), false, (line) => err.push(line));
    expect(out).toEqual(['partial']);
    expect(err).toEqual(['Delegated work did not complete.', 'Native host is unavailable.']);
  });

  test('recovery hints name the run flag instead of a slash command', () => {
    const lines: string[] = [];
    writeNativeHeadlessResult({ exitCode: 3, response: '', stopReason: 'native-unknown',
      native: { status: 'unknown', message: 'Use /work intake-status, intake-retry, intake-resume or intake-cancel before submitting another input.' } }, 'json', (line) => lines.push(line));
    expect(JSON.parse(lines[0]!).native.message).toBe('Use --intake-status, --intake-retry, --intake-resume or --intake-cancel before submitting another input.');
  });
});

describe('headless failure cause', () => {
  test('known failures map to non-secret cause codes', () => {
    expect(nativeHeadlessFailureCause(new NativeIntakeJournalError('conflict'))).toBe('journal_conflict');
    expect(nativeHeadlessFailureCause(new NativeIntakeJournalError('invalid_journal'))).toBe('journal');
    expect(nativeHeadlessFailureCause(new NativeIntakeFailure('principal', 'Native intake requires an existing paired principal'))).toBe('principal');
    expect(nativeHeadlessFailureCause(Object.assign(new Error('refused'), { code: 'PAIRED_OWNER_REQUIRED' }))).toBe('principal');
    expect(nativeHeadlessFailureCause(new NativeHostSelectionChangedError())).toBe('host_changed');
    expect(nativeHeadlessFailureCause(new TypeError('fetch failed'))).toBe('network');
    expect(nativeHeadlessFailureCause(Object.assign(new Error('bad'), { name: 'ZodError' }))).toBe('schema');
    expect(nativeHeadlessFailureCause('opaque')).toBe('unknown');
  });

  test('a host whose project answer is malformed reports unavailable with cause schema', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ unexpected: true }) });
    try {
      const result = await executeNativeHeadless({ mode: 'status', signal: new AbortController().signal,
        resolveHost: () => ({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'token', credentialIdentity: 'credential', workspace: tmpdir(), journalPath: join(tmpdir(), 'unused-intake.json') }),
        runTurn: async () => { throw new Error('No turn may run'); } });
      expect(result).toMatchObject({ exitCode: 1, stopReason: 'native-unavailable', kind: 'unavailable', cause: 'schema' });
    } finally { server.stop(true); }
  });
});

describe('headless run limits', () => {
  const values = new Set(['--prompt', '-p', '--output']);
  test('--timeout, --max-turns and --omit-accumulated are removed and parsed', () => {
    expect(extractHeadlessRunFlags(['run', '--timeout', '5m', '--max-turns=3', '--omit-accumulated', '-o', 'json', 'hi'], values))
      .toEqual({ argv: ['run', '-o', 'json', 'hi'], flags: { timeoutMs: 300_000, maxTurns: 3, omitAccumulated: true }, errors: [] });
    expect(extractHeadlessRunFlags(['run', '--timeout=90'], values).flags).toEqual({ timeoutMs: 90_000 });
  });

  test('a value position and -- keep flag-shaped text as prompt text', () => {
    expect(extractHeadlessRunFlags(['run', '-p', '--timeout', '--', '--max-turns', '2'], values))
      .toEqual({ argv: ['run', '-p', '--timeout', '--', '--max-turns', '2'], flags: {}, errors: [] });
  });

  test('bad values and use outside run are refused', () => {
    expect(extractHeadlessRunFlags(['run', '--timeout', 'soon', '--max-turns', '0'], values).errors).toHaveLength(2);
    expect(headlessRunFlagErrors({ maxTurns: 2 }, 'tui')).toHaveLength(1);
    expect(headlessRunFlagErrors({ maxTurns: 2 }, 'run')).toEqual([]);
    expect(extractHeadlessRunFlags(['run', '--answer-permissions', '-o', 'stream-json', 'hi'], values))
      .toEqual({ argv: ['run', '-o', 'stream-json', 'hi'], flags: { answerPermissions: true }, errors: [] });
    expect(headlessRunFlagErrors({ answerPermissions: true }, 'run', 'json')[0]).toContain('needs --output stream-json');
    expect(headlessRunFlagErrors({ answerPermissions: true }, 'run', 'stream-json')).toEqual([]);
    expect(headlessRunFlagErrors({ answerPermissions: true }, 'tui', 'stream-json')).toHaveLength(1);
  });

  test('a run cancelled by --timeout exits 124 with stopReason timeout', async () => {
    const result = await runWithHeadlessTimeout(new AbortController().signal, 10, (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ exitCode: 130, response: '', error: 'cancelled', stopReason: 'cancelled' }), { once: true });
    }));
    expect(result).toMatchObject({ exitCode: 124, stopReason: 'timeout' });
    expect(result.error).toContain('--timeout 0.01s');
  });
});
