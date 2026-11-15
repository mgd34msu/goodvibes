/**
 * Behaviour of the shared terminal-shell command handlers: what a failed or refused
 * command says, what it changes, and what it leaves untouched.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthBundleHandler, type AuthReviewBundleBase } from '../terminal-shell/src/auth-review-command.ts';
import { createCliSubscriptionView } from '../terminal-shell/src/cli-subscription-view.ts';
import { commandTextExitCode } from '../terminal-shell/src/cli-output.ts';
import { createCliSecretsCommand } from '../terminal-shell/src/cli-secrets-command.ts';
import { createCliProviderViews } from '../terminal-shell/src/cli-provider-views.ts';
import { createCliWorkspaceCommands } from '../terminal-shell/src/cli-workspace-commands.ts';
import { handleBookmarks } from '../terminal-shell/src/bookmark-command.ts';
import { AutocompleteEngine } from '../terminal-shell/src/autocomplete.ts';
import { stripDangerousAnsi } from '../terminal-shell/src/ansi-sanitize.ts';
import { printableName, renderDiscovered } from '../terminal-shell/src/cluster-render.ts';
import { runClusterCommand } from '../terminal-shell/src/cluster-commands.ts';
import { callDaemonVerb } from '../terminal-shell/src/cluster-remote-daemon-target.ts';
import { openBrowser } from '../terminal-shell/src/cli-environment.ts';
import type { ConcealedInputRequest } from '../terminal-shell/src/concealed-input.ts';
import { createBlockContentActions } from '../terminal-shell/src/block-content-actions.ts';
import { createPaymentCardCommands, createCardEntryPrompter, CARD_ENTRY_FIELDS } from '../terminal-shell/src/card-field-prompts.ts';
import { attachTerminalCompanionInput, } from '../terminal-shell/src/bootstrap-primitives.ts';
import { seedTerminalControlPlane } from '../terminal-shell/src/bootstrap-runtime-bindings.ts';
import { createWakeEngineFactory } from '../terminal-shell/src/audio/wake-inference.ts';
import { retainWakeClip } from '../terminal-shell/src/audio/retained-wake-clip.ts';
import { parseGoodVibesCli } from '../terminal-shell/src/index.ts';

type Rt = { readonly cli: { readonly commandArgs: readonly string[]; readonly flags: Record<string, never> } };
const runtimeOf = (...commandArgs: string[]): Rt => ({ cli: { commandArgs, flags: {} } });
const direct = <S>(services: S) => async <T>(_rt: Rt, fn: (s: S) => Promise<T> | T): Promise<T> => await fn(services);

describe('subscription login', () => {
  const services = {
    subscriptionManager: { list: () => [], listPending: () => [], get: () => undefined, getPending: () => undefined },
    serviceRegistry: { getAll: () => [], get: () => undefined },
    secretsManager: {},
  };
  const view = createCliSubscriptionView<Rt, never>(direct(services) as never, {
    inline: true,
    manualOnly: false,
    binary: () => 'goodvibes',
    source: (s) => s,
    time: String,
  });

  test('the "login <provider> finish <code>" form printed after start reaches the finish step', async () => {
    const out = await view.renderSubscriptions(runtimeOf('login', 'openai', 'finish', 'abc'));
    expect(out).toBe('No pending OAuth login for openai.');
  });

  test('finish on an unknown provider names the provider instead of printing usage', async () => {
    const out = await view.renderSubscriptions(runtimeOf('login', 'nope', 'finish', 'abc'));
    expect(out).toBe('No subscription provider found: nope');
  });

  test('login with a second word that is neither start nor finish still prints usage', async () => {
    const out = await view.renderSubscriptions(runtimeOf('login', 'openai', 'wat'));
    expect(out.startsWith('Usage:')).toBe(true);
  });
});

describe('text command exit codes', () => {
  const exit = (text: string) => commandTextExitCode(text, ['Usage:', 'Invalid '], ['Task submit failed ']);
  test.each([
    'Ambiguous session: x. Use an exact ID: a, b',
    'No subscription provider found: typo',
    'Session not found x',
    'Session not found: x',
  ])('%s is a failure', (text) => {
    expect(exit(text)).not.toBe(0);
  });
  test('a refused secrets set is a failure, so a following && does not run', () => {
    expect(exit('Not stored: 2 values were given for K. Quote the value as one argument.')).not.toBe(0);
  });
  test('a plain receipt is still a success', () => {
    expect(exit('Subscription refreshed: openai expires=n/a')).toBe(0);
  });
});

describe('secrets set', () => {
  function build(stdin = '') {
    const stored: Array<{ key: string; value: string }> = [];
    const command = createCliSecretsCommand<Rt>({
      createSecrets: () => ({ set: async (key: string, value: string) => { stored.push({ key, value }); } }) as never,
      binary: () => 'goodvibes',
      inline: true,
      writeScope: (_k, requested) => requested,
      deleteScope: (_k, requested) => requested,
      relocation: () => [],
      readStdin: async () => stdin,
    });
    return { stored, command };
  }

  test('a value split across arguments, or with a stray option, is refused and nothing is stored', async () => {
    const { stored, command } = build();
    const withOption = await command.handleSecrets(runtimeOf('set', 'K', 'a', '--b'));
    expect(withOption).toContain('Not stored');
    const twoWords = await command.handleSecrets(runtimeOf('set', 'K', 'a', 'b'));
    expect(twoWords).toContain('Not stored');
    expect(stored).toEqual([]);
  });

  test('one quoted argument is stored exactly, internal spaces included', async () => {
    const { stored, command } = build();
    const out = await command.handleSecrets(runtimeOf('set', 'K', 'a  b', '--user'));
    expect(out).toContain('Stored: K');
    expect(stored).toEqual([{ key: 'K', value: 'a  b' }]);
  });

  test('--stdin stores a value that starts with --', async () => {
    const { stored, command } = build('--abc123');
    const out = await command.handleSecrets(runtimeOf('set', 'K', '--stdin'));
    expect(out).toContain('Stored: K');
    expect(stored).toEqual([{ key: 'K', value: '--abc123' }]);
  });
});

describe('providers use and models use', () => {
  function build() {
    const writes: Array<[string, unknown]> = [];
    const recorded: string[] = [];
    const registry = {
      listProviders: () => [],
      getCurrentModel: () => ({ provider: 'openai', registryKey: 'openai:gpt-1', id: 'gpt-1' }),
      getSelectableModels: () => [{ provider: 'openai', registryKey: 'openai:gpt-1', id: 'gpt-1' }],
    };
    const runtime = (...args: string[]) => ({
      cli: { commandArgs: args, flags: {} },
      configManager: { get: () => 'openai:gpt-1', setDynamic: (k: string, v: unknown) => { writes.push([k, v]); } },
    });
    const services = {
      providerRegistry: registry,
      favoritesStore: { recordUsage: async (k: string) => { recorded.push(k); }, pinModel: async () => {}, unpinModel: async () => {} },
    };
    const views = createCliProviderViews<never, never>(
      (async (rt: unknown, fn: (s: unknown) => unknown) => await fn(services)) as never,
      {
        surface: 'test', enrichModelFamilies: false, syntheticCatalog: false, inlineReceipts: true,
        binary: () => 'goodvibes', formatProviderAuthRoute: (() => '') as never,
      },
    );
    return { writes, recorded, runtime, views };
  }

  test('an unknown provider with no model writes nothing and says what is known', async () => {
    const { writes, runtime, views } = build();
    const out = await views.renderProviders(runtime('use', 'opnai') as never);
    expect(writes).toEqual([]);
    expect(out).toContain('Unknown provider: opnai');
  });

  test('a bare model id that is not in the catalog is refused rather than guessed into a provider', async () => {
    const { writes, recorded, runtime, views } = build();
    const out = await views.renderModels(runtime('use', 'meta-llama/Llama-3.1-8B') as never);
    expect(out).toContain('Unknown model');
    expect(writes).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test('an explicit provider:model that is not in the catalog is saved and the receipt names the provider', async () => {
    const { writes, runtime, views } = build();
    const out = await views.renderModels(runtime('use', 'acme:big-1') as never);
    expect(writes.length).toBe(1);
    expect(out).toContain('under provider acme');
  });

  test('--json lists every match, while the text listing is cut and says so', async () => {
    const models = Array.from({ length: 250 }, (_, i) => ({ provider: 'openai', registryKey: `openai:m-${i}`, id: `m-${i}`, displayName: `M ${i}` }));
    const registry = {
      listProviders: () => [],
      getCurrentModel: () => models[0],
      getSelectableModels: () => models,
      getContextWindowForModel: () => 1000,
      getKnownContextWindowForModel: () => 1000,
    };
    const views = createCliProviderViews<never, never>(
      (async (_rt: unknown, fn: (s: unknown) => unknown) => await fn({ providerRegistry: registry })) as never,
      {
        surface: 'test', enrichModelFamilies: false, syntheticCatalog: false, inlineReceipts: true,
        binary: () => 'goodvibes', formatProviderAuthRoute: (() => '') as never,
      },
    );
    const run = (outputFormat?: string) => ({ cli: { commandArgs: [] as string[], flags: outputFormat ? { outputFormat } : {} }, configManager: { get: () => 'openai:m-0' } });
    const json = JSON.parse(await views.renderModels(run('json') as never)) as unknown[];
    expect(json.length).toBe(250);
    const text = await views.renderModels(run() as never);
    expect(text).toContain('showing 200 of 250');
  });

  test('pinning a model the catalog does not have is refused', async () => {
    const { runtime, views } = build();
    const out = await views.renderModels(runtime('pin', 'nope') as never);
    expect(out).toContain('Nothing was pinned');
  });
});

describe('auth bundle export over an older, wider file', () => {
  test('ends owner-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-bundle-old-'));
    try {
      const target = join(dir, 'bundle.json');
      writeFileSync(target, 'old', { mode: 0o644 });
      chmodSync(target, 0o644);
      const handler = createAuthBundleHandler<{ print(m: string): void }, AuthReviewBundleBase>({
        confirmExport: false, reportReadFailure: false, build: (base) => base, inspect: () => '',
      });
      const handled = await handler(['bundle', 'export', 'bundle.json'], { print: () => {} }, {
        secretsManager: { list: async () => ['K'] },
        subscriptions: { list: () => [], listPending: () => [] },
        resolvePath: (p: string) => join(dir, p),
        confirmed: true,
      } as never);
      expect(handled).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sessions export over an older, wider file', () => {
  test('ends owner-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-export-old-'));
    try {
      const target = join(dir, 'session.json');
      writeFileSync(target, 'old', { mode: 0o644 });
      chmodSync(target, 0o644);
      const services = {
        sessionManager: {
          list: () => [{ name: 'abc', title: 't', messageCount: 1, timestamp: 1, provider: 'p', model: 'm', filePath: 'f' }],
          load: () => ({ messages: [] }),
        },
        shellPaths: { resolveWorkspacePath: (p: string) => join(dir, p) },
        runtimeStore: {},
      };
      const commands = createCliWorkspaceCommands<Rt, never>(direct(services) as never, {
        binary: () => 'goodvibes', time: String, inline: true, submit: async () => '', allowSubmit: false, emptyTasks: '',
      });
      await commands.handleSessions(runtimeOf('export', 'abc', 'session.json'));
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sessions export', () => {
  test('is redacted and written owner-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-export-'));
    try {
      const services = {
        sessionManager: {
          list: () => [{ name: 'abc', title: 't', messageCount: 1, timestamp: 1, provider: 'p', model: 'm', filePath: 'f' }],
          load: () => ({ messages: [{ role: 'tool', content: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] }),
        },
        shellPaths: { resolveWorkspacePath: (p: string) => join(dir, p) },
        runtimeStore: {},
      };
      const commands = createCliWorkspaceCommands<Rt, never>(direct(services) as never, {
        binary: () => 'goodvibes', time: String, inline: true, submit: async () => '', allowSubmit: false, emptyTasks: '',
      });
      await commands.handleSessions(runtimeOf('export', 'abc', 'out/session.json'));
      const target = join(dir, 'out/session.json');
      expect(readFileSync(target, 'utf-8')).not.toContain('AAAAAAAAAAAAAAAA');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'out')).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bookmarks selection', () => {
  test('choosing the empty-list placeholder with the delete action creates no bookmark', () => {
    const toggled: string[] = [];
    const printed: string[] = [];
    handleBookmarks(
      {
        print: (t) => printed.push(t),
        openSelection: (_title, _items, _options, callback) => callback({ item: { id: '_empty', label: 'No bookmarks' }, action: 'delete' } as never),
        jumpToBookmark: (k) => printed.push(`jump ${k}`),
      },
      () => ({ list: () => [], toggle: (k: string) => { toggled.push(k); return true; } }) as never,
    );
    expect(toggled).toEqual([]);
    expect(printed).toEqual([]);
  });
});

describe('autocomplete selection', () => {
  const names = ['alpha', 'alps', 'beta', 'betamax', 'gamma'];
  const registry = {
    fuzzyMatch: (query: string) => names.filter((n) => n.startsWith(query)).map((name) => ({ command: { name, description: '' }, score: 1 })),
  };
  test('typing another character puts the highlight back on the best match', () => {
    const engine = new AutocompleteEngine(registry);
    engine.update('');
    engine.moveDown();
    engine.moveDown();
    engine.moveDown();
    engine.update('a');
    expect(engine.getSelected()?.name).toBe('alpha');
  });
  test('re-rendering with the same text keeps the arrowed highlight', () => {
    const engine = new AutocompleteEngine(registry);
    engine.update('');
    engine.moveDown();
    engine.update('');
    expect(engine.getSelected()?.name).toBe('alps');
  });
});

describe('terminal escape sanitising', () => {
  test('8-bit C1 CSI and OSC are removed', () => {
    expect(stripDangerousAnsi('a\u009b2Jb\u009d52;c;QQ==\u0007c\u0085d')).toBe('abcd');
  });
  test('SGR conceal is dropped while colour and a colour argument of 8 survive', () => {
    expect(stripDangerousAnsi('\x1b[8mhidden\x1b[0m')).toBe('hidden\x1b[0m');
    expect(stripDangerousAnsi('\x1b[08mhidden\x1b[0m')).toBe('hidden\x1b[0m');
    expect(stripDangerousAnsi('\x1b[1;08mhidden\x1b[0m')).toBe('hidden\x1b[0m');
    expect(stripDangerousAnsi('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m');
    expect(stripDangerousAnsi('\x1b[038;05;08mgrey\x1b[0m')).toBe('\x1b[038;05;08mgrey\x1b[0m');
    expect(stripDangerousAnsi('\x1b[38;5;8mgrey\x1b[0m')).toBe('\x1b[38;5;8mgrey\x1b[0m');
  });
});

describe('cluster output from other machines', () => {
  test('a group name with escape sequences prints without ESC or BEL, and is bounded', () => {
    const lines = renderDiscovered(
      [{ groupId: 'g1', displayName: 'a\x1b]52;c;QQ==\x07b' + 'x'.repeat(500), nodeCount: 1, version: '1', lastSeenAt: 0 } as never],
      1000,
    );
    const text = lines.join('\n');
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('\x07');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(200);
    expect(printableName('a\x1b]52;c;QQ==\x07b')).not.toContain('\x1b');
  });
});

describe('cluster destructive verbs', () => {
  const config = {
    get: (key: string): unknown => ({ 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 4319, 'controlPlane.hostMode': 'local', 'controlPlane.tlsMode': 'off' })[key],
  };
  const base = { configManager: config as never, daemonHomeDir: '/nowhere', readToken: () => 'tok', isTerminal: false };
  const ok = () => new Response(JSON.stringify({ ok: true, data: { groupId: 'g', groupName: 'n', nodeId: 'x', displayName: 'x', memberCount: 1, keyGeneration: 1, immediate: true, acceptedGenerations: [1] } }));

  for (const argv of [['leave'], ['forget', 'node-b'], ['rotate', '--now']]) {
    test(`${argv.join(' ')} without --yes does not call the daemon and says how to confirm`, async () => {
      let calls = 0;
      const result = await runClusterCommand({ ...base, argv, fetchImpl: async () => { calls++; return ok(); } });
      expect(calls).toBe(0);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('--yes');
    });
    test(`${argv.join(' ')} --yes runs`, async () => {
      let calls = 0;
      const result = await runClusterCommand({ ...base, argv: [...argv, '--yes'], fetchImpl: async () => { calls++; return ok(); } });
      expect(calls).toBe(1);
      expect(result.exitCode).toBe(0);
    });
  }

  test('a terminal user can confirm by typing yes', async () => {
    let calls = 0;
    const result = await runClusterCommand({ ...base, isTerminal: true, argv: ['leave'], prompt: async () => 'yes', fetchImpl: async () => { calls++; return ok(); } });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  test('routine rotation needs no confirmation', async () => {
    let calls = 0;
    await runClusterCommand({ ...base, argv: ['rotate'], fetchImpl: async () => { calls++; return ok(); } });
    expect(calls).toBe(1);
  });

  test('--json join keeps the group listing off stdout', async () => {
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const realErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const answers = ['g1', 'secret-key'];
    const asked: string[] = [];
    try {
      await runClusterCommand({
        ...base,
        isTerminal: true,
        argv: ['join', '--json'],
        prompt: async (q) => { asked.push(q); return answers.shift() ?? ''; },
        fetchImpl: async (url) => String(url).endsWith('/groups')
          ? new Response(JSON.stringify({ ok: true, data: [{ groupId: 'g1', displayName: 'shop', nodeCount: 1, version: '1', lastSeenAt: 0 }] }))
          : ok(),
      });
    } finally {
      process.stdout.write = realWrite;
      process.stderr.write = realErrWrite;
    }
    expect(written.join('')).not.toContain('shop');
  });
});

describe('daemon verb calls', () => {
  const target = { baseUrl: 'http://10.0.0.7:1', token: 't', isLocal: false } as const;
  test('a peer that never answers ends in a failure, not a hang', async () => {
    const result = await callDaemonVerb(target, '/api/cluster/rotate', { method: 'POST', body: {}, signal: AbortSignal.abort() }, () => new Promise<Response>(() => {}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not reach');
      // A POST that failed part-way may still have been applied.
      expect(result.fix).toContain('may or may not have been applied');
    }
  });
  test('a failed read does not claim a change may have been applied', async () => {
    const result = await callDaemonVerb(target, '/api/cluster/status', { method: 'GET', signal: AbortSignal.abort() }, () => new Promise<Response>(() => {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fix).not.toContain('may or may not');
  });
});

describe('opening the browser', () => {
  function recordingSpawn() {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return Object.assign(new EventEmitter(), { unref: () => {} });
    }) as never;
    return { calls, spawn };
  }
  test('on Windows an OAuth URL with & goes to the URL handler as one argument, not through cmd', () => {
    const { calls, spawn } = recordingSpawn();
    const url = 'https://auth.example/authorize?client_id=a&redirect_uri=b';
    expect(openBrowser(url, { platform: 'win32', spawn })).toBe('browser open requested');
    expect(calls).toEqual([{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }]);
  });
  test('a caller that wrote the file itself may open its file: address, and nobody else can', () => {
    const { calls, spawn } = recordingSpawn();
    expect(openBrowser('file:///tmp/export.html', { platform: 'linux', spawn, allowFile: true })).toBe('browser open requested');
    expect(calls).toEqual([{ command: 'xdg-open', args: ['file:///tmp/export.html'] }]);
    expect(openBrowser('javascript:alert(1)', { platform: 'linux', spawn, allowFile: true })).toContain('refused');
    expect(calls.length).toBe(1);
  });
  test('an address that is not http or https is refused', () => {
    const { calls, spawn } = recordingSpawn();
    expect(openBrowser('file:///etc/passwd', { platform: 'linux', spawn })).toContain('refused');
    expect(calls).toEqual([]);
  });
});

describe('payments entry', () => {
  test('a model-run /payments card is refused and never asks for concealed input', () => {
    const printed: string[] = [];
    let concealed = 0;
    const prompter = createCardEntryPrompter(async () => { throw new Error('not reached'); }, { prompt: (f) => f.label, stored: () => 'done' });
    const commands = createPaymentCardCommands({
      surface: 'terminal', announcement: 'card entry', promptFields: prompter, status: () => [],
      description: '', usage: '', argsHint: '',
    });
    commands.runPaymentsCommand(['card'], {
      print: (m) => printed.push(m), renderRequest: () => {}, invokedByModel: true,
      beginConcealedInput: () => { concealed++; },
    });
    expect(concealed).toBe(0);
    expect(printed.join('\n')).toContain('typed only by the person');
  });

  test('cancelling while the card is being sent says it may already be stored', async () => {
    const printed: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompter = createCardEntryPrompter(async () => { await gate; throw new Error('daemon unreachable'); }, { prompt: (f) => f.label, stored: () => 'done' });
    const requests: ConcealedInputRequest[] = [];
    const ctx = {
      print: (m: string) => printed.push(m), renderRequest: () => {},
      beginConcealedInput: (r: ConcealedInputRequest) => { requests.push(r); },
    };
    prompter(ctx, CARD_ENTRY_FIELDS, 0);
    const answers = ['groceries', '', '4242424242424242', '09/29', '737', 'Jane Doe'];
    let submitted: Promise<void> | undefined;
    for (const [position, answer] of answers.entries()) {
      const request = requests[position];
      if (!request) throw new Error('the prompter did not ask for input');
      if (position === answers.length - 1) {
        submitted = Promise.resolve(request.onSubmit(answer));
        request.onCancel?.();
      } else {
        await request.onSubmit(answer);
      }
    }
    release();
    await submitted;
    expect(printed.join('\n')).toContain('may have been stored');
    expect(printed.join('\n')).not.toContain('daemon unreachable');
  });
});

describe('companion messages', () => {
  function bus() {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    return { on: (_t: string, l: typeof listener) => { listener = l; return () => {}; }, emit: (payload: unknown) => listener?.({ payload }) };
  }
  const payload = (sessionId: string) => ({ type: 'COMPANION_MESSAGE_RECEIVED', sessionId, messageId: 'm', body: 'hi', source: 's', timestamp: 1 });

  test('a message for another session is not run as input when the terminal names its session', () => {
    const b = bus();
    const handled: string[] = [];
    attachTerminalCompanionInput(b as never, { value: (t) => handled.push(t) }, { addUserMessage: () => {} }, () => {}, undefined, { activeSessionId: () => 'mine' });
    b.emit(payload('other'));
    b.emit(payload('mine'));
    expect(handled).toEqual(['hi']);
  });

  test('a message that arrives before the orchestrator is ready is announced as not processed', () => {
    const b = bus();
    const notices: string[] = [];
    const added: string[] = [];
    attachTerminalCompanionInput(b as never, { value: null }, { addUserMessage: (t) => added.push(t) }, () => {}, undefined, { notice: (t) => notices.push(t) });
    b.emit(payload('mine'));
    expect(added).toEqual(['hi']);
    expect(notices.join('\n')).toContain('no turn was started');
  });
});

describe('control plane seed', () => {
  test('starts not running, at the address the platform would bind', () => {
    const states: Array<Record<string, unknown>> = [];
    const dispatch = { syncControlPlaneState: (s: Record<string, unknown>) => { states.push(s); }, syncControlPlaneClient: () => {} };
    const values: Record<string, unknown> = { 'controlPlane.enabled': true, 'controlPlane.hostMode': 'network', 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 0 };
    seedTerminalControlPlane(dispatch as never, { get: (k: string) => values[k] } as never, 's', { id: 'c', kind: 'service', label: 'l', capabilities: [], metadata: {} } as never);
    expect(states[0]).toMatchObject({ enabled: true, host: '0.0.0.0', port: 3421, isRunning: false });
    expect(states[0]?.connectionState).not.toBe('connected');
  });
});

describe('wake model loading', () => {
  test('sessions already loaded are released when a later load throws', async () => {
    const released: string[] = [];
    const session = (name: string) => ({ inputNames: [], outputNames: [], run: async () => ({}), release: async () => { released.push(name); } });
    const factory = createWakeEngineFactory({
      assetDirectory: '/unused',
      embeddingPath: 'embedding',
      models: [{ id: 'm', path: 'model' }],
      settings: { vadThreshold: 0, tuning: {}, preRollMs: 0 } as never,
      warn: () => {},
      loadSession: async (path) => {
        if (path === 'model') throw new Error('corrupt model');
        return session(path) as never;
      },
    });
    await expect(factory()).rejects.toThrow('corrupt model');
    expect(released).toEqual(['embedding']);
  });
});

describe('retained wake clip', () => {
  test('is written readable by the owner only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-clip-'));
    try {
      retainWakeClip(
        { managedRoot: dir, sessionId: 's1', now: () => 1, warn: (m, meta) => { throw new Error(`${m}: ${meta.error}`); } },
        { samples: new Float32Array(16), sampleRate: 16000, silent: false } as never,
      );
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      const found: string[] = [];
      const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(d, entry.name));
          else found.push(join(d, entry.name));
        }
      };
      walk(dir);
      expect(found.length).toBe(1);
      expect(statSync(found[0]!).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--model inference', () => {
  test('a slash id is not split into a provider by the terminal catalog', () => {
    expect(parseGoodVibesCli(['--model', 'meta-llama/Llama-3.1-8B']).flags.provider).toBeUndefined();
    expect(parseGoodVibesCli(['--model', 'openai:gpt-5']).flags.provider).toBe('openai');
  });

  test('a colon inside a model id is not read as a provider unless the prefix is one', () => {
    expect(parseGoodVibesCli(['--model', 'llama3:8b']).flags.provider).toBeUndefined();
    expect(parseGoodVibesCli(['--model', 'ollama:llama3:8b']).flags.provider).toBe('ollama');
  });
});

describe('copy receipts', () => {
  const actions = createBlockContentActions({
    copyReceipt: true, allowSave: false, requireNearestForToggle: true, saveDisabled: '',
    noteTouch: () => {}, bookmarkTarget: () => '',
  });
  const selection = { hasSelection: () => true, getSelectedText: () => 'hello' } as never;

  function withStdout(write: (chunk: string) => boolean, run: () => void): void {
    const original = process.stdout.write;
    process.stdout.write = write as never;
    try { run(); } finally { process.stdout.write = original; }
  }
  const failing = (): boolean => { throw new Error('EPIPE'); };

  test('a selection copy that could not be written does not report success', () => {
    let copied = 0;
    withStdout(failing, () => actions.handleCopy(selection, (() => ({})) as never, () => {}, () => { copied++; }));
    expect(copied).toBe(0);
  });

  test('a selection copy that was written reports success', () => {
    let copied = 0;
    withStdout(() => true, () => actions.handleCopy(selection, (() => ({})) as never, () => {}, () => { copied++; }));
    expect(copied).toBe(1);
  });

  test('a block copy that could not be written logs a failure instead of a receipt', () => {
    const logged: string[] = [];
    const conversation = {
      findNearestBlock: () => ({ rawContent: 'body', collapseKey: 'k', type: 'assistant' }),
      log: (text: string) => { logged.push(text); },
    } as never;
    let copied = 0;
    withStdout(failing, () => actions.handleBlockCopy(conversation, () => 0, () => {}, () => { copied++; }));
    expect(copied).toBe(0);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('Copy failed');
  });
});
