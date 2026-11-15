import { describe, expect, spyOn, test } from 'bun:test';
import { TreeSitterService } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { adjustedSettingValue, parseNumberEditBuffer } from '../terminal-shell/src/settings-behavior.js';
import { resolveSessionExportRequest } from '../terminal-shell/src/session-export-format.js';
import { createSessionGraphHandler, flagValue } from '../terminal-shell/src/session-graph-command.js';
import { createProfilePickerTokenRoute } from '../terminal-shell/src/searchable-modal-route.js';
import { createSecretsCommand } from '../terminal-shell/src/secrets-command.js';
import { createSecurityCommand } from '../terminal-shell/src/security-command.js';
import { createSessionContentCommands } from '../terminal-shell/src/session-content-commands.js';
import { computeSemanticDiff } from '../terminal-shell/src/semantic-diff-core.js';
import { onSemanticSummaryReady, semanticSummaryFor } from '../terminal-shell/src/semantic-diff-memo.js';
import { voiceCaptureDescription } from '../terminal-shell/src/renderer/voice-capture-chip.js';
import { readServiceLogPosture } from '../terminal-shell/src/service-posture.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { setSecretBackedSettingValue } from '../terminal-shell/src/settings-secret-writes.js';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resumeSessionCore } from '../terminal-shell/src/session-resume.js';
import { publishResumedSession } from '../terminal-shell/src/session-resume-publication.js';
import { createSessionSurface } from '../platform/src/platform/runtime/session-surface.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

describe('number setting edit buffer', () => {
  test('an emptied, blank or non-finite buffer is rejected instead of becoming a value', () => {
    expect(parseNumberEditBuffer('')).toBeNull();
    expect(parseNumberEditBuffer('   ')).toBeNull();
    expect(parseNumberEditBuffer('Infinity')).toBeNull();
    expect(parseNumberEditBuffer('abc')).toBeNull();
  });
  test('a typed zero and ordinary numbers still parse', () => {
    expect(parseNumberEditBuffer('0')).toBe(0);
    expect(parseNumberEditBuffer(' 12.5 ')).toBe(12.5);
  });
});

describe('arrow-key adjustment of a number setting', () => {
  test('the schema validator is the only range: the step follows it and stops at its edge', () => {
    const inRange = (low: number, high: number) => ({ key: 'tts.speed', type: 'number' as const, validate: (v: unknown) => typeof v === 'number' && v >= low && v <= high });
    expect(adjustedSettingValue(inRange(0.5, 2), 1, 'right', 1)).toEqual({ value: 1.1 });
    expect(adjustedSettingValue(inRange(0.5, 2), 2, 'right', 1)).toBeUndefined();
    // A widened schema range is followed without a second edit here.
    expect(adjustedSettingValue(inRange(0.5, 8), 4, 'right', 1)).toEqual({ value: 4.1 });
  });
});

describe('/session export target resolution', () => {
  const sessions = [
    { name: 'user-ab12cd34', title: 'Alpha' },
    { name: 'user-ab99ef00', title: 'Beta' },
  ];
  const resolve = (args: string[], printed: string[] = []) => resolveSessionExportRequest(args, 'user-current', () => sessions, (text) => printed.push(text));
  test('a prefix shared by two sessions is reported as ambiguous and nothing is exported', () => {
    const printed: string[] = [];
    expect(resolve(['export', 'user-ab'], printed)).toBeUndefined();
    expect(printed[0]).toContain('Ambiguous session: user-ab');
    expect(printed[0]).toContain('user-ab12cd34');
    expect(printed[0]).toContain('user-ab99ef00');
  });
  test('a unique prefix, an exact id and a title each find their session', () => {
    expect(resolve(['export', 'user-ab1'])?.found?.name).toBe('user-ab12cd34');
    expect(resolve(['export', 'user-ab99ef00'])?.found?.name).toBe('user-ab99ef00');
    expect(resolve(['export', 'beta'])?.found?.name).toBe('user-ab99ef00');
  });
  test('a missing target prints usage and an unknown one is returned unfound', () => {
    const printed: string[] = [];
    expect(resolve(['export'], printed)).toBeUndefined();
    expect(printed[0]).toContain('Usage: /session export');
    expect(resolve(['export', 'nope'])?.found).toBeUndefined();
  });
  test('"." means the current session by exact id only', () => {
    expect(resolve(['export', '.'])).toMatchObject({ sessionId: 'user-current', found: undefined });
  });
});

describe('/session graph', () => {
  const ref = (sessionId: string, taskId: string) => ({ sessionId, taskId, title: `task ${taskId}`, status: 'pending', label: undefined });
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const B = 'bbbbbbbb-1111-2222-3333-444444444444';
  const snapshot = {
    version: 1 as const,
    snapshotAt: 0,
    refs: { [`${A}:t1`]: ref(A, 't1'), [`${B}:t2`]: ref(B, 't2') },
    edges: [{ fromRef: { sessionId: A, taskId: 't1' }, toRef: { sessionId: B, taskId: 't2' }, linkedAt: 0 }],
    handoffs: [],
  };
  const orchestration = { snapshot: () => snapshot, getDependencies: () => [], getDependents: () => [], getHandoffs: () => snapshot.handoffs };
  const run = (args: string[]) => {
    const printed: string[] = [];
    createSessionGraphHandler<{ print: (message: string) => void }>(() => orchestration as never, 'empty')(args, { print: (m) => printed.push(m) });
    return printed.join('\n');
  };
  test('--format json with --session carries only that session', () => {
    const out = JSON.parse(run(['--session', A, '--format', 'json'])) as typeof snapshot;
    expect(Object.keys(out.refs)).toEqual([`${A}:t1`]);
  });
  test('without --session the whole snapshot is printed', () => {
    expect(Object.keys((JSON.parse(run(['--format', 'json'])) as typeof snapshot).refs)).toHaveLength(2);
  });
  test('a prefix of a session id selects it, and the text view prints ids that can be reused', () => {
    const out = run(['--session', 'aaaaaaaa']);
    expect(out).toContain(`Session ${A}`);
    expect(out).not.toContain(B);
  });
  test('a prefix matching several sessions is ambiguous', () => {
    const many = { ...snapshot, refs: { ...snapshot.refs, ['aaaaaaaa-other:t3']: ref('aaaaaaaa-other', 't3') } };
    const printed: string[] = [];
    createSessionGraphHandler<{ print: (message: string) => void }>(() => ({ ...orchestration, snapshot: () => many }) as never, 'empty')(['--session', 'aaaaaaaa'], { print: (m) => printed.push(m) });
    expect(printed[0]).toContain('Ambiguous');
  });
  test('a flag is not taken as the value of the flag before it', () => {
    expect(flagValue(['--session', '--format', 'json'], '--session')).toBeUndefined();
    expect(flagValue(['--session', '--format', 'json'], '--format')).toBe('json');
  });
});

describe('profile picker shortcuts', () => {
  const press = (token: InputToken, query = '') => {
    const calls: string[] = [];
    const modal = {
      active: true, query, setQuery() {}, moveUp() {}, moveDown() {},
      deleteSelected: () => calls.push('delete'), loadSelected: () => calls.push('load'), saveCurrentAs: () => calls.push('save'),
    };
    const state = { profilePickerModal: modal, commandContext: { platform: { configManager: {} } }, requestRender() {}, handleEscape() {} };
    createProfilePickerTokenRoute<object>(true)(state as never, token);
    return calls;
  };
  const key = (logicalName: string, ctrl = false) => ({ type: 'key', logicalName, ctrl }) as unknown as InputToken;
  test('Ctrl+D and Ctrl+S do not delete or save a profile', () => {
    expect(press(key('d', true))).toEqual([]);
    expect(press(key('s', true))).toEqual([]);
  });
  test('a bare d or s acts only while the query is empty', () => {
    expect(press({ type: 'text', value: 'd' } as InputToken)).toEqual(['delete']);
    expect(press({ type: 'text', value: 's' } as InputToken)).toEqual(['save']);
    expect(press(key('d'), 'abc')).toEqual([]);
  });
});

describe('/secrets set', () => {
  const make = () => {
    const stored: Array<[string, string]> = [];
    const printed: string[] = [];
    const command = createSecretsCommand<{ print: (m: string) => void }>(
      () => ({ set: async (k: string, v: string) => { stored.push([k, v]); }, get: async () => null, delete: async () => {}, listDetailed: async () => [] }) as never,
      {
        hidden: false, description: '', confirmMutations: true, concealedEntry: false,
        writeScope: (_k, requested) => requested, deleteScope: (_k, requested) => requested, relocationNote: () => '',
        resolved: () => '', failed: () => '', deleted: () => '',
      },
    );
    return { stored, printed, run: (args: string[]) => command.handler(args, { print: (m) => printed.push(m) }) };
  };
  test('a value that is only a --token is refused, not stored as an empty secret', async () => {
    const s = make();
    await s.run(['set', 'API_KEY', '--abc123', '--yes']);
    expect(s.stored).toEqual([]);
    expect(s.printed.join('\n')).toContain('not a known option');
    expect(s.printed.join('\n')).not.toContain('abc123');
  });
  test('a bare -- lets a value start with --', async () => {
    const s = make();
    await s.run(['set', 'API_KEY', '--yes', '--', '--abc123']);
    expect(s.stored).toEqual([['API_KEY', '--abc123']]);
  });
  test('no value at all stores nothing', async () => {
    const s = make();
    await s.run(['set', 'API_KEY', '--yes']);
    expect(s.stored).toEqual([]);
    expect(s.printed.join('\n')).toContain('no value given');
  });
  test('known options still work', async () => {
    const s = make();
    await s.run(['set', 'API_KEY', 'v1', '--user', '--yes']);
    expect(s.stored).toEqual([['API_KEY', 'v1']]);
  });
});

describe('/secrets delete', () => {
  const make = () => {
    const deleted: string[] = [];
    const printed: string[] = [];
    const command = createSecretsCommand<{ print: (m: string) => void }>(
      () => ({ set: async () => {}, get: async () => null, delete: async (k: string) => { deleted.push(k); }, listDetailed: async () => [] }) as never,
      {
        hidden: false, description: '', confirmMutations: true, concealedEntry: false,
        writeScope: (_k, requested) => requested, deleteScope: (_k, requested) => requested, relocationNote: () => '',
        resolved: () => '', failed: () => '', deleted: (k) => `deleted ${k}`,
      },
    );
    return { deleted, printed, run: (args: string[]) => command.handler(args, { print: (m) => printed.push(m) }) };
  };
  test('a misspelled scope flag deletes nothing instead of deleting at the default scope', async () => {
    const s = make();
    await s.run(['delete', 'API_KEY', '--usr', '--yes']);
    expect(s.deleted).toEqual([]);
    expect(s.printed.join('\n')).toContain('Nothing was deleted');
  });
  test('known options still delete', async () => {
    const s = make();
    await s.run(['delete', 'API_KEY', '--user', '--yes']);
    expect(s.deleted).toEqual(['API_KEY']);
  });
});

describe('/security', () => {
  test('an unknown subcommand prints usage instead of the review', () => {
    const printed: string[] = [];
    const never = () => { throw new Error('the review must not be read'); };
    const command = createSecurityCommand<{ print(text: string): void }>(
      { tokens: never, security: never, policy: never, plugins: never, subscriptions: never },
      { hidden: false, beforeRead: () => false, policyUnavailable: '', emptyTokens: '', tokenTitle: '', separator: ': ' },
    );
    void command.handler(['foo'], { print: (text) => printed.push(text) });
    expect(printed[0]).toContain('Usage: /security [review | attack-paths | tokens]');
  });
});

describe('/retry and /export', () => {
  type Ctx = {
    printed: string[];
    submitted: string[];
    undone: number;
    session: { runtime: { model: string; provider: string; sessionId: string }; conversationManager: { title: string; getLastUserMessage(): string; undo(): boolean } };
    print(m: string): void;
    renderRequest(): void;
    submitInput?: (m: string) => void;
  };
  const makeCtx = (opts: { submit?: boolean; undo?: boolean } = {}): Ctx => {
    const ctx: Ctx = {
      printed: [], submitted: [], undone: 0,
      session: {
        runtime: { model: 'm', provider: 'p', sessionId: 's' },
        conversationManager: { title: '', getLastUserMessage: () => 'hello', undo: () => { ctx.undone++; return opts.undo ?? true; } },
      },
      print: (m) => { ctx.printed.push(m); }, renderRequest() {},
    };
    if (opts.submit !== false) ctx.submitInput = (m) => { ctx.submitted.push(m); };
    return ctx;
  };
  const commands = (root: string, redact?: (text: string) => Promise<string>) => createSessionContentCommands<Ctx, { role: string; text: string }>({
    paths: () => ({ resolveWorkspacePath: (p: string) => join(root, p), isWithinWorkingDirectory: () => true }) as never,
    capture: () => [{ role: 'user', text: 'token sk-secret-value' }],
    markdown: (m) => m.map((x) => ({ role: x.role, content: x.text })) as never,
    text: (m) => m.text, role: (m) => m.role,
    confirmExport: true, invalidPath: 'bad path', exported: (n, p) => `exported ${n} ${p}`, failed: (a, e) => `${a} failed: ${String(e)}`,
    title: (t) => t, titleSet: (t) => t, retryDescription: '', retryRemovesLastTurn: true,
    ...(redact ? { redact } : {}),
  });
  test('a retry with no way to resubmit leaves the transcript alone', () => {
    const ctx = makeCtx({ submit: false });
    void commands('/').retryCommand.handler([], ctx);
    expect(ctx.undone).toBe(0);
    expect(ctx.printed[0]).toContain('left unchanged');
  });
  test('a retry whose last turn cannot be removed resubmits nothing', () => {
    const ctx = makeCtx({ undo: false });
    void commands('/').retryCommand.handler([], ctx);
    expect(ctx.submitted).toEqual([]);
    expect(ctx.printed[0]).toContain('could not be removed');
  });
  test('a retry removes the turn and resubmits it', () => {
    const ctx = makeCtx();
    void commands('/').retryCommand.handler([], ctx);
    expect(ctx.submitted).toEqual(['hello']);
  });
  test('the exported file holds the redacted transcript', async () => {
    const root = makeProjectTempDir('export-redaction');
    mkdirSync(root, { recursive: true });
    const ctx = makeCtx();
    await commands(root, async (text) => text.replace('sk-secret-value', '<redacted>')).exportCommand.handler(['text', 'out.txt', '--yes'], ctx);
    const written = readFileSync(join(root, 'out.txt'), 'utf-8');
    expect(written).toContain('<redacted>');
    expect(written).not.toContain('sk-secret-value');
  });
  test('a failed redaction writes no file', async () => {
    const root = makeProjectTempDir('export-redaction-failure');
    mkdirSync(root, { recursive: true });
    const ctx = makeCtx();
    await commands(root, async () => { throw new Error('redactor unavailable'); }).exportCommand.handler(['text', 'out.txt', '--yes'], ctx);
    expect(ctx.printed[0]).toContain('export conversation failed');
    expect(() => readFileSync(join(root, 'out.txt'))).toThrow();
  });
});

describe('semantic diff', () => {
  test('a side-effect import does not borrow the from-clause of a later statement', async () => {
    const result = await computeSemanticDiff('notes.unknownext', "import './a';\nexport { x } from './b'", "export { x } from './b'");
    expect(result?.imports.map((i) => [i.kind, i.specifier])).toEqual([['removed', './a']]);
  });
  test('every diff releases the tree-sitter service it created', async () => {
    const dispose = spyOn(TreeSitterService.prototype, 'dispose');
    try {
      await computeSemanticDiff('a.ts', 'export const a = 1;', 'export const a = 2;');
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { dispose.mockRestore(); }
  });
  test('added or removed lines that begin with ++ or -- are content, not headers', async () => {
    const diff = ['--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', "---import './old'", "++++import './new'"].join('\n');
    const ready = new Promise<void>((resolve) => { const off = onSemanticSummaryReady(() => { off(); resolve(); }); });
    expect(semanticSummaryFor(diff, 'x.unknownext')).toBeUndefined();
    await ready;
    const summary = semanticSummaryFor(diff, 'x.unknownext');
    expect(summary?.imports.map((i) => [i.kind, i.specifier]).sort()).toEqual([['added', './new'], ['removed', './old']]);
  });
});

describe('voice capture description', () => {
  test('the separator applies to every kind whose wording has a colon', () => {
    const state = { kind: 'recording', deviceLabel: null } as never;
    expect(voiceCaptureDescription(state, ',')).toBe('recording, press the voice-input key again to stop');
    expect(voiceCaptureDescription(state)).toBe('recording: press the voice-input key again to stop');
  });
});

describe('service log posture', () => {
  const classic = <T>(run: () => Promise<T>) => withDecisionModelPolicy(() => 'Classic - Off', run);
  const mutateAfterCapture = (mutate: () => void) => {
    let calls = 0;
    return { assertCurrent: () => { if (++calls === 2) mutate(); } };
  };
  test('a log that keeps growing while it is redacted still resolves with its tail', async () => {
    const path = join(makeProjectTempDir('posture-growth'), 'service.log');
    writeFileSync(path, 'first line\n');
    const result = await classic(() => readServiceLogPosture(path, 4096, mutateAfterCapture(() => writeFileSync(path, 'first line\nsecond line\n'))));
    expect(result).toMatchObject({ exists: true, tail: 'first line\n' });
    expect(result.readError).toBeUndefined();
  });
  test('a log that was truncated while it is redacted reports a read error instead of rejecting', async () => {
    const path = join(makeProjectTempDir('posture-truncate'), 'service.log');
    writeFileSync(path, 'first line\nsecond line\n');
    const result = await classic(() => readServiceLogPosture(path, 4096, mutateAfterCapture(() => writeFileSync(path, 'x'))));
    expect(result.readError).toBe('Service log changed while it was read.');
    expect(result.tail).toBeUndefined();
  });
  test('a tail that starts inside a multi-byte character drops the partial character', async () => {
    const path = join(makeProjectTempDir('posture-utf8'), 'service.log');
    writeFileSync(path, 'é-tail\n');
    // 7 bytes in total; asking for the last 6 starts on the second byte of é.
    const result = await classic(() => readServiceLogPosture(path, 6, {}));
    expect(result.tail).toBe('-tail\n');
  });
});

describe('clearing a secret-backed setting', () => {
  const run = (setConfigValue: () => void, deleteSecret: () => Promise<void>) => {
    const events: string[] = [];
    const errors: string[] = [];
    const config = { get: () => 'secure_only', validateDynamic: () => {} } as unknown as ConfigManager;
    return setSecretBackedSettingValue({
      key: 'surfaces.ntfy.token', value: '', configManager: config,
      secretsManager: { set: async () => { events.push('set'); }, delete: async () => { events.push('delete'); await deleteSecret(); } },
      setConfigValue: () => { events.push('config'); setConfigValue(); },
      onError: (message) => errors.push(message),
    }).then((ok) => ({ ok, events, errors }));
  };
  test('the reference is cleared before the secret is deleted', async () => {
    expect(await run(() => {}, async () => {})).toMatchObject({ ok: true, events: ['config', 'delete'], errors: [] });
  });
  test('a failed config write leaves the secret in place', async () => {
    const result = await run(() => { throw new Error('disk full'); }, async () => {});
    expect(result.ok).toBe(false);
    expect(result.events).toEqual(['config']);
  });
  test('a failed secret delete after the clear is reported, not hidden as a failed save', async () => {
    const result = await run(() => {}, async () => { throw new Error('store offline'); });
    expect(result.ok).toBe(true);
    expect(result.errors[0]).toContain('stored value could not be removed');
  });
});

describe('resuming a session', () => {
  const make = (hydrate: () => void) => {
    const dir = makeProjectTempDir('resume-core');
    const surface = createSessionSurface({ surfaceRoot: 'test', workingDirectory: dir, homeDirectory: dir });
    const conversation = {
      title: '', resetAll() {}, fromJSON() {}, rebuildHistory() {}, getMessageCount: () => 0,
      workTree: { restoreFoldState() {}, restoreTurnOutcomes() {} },
    };
    const runtime = { sessionId: 'old', model: 'old-model', provider: 'old-provider' };
    const sessionManager = {
      load: () => ({ meta: { name: 'new', title: 't', model: 'new-model', provider: 'new-provider', timestamp: 1, messageCount: 0, filePath: '' }, messages: [] }),
      save: () => ({ filePath: '', sanitizedName: 'new' }),
    };
    return { runtime, run: () => resumeSessionCore('new', { sessionManager: sessionManager as never, conversation: conversation as never, runtime, surface, hydrateSessionUsage: hydrate }) };
  };
  test('model, provider and session id move together, and a failing later step does not undo the resume', async () => {
    const s = make(() => { throw new Error('usage unreadable'); });
    const outcome = await s.run();
    expect(s.runtime).toEqual({ sessionId: 'new', model: 'new-model', provider: 'new-provider' });
    expect(outcome.warnings?.[0]).toContain('restoring footer usage failed');
  });
  test('a clean resume reports no warnings', async () => {
    const s = make(() => {});
    expect((await s.run()).warnings).toBeUndefined();
  });
});

describe('publishing a resumed session', () => {
  const publish = async (broker: () => Promise<unknown>, pointer: () => void) => {
    const logged: string[] = [];
    let reopened = false;
    const options = {
      runtime: { sessionId: 'new' },
      conversation: { title: '', log: (message: string) => { logged.push(message); } },
      configManager: { get: () => 'off', getCategory: () => ({}) },
      providerRegistry: {},
      writeLastSessionPointer: pointer,
      sharedSessionBroker: { reopenSession: broker },
      hookDispatcher: { fire: async () => {} },
      requestRender() {},
    };
    publishResumedSession(options as never, 'new', { returnContext: undefined } as never, { reopen: () => { reopened = true; }, reentry: () => [], hookError: 'hook failed' });
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    return { logged, reopened };
  };
  test('a rejected broker reopen is shown to the person, not only logged at debug', async () => {
    const { logged } = await publish(async () => { throw new Error('broker down'); }, () => {});
    expect(logged.some((line) => line.includes('the shared session was not reopened') && line.includes('broker down'))).toBe(true);
  });
  test('a failing last-session pointer write does not skip the reopen or the Resumed line', async () => {
    const { logged, reopened } = await publish(async () => {}, () => { throw new Error('disk full'); });
    expect(reopened).toBe(true);
    expect(logged.some((line) => line.includes('Resumed session: new'))).toBe(true);
    expect(logged.some((line) => line.includes('the last-session pointer was not saved'))).toBe(true);
  });
});
