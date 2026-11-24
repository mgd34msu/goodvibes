/**
 * End-to-end harness: the BUILT goodvibes-agent binary in a real terminal.
 *
 * Every test here drives the compiled artifact (`bun run build:binary`, or
 * GOODVIBES_E2E_BINARY), never the source. The harness owns a Bun.Terminal
 * PTY and its child, including awaited shutdown. Agent's existing TerminalFrame
 * projects the current rendered screen separately from the raw byte stream.
 *
 * Isolation: a fresh temp home per session (HOME points at it), a scratch git
 * workspace, a PATH with nothing extra, launch self-update off, and the daemon
 * port pinned to an unused port so the process can never reach a daemon the
 * machine is already running. The model is a scripted OpenAI-compatible server
 * in this test process (startStubModel).
 */
import { AgentConfigManager } from '../../config/host-settings.ts';
import type { ConfigKey, ConfigValue } from '../../config/index.ts';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { startScriptedDecisionServer, type ScriptedDecisionServer } from '@goodvibes/judgment/testing';
import { createAsyncDisposalScope } from '@goodvibes/engine/platform/platform/runtime/disposal';
import { TerminalFrame } from './terminal-frame.ts';
import { COMPOSER_ECHO } from '../helpers/owner-workspace-startup.ts';
import { WORKSPACE_REGISTRATION_QUESTION } from '../../shell/workspace-registration-question.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const ARTIFACT_BY_PLATFORM: Record<string, string> = {
  'linux-x64': 'goodvibes-agent-linux-x64',
  'linux-arm64': 'goodvibes-agent-linux-arm64',
  'darwin-x64': 'goodvibes-agent-macos-x64',
  'darwin-arm64': 'goodvibes-agent-macos-arm64',
};

/** The newest modification time (ms) of any file under `roots`, skipping directories named in `skip`. 0 when there is none. */
export function newestSourceMtimeMs(roots: readonly string[], skip: ReadonlySet<string> = new Set()): number {
  let newest = 0;
  const visit = (path: string): void => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) visit(child); }
      else if (entry.isFile()) newest = Math.max(newest, statSync(child).mtimeMs);
    }
  };
  for (const root of roots) visit(root);
  return newest;
}

/** Throws when `binary` is older than the newest source it was built from. */
export function assertBinaryFresh(binary: string, newestSourceMs: number): void {
  const builtAt = statSync(binary).mtimeMs;
  if (builtAt < newestSourceMs) {
    throw new Error(`E2E: ${binary} was built ${new Date(builtAt).toISOString()}, before the newest source change ${new Date(newestSourceMs).toISOString()}. Run \`bun run build:binary\` again, or set GOODVIBES_E2E_BINARY.`);
  }
}

/** The newest change under every source tree the Agent binary is compiled from. */
export function newestBuildSourceMtimeMs(): number {
  const engine = join(REPO_ROOT, '..', '..', 'packages', 'engine');
  return newestSourceMtimeMs([join(REPO_ROOT, 'src'), join(engine, 'platform', 'src'), join(engine, 'terminal-shell', 'src'), ...['errors', 'operator-client', 'transport-core', 'transport-http', 'transport-realtime', 'daemon-api', 'contracts'].map((name) => join(engine, name, 'src')), join(engine, '..', 'judgment', 'src')], new Set(['test', 'node_modules']));
}

/** The platform's built Agent artifact (`bun run build:binary`), when one exists. */
export function builtAgentBinary(): string | undefined {
  const path = join(REPO_ROOT, 'dist', ARTIFACT_BY_PLATFORM[`${process.platform}-${process.arch}`] ?? 'goodvibes-agent-linux-x64');
  return existsSync(path) ? path : undefined;
}

let sourceChecked = false;
/**
 * The compiled binary under test: GOODVIBES_E2E_BINARY, else the platform
 * artifact (`bun run build:binary`), else the legacy native output.
 * Fails loudly when none has been built, or (for a dist/ binary, outside CI)
 * when sources changed after it was built. An explicit GOODVIBES_E2E_BINARY is
 * trusted: CI builds it from the same commit.
 */
export function resolveBinary(): string {
  const fromEnv = process.env['GOODVIBES_E2E_BINARY'];
  const candidates = fromEnv
    ? [resolve(fromEnv)]
    : [
      join(REPO_ROOT, 'dist', ARTIFACT_BY_PLATFORM[`${process.platform}-${process.arch}`] ?? 'goodvibes-agent-linux-x64'),
      join(REPO_ROOT, 'dist', 'goodvibes-agent'),
    ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`E2E: no built binary at ${candidates.join(' or ')}. Run \`bun run build:binary\` first, or set GOODVIBES_E2E_BINARY.`);
  }
  if (!fromEnv && !process.env['CI'] && !sourceChecked) {
    assertBinaryFresh(found, newestBuildSourceMtimeMs());
    sourceChecked = true;
  }
  return found;
}

/** The version the binary under test reports (`--version`), for screen assertions. */
export function binaryVersion(): string {
  const out = spawnSync(resolveBinary(), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  const match = /goodvibes-agent\s+(\S+)/.exec(out.stdout);
  if (!match) throw new Error(`E2E: --version printed no version: ${out.stdout}${out.stderr}`);
  return match[1]!;
}

/** A TCP port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}


// ── the scripted model ──────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly tools: readonly unknown[];
}

/** One scripted answer: plain text, or tool calls the agent should run. */
export type ModelReply =
  | { readonly text: string }
  | { readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: Record<string, unknown> }> };

export interface StubModel {
  readonly baseURL: string;
  readonly requests: ModelRequest[];
  stop(): void | Promise<void>;
}

/** Text of a message's content, whether a string or content parts. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** The last user message of a request. */
export function lastUserText(request: ModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    if (request.messages[i]!.role === 'user') return messageText(request.messages[i]!);
  }
  return '';
}

/**
 * An OpenAI-compatible chat-completions server on an ephemeral port. `answer`
 * decides every reply from the request; it answers the stream shape the
 * request asked for.
 */
export function startStubModel(answer: (request: ModelRequest, index: number) => ModelReply | Promise<ModelReply>): StubModel {
  const requests: ModelRequest[] = [];
  let callId = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const body = await req.json().catch(() => ({})) as { messages?: ChatMessage[]; stream?: boolean; tools?: unknown[] };
      const request: ModelRequest = { messages: body.messages ?? [], stream: body.stream === true, tools: body.tools ?? [] };
      const index = requests.length;
      requests.push(request);
      const reply = await answer(request, index);
      const created = Math.floor(Date.now() / 1000);
      const toolCalls = 'toolCalls' in reply
        ? reply.toolCalls.map((call, i) => ({
          index: i,
          id: `call_${++callId}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }))
        : undefined;
      const content = 'text' in reply ? reply.text : '';
      const finish = toolCalls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (request.stream) {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}): string => `data: ${JSON.stringify({
          id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created, model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra,
        })}\n\n`;
        const first = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content };
        const payload = chunk(first, null) + chunk({}, finish, { usage }) + 'data: [DONE]\n\n';
        return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'chatcmpl-e2e', object: 'chat.completion', created, model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : content, tool_calls: toolCalls }, finish_reason: finish }],
        usage,
      });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

// ── the daemon's front door ─────────────────────────────────────────────────

export { createDaemonDoor, type DaemonDoor } from './daemon-door.ts';

// ── the isolated home ───────────────────────────────────────────────────────

export interface E2EHome {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly daemonPort: number;
  /** The daemon's own state directory inside the isolated home. */
  readonly daemonHome: string;
  /** The decision model the binary asks (TYPESAFE_BASE_URL): scripted answers on the HTTP wire. */
  readonly judgments: ScriptedDecisionServer;
  readonly networkViolations: string;
  /** Write a settings key (dot path) into the Agent's settings file. */
  setAgentSetting(key: string, value: unknown): void;
  /** Write a key only the daemon's settings file sets (judgment.policy, hostedSessions.*), as the Agent's own write does with no daemon running. */
  setDaemonOwnedSetting<K extends ConfigKey>(key: K, value: ConfigValue<K>): void;
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function mergeJson(path: string, key: string, value: unknown): void {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  setDotted(current, key, value);
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * A fresh home with the scripted model registered as a custom provider and
 * selected, onboarding already finished, launch self-update off, and the daemon
 * port pinned to an unused port. The scratch workspace is new to this home, so
 * the first-start workspace question is asked (see answerWorkspaceQuestion).
 */
export async function makeHome(model: StubModel): Promise<E2EHome> {
  const root = mkdtempSync(join(tmpdir(), 'gv-agent-e2e-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const agentDir = join(home, '.goodvibes', 'agent');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  mkdirSync(join(agentDir, 'providers'), { recursive: true });
  mkdirSync(daemonHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = E2E Owner\n\temail = e2e@example.test\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), '# e2e workspace\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  writeFileSync(join(agentDir, 'providers', 'e2e-stub.json'), JSON.stringify({
    name: 'e2e-stub',
    displayName: 'E2E Stub',
    type: 'openai-compat',
    baseURL: model.baseURL,
    apiKey: 'e2e-not-a-secret',
    models: [{
      id: 'stub-model',
      displayName: 'Stub Model',
      contextWindow: 64_000,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    }],
  }, null, 2));
  const now = Date.now();
  writeFileSync(join(agentDir, 'onboarding-complete.json'), JSON.stringify({ version: 1, checkedAt: now, updatedAt: now, source: 'wizard' }));
  const daemonPort = await freePort();
  const settingsPath = join(agentDir, 'settings.json');
  const e2eHome: E2EHome = {
    root, home, workspace, daemonPort, daemonHome,
    judgments: startScriptedDecisionServer(),
    networkViolations: join(root, 'network-violations.log'),
    setAgentSetting: (key, value) => mergeJson(settingsPath, key, value),
    setDaemonOwnedSetting(key, value) {
      new AgentConfigManager({ configDir: agentDir, homeDir: home, workingDir: workspace, surfaceRoot: 'agent' })
        .set(key, value, { daemonNotRunning: true });
    },
  };
  e2eHome.setAgentSetting('provider.model', 'e2e-stub:stub-model');
  // A test home has no network: start-up keeps the saved model lists and catalog seeded below.
  e2eHome.setAgentSetting('provider.refreshListsAtStart', false);
  mergeJson(join(daemonHome, 'settings.json'), 'provider.refreshListsAtStart', false);
  // The self-update switches are daemon settings, read by every program from the daemon's file.
  mergeJson(join(daemonHome, 'settings.json'), 'update.auto', false);
  mergeJson(join(daemonHome, 'settings.json'), 'update.autoUpdateAtLaunch', false);
  // The daemon's settings file owns controlPlane.*; the Agent reads it there.
  mergeJson(join(daemonHome, 'settings.json'), 'controlPlane.host', '127.0.0.1');
  mergeJson(join(daemonHome, 'settings.json'), 'controlPlane.port', daemonPort);
  for (const surfaceRoot of ['agent', 'goodvibes'] as const) {
    const configManager = new AgentConfigManager({ configDir: join(home, '.goodvibes', surfaceRoot), homeDir: home, workingDir: workspace, surfaceRoot });
    seedProviderMetadataCacheFixture({ configManager, homeDirectory: home, workingDirectory: workspace, surfaceRoot });
    seedProviderModelListCacheFixture(configManager, 'openai');
  }
  // Compiled Bun executables honor the workspace preload, too. The existing
  // owned runner's guard blocks every unexpected external request, even if a
  // product catches the fetch error; removeHome verifies its durable log.
  const guard = resolve(REPO_ROOT, '../../packages/engine/toolchain/src/test-runner/test-network-preload.ts');
  writeFileSync(join(workspace, 'bunfig.toml'), `preload = [${JSON.stringify(guard)}]\n`);
  return e2eHome;
}

/** The environment the binary runs in: the isolated home and nothing ambient. */
export function isolatedEnv(e2eHome: E2EHome, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: e2eHome.home,
    GOODVIBES_WORKING_DIR: e2eHome.workspace,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: join(e2eHome.root, 'tmp'),
    TYPESAFE_API_KEY: 'local-e2e-judgment-fixture-not-a-secret',
    TYPESAFE_BASE_URL: e2eHome.judgments.baseURL,
    GOODVIBES_TEST_NETWORK_VIOLATIONS: e2eHome.networkViolations,
    ...extra,
  };
}

// ── the terminal ────────────────────────────────────────────────────────────

let sessionCounter = 0;

export interface AgentSession {
  /** The rendered screen, one string per row. */
  screen(): string;
  /** Everything the program wrote to the terminal so far, escape sequences included. */
  rawOutput(): string;
  /** What the binary wrote to stderr. */
  stderr(): string;
  type(text: string): void;
  key(name: string): void;
  /**
   * Resolves with the screen once `predicate` holds after a write; rejects if the
   * binary exits first. `poke` runs before each wait, for a probe resent until seen.
   * The file's own limit bounds it.
   */
  waitForScreen(what: string, predicate: (screen: string) => boolean, poke?: () => void): Promise<string>;
  /** Resize the real PTY and the current-screen projection together. */
  resize(cols: number, rows: number): void;
  /** True while the owned binary is still running. */
  alive(): boolean;
  stop(): Promise<void>;
}

/** Launch the built binary in an owned real PTY at `cols` x `rows`. */
export function launchAgent(e2eHome: E2EHome, options: { cols?: number; rows?: number; env?: Record<string, string> } = {}): AgentSession {
  const binary = resolveBinary();
  mkdirSync(join(e2eHome.root, 'tmp'), { recursive: true });
  const stderrPath = join(e2eHome.root, `agent-${++sessionCounter}.stderr`);
  const frame = new TerminalFrame(options.cols ?? 100, options.rows ?? 30);
  const decoder = new TextDecoder();
  let output = '';
  let stopped: Promise<void> | undefined;
  // Every write the program makes wakes the waiters, so a wait checks the screen
  // exactly when it can have changed and never on a timer.
  let changed = Promise.withResolvers<void>();
  // The shell immediately execs the actual artifact. Redirect stderr separately
  // so the existing stderr assertions retain their meaning with a PTY.
  const child = Bun.spawn(['/bin/sh', '-c', 'exec "$1" 2>"$2"', 'agent-e2e', binary, stderrPath], {
    cwd: e2eHome.workspace,
    env: isolatedEnv(e2eHome, options.env),
    terminal: { cols: options.cols ?? 100, rows: options.rows ?? 30,
      data(terminal, bytes) {
        const chunk = decoder.decode(bytes, { stream: true });
        output += chunk;
        frame.write(chunk, reply => terminal.write(reply));
        const wake = changed; changed = Promise.withResolvers<void>(); wake.resolve();
      },
    },
  });
  const exited = child.exited.then((code) => { throw new Error(`E2E: the binary exited (${code}) before the screen showed what was awaited`); });
  void exited.catch(() => {});
  const readStderr = (): string => (existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '');
  const keys: Record<string, string> = { Enter: '\r', Up: '\x1b[A', Down: '\x1b[B', Escape: '\x1b', 'C-u': '\x15', 'C-c': '\x03' };
  const session: AgentSession = {
    screen: () => frame.text(),
    rawOutput: () => output,
    stderr: readStderr,
    type: text => { child.terminal!.write(text); },
    key: name => {
      const bytes = keys[name];
      if (bytes === undefined) throw new Error(`E2E: unsupported terminal key ${name}`);
      child.terminal!.write(bytes);
    },
    resize: (cols, rows) => { frame.resize(cols, rows); child.terminal!.resize(cols, rows); },
    waitForScreen: async (what, predicate, poke) => {
      try {
        while (!predicate(session.screen())) {
          const next = changed.promise;
          poke?.();
          await Promise.race([next, exited]);
        }
        return session.screen();
      } catch (error) {
        throw new Error(`waiting for ${what}: ${String(error)}\n--- screen ---\n${session.screen()}\n--- stderr ---\n${readStderr().slice(-2000)}`);
      }
    },
    alive: () => child.exitCode === null && child.signalCode === null,
    stop: () => stopped ??= (async () => {
      try {
        if (session.alive()) child.kill('SIGTERM');
        await child.exited;
      } finally { child.terminal?.close(); }
    })(),
  };
  return session;
}

/** The input area is on screen: its placeholder text. */
export function inputAreaVisible(screen: string): boolean {
  return screen.includes('Ask anything, or type / for commands');
}

/** The first-start question, as it is drawn: a modal titled with the question. */
export const WORKSPACE_QUESTION = WORKSPACE_REGISTRATION_QUESTION;

/**
 * Wait for the first-start workspace question and answer it: Enter on the
 * preselected "Not here", or move up and Enter for "Register". Returns once the
 * modal is gone and the input area is back.
 */
export async function answerWorkspaceQuestion(session: AgentSession, answer: 'decline' | 'register'): Promise<string> {
  const asked = await session.waitForScreen('the workspace question', (s) => {
    // The title paints before its options; an answer sent before both are on
    // screen could land on a modal that has not yet taken its selection.
    const text = screenText(s);
    return text.includes(WORKSPACE_QUESTION) && text.includes('Not here');
  });
  if (answer === 'register') session.key('Up');
  session.key('Enter');
  await session.waitForScreen('the question answered', (s) => !screenText(s).includes(WORKSPACE_QUESTION) && inputAreaVisible(s));
  // First paint can precede stdin subscription. Prove the real composer echoes
  // unsent input before giving it the owner's first prompt, then clear it.
  await session.waitForScreen('live composer input', s => s.includes(COMPOSER_ECHO), () => { session.key('C-u'); session.type('x'); });
  session.key('C-u');
  await session.waitForScreen('empty live composer', s => inputAreaVisible(s) && !s.includes(COMPOSER_ECHO) && !s.includes(WORKSPACE_QUESTION));
  return asked;
}

/** Words of the screen joined across wraps, for assertions on text that may wrap. */
export function screenText(screen: string): string {
  return screen.split('\n').map((line) => line.trim()).join(' ').replace(/\s+/g, ' ');
}

/** Remove a home made by makeHome. */
export async function removeHome(e2eHome: E2EHome | null): Promise<void> {
  if (!e2eHome) return;
  await e2eHome.judgments.stop();
  const violations = existsSync(e2eHome.networkViolations) ? readFileSync(e2eHome.networkViolations, 'utf8') : '';
  rmSync(e2eHome.root, { recursive: true, force: true });
  e2eHome.judgments.assertNoUnexpected();
  if (violations.trim()) throw new Error(`E2E attempted unexpected external requests:\n${violations}`);
}

/** Drain original fixture owners in dependency order before removing their home.
 * Every stop is attempted; failed/unknown drains preserve the home for diagnosis. */
export async function closeE2EFixture(home: E2EHome | null, ...stops: readonly (() => void | Promise<void>)[]): Promise<void> {
  const scope = createAsyncDisposalScope('Agent E2E fixture');
  scope.registry.add('decision server', () => home?.judgments.stop());
  for (let index = stops.length - 1; index >= 0; index--) scope.registry.add(`owner ${index + 1}`, stops[index]!);
  await scope.close();
  await removeHome(home);
}
