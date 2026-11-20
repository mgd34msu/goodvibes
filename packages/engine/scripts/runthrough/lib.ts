/**
 * Shared pieces of the product run-through: an isolated home per run, the
 * settings that point every product at this run's own loopback ports and the
 * scripted model, starting and stopping the daemon from the checkout as a
 * child process, running the headless commands, and PASS/FAIL bookkeeping.
 *
 * Nothing here reads or writes the login home: HOME, GOODVIBES_HOME,
 * GOODVIBES_DAEMON_HOME, the XDG directories and TMPDIR all point inside the
 * run's root, and every product process loads guard.ts, which refuses any
 * connection that is not to a loopback port this run opened.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';

export const REPO = resolve(import.meta.dir, '../../../..');
export const TUI_ENTRY = join(REPO, 'products/tui/src/main.ts');
export const AGENT_ENTRY = join(REPO, 'products/agent/src/main.ts');
export const DAEMON_ENTRY = join(REPO, 'products/daemon/src/cli/entrypoint.ts');
const GUARD = join(import.meta.dir, 'guard.ts');

export const PROVIDER_ID = 'rtfake';
export const MODEL_ID = 'rt-1';

/** Free loopback ports; each is added to the guard's allow list. */
export function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface Home {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly daemonHome: string;
  readonly ports: { controlPlane: number; http: number; web: number };
  readonly env: Record<string, string>;
  /** Ports the guard allows (this run's listeners). */
  readonly allowed: Set<number>;
  /** Write or merge a surface's settings file (tui, agent, daemon-host). */
  settings(surface: 'tui' | 'agent' | 'daemon-host', values: Record<string, unknown>): void;
  allow(port: number): void;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      target[key] = deepMerge({ ...current as Record<string, unknown> }, value as Record<string, unknown>);
    } else target[key] = value;
  }
  return target;
}

/** A short symlink to `target` beside the scratch folder's temp root (/tmp/claude-<uid> when it exists). */
function shortTempLink(target: string): string {
  if (target.length < 48) return target;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const base = existsSync(`/tmp/claude-${uid}`) ? `/tmp/claude-${uid}` : '/tmp';
  const link = join(base, `rt-${Math.random().toString(16).slice(2, 8)}`);
  symlinkSync(target, link);
  shortLinks.push(link);
  return link;
}
const shortLinks: string[] = [];
process.on('exit', () => { for (const link of shortLinks) { try { unlinkSync(link); } catch { /* already gone */ } } });

export interface HomeOptions {
  readonly modelBaseURL: string;
  readonly permissionsMode?: string;
  /**
   * 'off': no decision model ("No Decision Model"). A URL points Jev at that loopback endpoint.
   * Unset: the run's choice, RUNTHROUGH_POLICY (default "No Decision Model") with, when
   * RUNTHROUGH_DECISION_URL names one, the scripted decision model (fake-decision.ts).
   */
  readonly judgment?: 'off' | { endpoint: string; policy?: string };
  readonly extraSettings?: Record<string, unknown>;
  /** Share another home's ports (a second app attached to the same daemon). */
  readonly ports?: { controlPlane: number; http: number; web: number };
}

/** A fresh isolated tree under `base/name`. Refuses any root outside the scratch base. */
export function makeHome(base: string, name: string, options: HomeOptions): Home {
  const root = join(base, name);
  if (!root.startsWith(base) || root.startsWith('/home/') && !root.includes('/scratchpad/')) throw new Error(`refusing home outside the scratch base: ${root}`);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  for (const dir of [home, workspace, daemonHome, join(root, 'tmp'), join(home, '.config'), join(home, '.cache'), join(home, '.local/share'), join(home, '.local/state')]) mkdirSync(dir, { recursive: true });
  // Unix socket paths (a browser's singleton socket) are limited to about 100
  // bytes, and the scratch folder alone is near that: the processes get a short
  // link to this home's temp folder as TMPDIR.
  const tmp = shortTempLink(join(root, 'tmp'));
  const ports = options.ports ?? { controlPlane: freePort(), http: freePort(), web: freePort() };
  const allowed = new Set<number>([ports.controlPlane, ports.http, ports.web, Number(new URL(options.modelBaseURL).port)]);
  const runDecisionUrl = options.judgment === undefined ? process.env.RUNTHROUGH_DECISION_URL : undefined;
  if (runDecisionUrl) allowed.add(Number(new URL(runDecisionUrl).port));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C.UTF-8', TERM: 'dumb', TZ: 'UTC', NO_COLOR: '1',
    HOME: home, USERPROFILE: home,
    GOODVIBES_HOME: home,
    GOODVIBES_DAEMON_HOME: daemonHome,
    GOODVIBES_WORKING_DIR: workspace,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_RUNTIME_DIR: tmp,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    RT_FAKE_API_KEY: 'rt-local-key',
    BUN_OPTIONS: `--preload ${GUARD}`,
  };
  const providerFile = {
    name: PROVIDER_ID, displayName: 'Run-through scripted model', type: 'openai-compat',
    baseURL: options.modelBaseURL, apiKeyEnv: 'RT_FAKE_API_KEY',
    models: [{ id: MODEL_ID, displayName: MODEL_ID, description: 'scripted', contextWindow: 200000,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
  };
  const judgment = options.judgment === undefined
    ? { policy: process.env.RUNTHROUGH_POLICY || 'No Decision Model', ...(runDecisionUrl ? { endpoint: runDecisionUrl, keySource: 'none', model: 'rt-jev' } : {}) }
    : options.judgment === 'off'
    ? { policy: 'No Decision Model' }
    // No policy: the default, which is what a person who set a decision model has.
    : { ...(options.judgment.policy ? { policy: options.judgment.policy } : {}), endpoint: options.judgment.endpoint, keySource: 'none', model: 'rt-jev' };
  const common: Record<string, unknown> = {
    provider: { model: `${PROVIDER_ID}:${MODEL_ID}` },
    ...(options.permissionsMode ? { permissions: { mode: options.permissionsMode } } : {}),
  };
  if (options.extraSettings) deepMerge(common, options.extraSettings);
  const value: Home = {
    root, home, workspace, daemonHome, ports, env, allowed,
    settings(surface, values) {
      const dir = join(home, '.goodvibes', surface);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'settings.json');
      const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
      writeFileSync(file, `${JSON.stringify(deepMerge(current, values), null, 2)}\n`);
    },
    allow(port) { allowed.add(port); },
  };
  // Decision-model settings are the daemon's own (config-ownership.ts): its tier is the daemon home's settings file.
  // So are the listener ports, which every app reads to find the daemon.
  writeFileSync(join(daemonHome, 'settings.json'), `${JSON.stringify({
    judgment,
    controlPlane: { host: '127.0.0.1', port: ports.controlPlane },
    httpListener: { host: '127.0.0.1', port: ports.http },
    web: { host: '127.0.0.1', port: ports.web },
  }, null, 2)}\n`);
  for (const surface of ['tui', 'agent', 'daemon-host'] as const) {
    value.settings(surface, common);
    mkdirSync(join(home, '.goodvibes', surface, 'providers'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', surface, 'providers', `${PROVIDER_ID}.json`), `${JSON.stringify(providerFile, null, 2)}\n`);
  }
  return value;
}

/** Loopback ports listening before the run started (the owner's services): the guard refuses them. */
function listeningPorts(): Set<number> {
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && fields[1]) ports.add(parseInt(fields[1].split(':').at(-1) ?? '0', 16));
    }
  }
  return ports;
}
const PREEXISTING_PORTS = listeningPorts();

function envFor(home: Home, extra: Record<string, string> = {}): Record<string, string> {
  const deny = [...PREEXISTING_PORTS].filter((port) => !home.allowed.has(port));
  return { ...home.env, RUNTHROUGH_DENY_PORTS: deny.join(','), ...extra };
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  /** The last JSON line of stdout, when there is one. */
  readonly json: Record<string, unknown> | null;
  /** Every JSON line of stdout (stream-json frames). */
  readonly frames: Array<Record<string, unknown>>;
}

function parseLines(stdout: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { frames.push(JSON.parse(trimmed) as Record<string, unknown>); } catch { /* not a frame */ }
  }
  return frames;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  /** Called with each stdout line as it arrives (stream-json). Return a string to write it to stdin. */
  readonly onLine?: (line: string, child: Subprocess<'pipe', 'pipe', 'pipe'>) => void;
  /** Kill the process (SIGKILL) when this returns true for a stdout line. */
  readonly killWhen?: (line: string) => boolean;
  readonly signalWhen?: { readonly test: (line: string) => boolean; readonly signal: NodeJS.Signals };
  readonly cwd?: string;
}

/** Run one product command to completion in the isolated home. */
export async function runProduct(home: Home, entry: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  const child = Bun.spawn([process.execPath, '--no-env-file', entry, ...args], {
    cwd: options.cwd ?? home.workspace, env: envFor(home, options.env), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  if (options.stdin !== undefined && !options.onLine) { child.stdin.write(options.stdin); await child.stdin.end(); }
  const killer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
  let stdout = '';
  let buffered = '';
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      buffered += text;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        options.onLine?.(line, child);
        if (options.killWhen?.(line)) child.kill('SIGKILL');
        if (options.signalWhen?.test(line)) child.kill(options.signalWhen.signal);
      }
    }
  })();
  const stderrText = new Response(child.stderr).text();
  const code = await child.exited;
  clearTimeout(killer);
  await reading;
  const stderr = await stderrText;
  const frames = parseLines(stdout);
  return { code, stdout, stderr, ms: Math.round(performance.now() - t0), json: frames.at(-1) ?? null, frames };
}

export interface Daemon {
  readonly pid: number;
  readonly baseUrl: string;
  readonly output: () => string;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

/**
 * Start the daemon from the checkout in the foreground, bound to 127.0.0.1 on
 * this home's port. A checkout someone is editing can fail to build for a
 * moment; that (and only that) is retried for up to two minutes.
 */
export async function startDaemon(home: Home, extraArgs: readonly string[] = [], extraEnv: Record<string, string> = {}): Promise<Daemon> {
  for (let attempt = 0; ; attempt++) {
    try { return await startDaemonOnce(home, extraArgs, extraEnv); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 8 || !/errors? building|Cannot find module|SyntaxError/.test(message)) throw error;
      process.stdout.write(`[runthrough] the checkout does not build right now (${message.split('\n').find((line) => /building|Cannot find|SyntaxError/.test(line))?.slice(0, 160)}); retrying in 15 s\n`);
      await Bun.sleep(15_000);
    }
  }
}

async function startDaemonOnce(home: Home, extraArgs: readonly string[], extraEnv: Record<string, string>): Promise<Daemon> {
  const child = Bun.spawn([process.execPath, '--no-env-file', DAEMON_ENTRY, 'serve', '--port', String(home.ports.controlPlane), '--hostname', '127.0.0.1', ...extraArgs], {
    cwd: home.workspace, env: envFor(home, extraEnv), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  let output = '';
  const decoder = new TextDecoder();
  let ready = false;
  const logFile = join(home.root, 'daemon.log');
  void (async () => { for await (const chunk of child.stdout) { const text = decoder.decode(chunk); output += text; appendFileSync(logFile, text); if (/host started \((ready|degraded)\)/.test(output)) ready = true; } })();
  void (async () => { for await (const chunk of child.stderr) { const text = decoder.decode(chunk); output += text; appendFileSync(logFile, text); } })();
  const deadline = Date.now() + 60_000;
  while (!ready && Date.now() < deadline && child.exitCode === null) await Bun.sleep(100);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`daemon did not start (exit ${child.exitCode}): ${output.slice(-1500)}`);
  }
  const stopWith = async (signal: NodeJS.Signals) => {
    child.kill(signal);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    await child.exited;
    clearTimeout(timer);
  };
  return {
    pid: child.pid,
    baseUrl: `http://127.0.0.1:${home.ports.controlPlane}`,
    output: () => output,
    stop: () => stopWith('SIGTERM'),
    kill: () => stopWith('SIGKILL'),
  };
}

/** The operator token the daemon minted in its own home (what the apps on this machine use). */
export function operatorToken(home: Home): string {
  const file = join(home.daemonHome, 'operator-tokens.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const candidates = [parsed.token, (parsed as { operator?: { token?: unknown } }).operator?.token, ...(Array.isArray(parsed.tokens) ? (parsed.tokens as Array<{ token?: unknown }>).map((entry) => entry.token) : [])];
  const token = candidates.find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (!token) throw new Error(`no operator token in ${file} (keys: ${Object.keys(parsed).join(', ')})`);
  return token;
}

export async function api(daemon: Daemon, token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* text */ }
  return { status: response.status, body: parsed, text };
}

export interface Step { readonly journey: string; readonly step: string; readonly ran: string; readonly got: string; readonly pass: boolean; readonly reason?: string }

export class Journey {
  readonly steps: Step[] = [];
  constructor(readonly name: string) {}
  check(step: string, ran: string, got: string, pass: boolean, reason?: string): boolean {
    const entry: Step = { journey: this.name, step, ran, got: got.length > 2000 ? `${got.slice(0, 2000)}...` : got, pass, ...(reason ? { reason } : {}) };
    this.steps.push(entry);
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} [${this.name}] ${step}${pass ? '' : ` -- ${reason ?? got.slice(0, 300)}`}\n`);
    return pass;
  }
  get failed(): boolean { return this.steps.some((step) => !step.pass); }
  finish(base: string): never {
    writeFileSync(join(base, `${this.name}.result.json`), `${JSON.stringify(this.steps, null, 2)}\n`);
    process.stdout.write(`${this.failed ? 'FAIL' : 'PASS'} ${this.name}: ${this.steps.filter((step) => step.pass).length}/${this.steps.length} steps\n`);
    process.exit(this.failed ? 1 : 0);
  }
}

/** The run's scratch base: RUNTHROUGH_DIR, else a folder under the system temp directory. */
export function scratchBase(): string {
  const base = process.env.RUNTHROUGH_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'goodvibes-runthrough');
  mkdirSync(base, { recursive: true });
  return base;
}

export function short(value: unknown, max = 400): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').length > max ? `${(text ?? '').slice(0, max)}...` : (text ?? '');
}

export interface Stage {
  readonly base: string;
  readonly home: Home;
  readonly daemon: Daemon;
  readonly model: import('./fake-model.ts').FakeModel;
  /** Register the workspace for native work, as `goodvibes-agent workspaces register --yes` does. */
  registerWorkspace(): Promise<RunResult>;
  /** Stop and start the daemon; `crash` kills it (SIGKILL) instead of stopping it. */
  restartDaemon(options?: { readonly crash?: boolean }): Promise<Daemon>;
  close(): Promise<void>;
}

/** Scripted model, isolated home and a running daemon for one journey. */
export async function stage(name: string, options: Omit<HomeOptions, 'modelBaseURL'> = {}): Promise<Stage> {
  const { startFakeModel } = await import('./fake-model.ts');
  const base = scratchBase();
  const model = startFakeModel(MODEL_ID);
  const home = makeHome(base, name, { ...options, modelBaseURL: model.baseURL });
  let daemon = await startDaemon(home);
  process.stdout.write(`[${name}] home ${home.home}; daemon pid ${daemon.pid} on ${daemon.baseUrl}; model on ${model.baseURL}\n`);
  return {
    base, home, model,
    get daemon() { return daemon; },
    registerWorkspace: () => runProduct(home, AGENT_ENTRY, ['workspaces', 'register', '--yes']),
    async restartDaemon(options) {
      if (options?.crash) await daemon.kill(); else await daemon.stop();
      daemon = await startDaemon(home);
      return daemon;
    },
    async close() { await daemon.stop(); model.stop(); },
  };
}

/** Stream frames of one type. */
export function framesOf(result: RunResult, type: string): Array<Record<string, unknown>> {
  return result.frames.filter((frame) => frame.type === type);
}

/**
 * `onLine` handler for `run --answer-permissions`: answers each PERMISSION_PROMPT
 * frame with `decide(frame)` and records the prompts it saw.
 */
export function permissionAnswerer(decide: (frame: Record<string, unknown>) => boolean, seen: Array<Record<string, unknown>> = []): NonNullable<RunOptions['onLine']> {
  return (line, child) => {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (frame.type !== 'PERMISSION_PROMPT') return;
    seen.push(frame);
    child.stdin.write(`${JSON.stringify({ type: 'PERMISSION_ANSWER', callId: frame.callId, approved: decide(frame) })}\n`);
    void child.stdin.flush();
  };
}

export async function invoke(daemon: Daemon, token: string, method: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown; text: string }> {
  return api(daemon, token, 'POST', `/api/control-plane/methods/${method}/invoke`, { body });
}

/** Approve every pending approval on the daemon (the owner answering in an app); returns what was approved. */
export async function approvePending(daemon: Daemon, token: string, decide: (approval: Record<string, unknown>) => boolean = () => true): Promise<Array<Record<string, unknown>>> {
  const listed = await api(daemon, token, 'GET', '/api/approvals');
  const body = listed.body as { approvals?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const approvals = Array.isArray(body) ? body : body.approvals ?? [];
  const answered: Array<Record<string, unknown>> = [];
  for (const approval of approvals) {
    if (approval.status !== 'pending' || typeof approval.id !== 'string') continue;
    const verb = decide(approval) ? 'approve' : 'deny';
    // As the web UI's approve and deny buttons send it: an explicit owner decision.
    const result = await api(daemon, token, 'POST', `/api/approvals/${encodeURIComponent(approval.id)}/${verb}`,
      { disposition: verb === 'approve' ? 'approved' : 'denied', expectedRevision: approval.revision });
    if (result.status < 300) answered.push(approval);
  }
  return answered;
}

/** Poll until `probe` returns a value (not undefined) or the time runs out. */
export async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number, everyMs = 250): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) return undefined;
    await Bun.sleep(everyMs);
  }
}

export interface NativeTurn {
  readonly projectId: string;
  readonly inputId: string;
  readonly requestId: string;
  readonly sourceRevision: unknown;
  readonly start: { status: number; body: unknown; text: string };
}

/**
 * Send one message the way the web UI and the attached Agent do: capture it
 * through native intake, admit it, and start its hosted turn on the daemon
 * (`continuationSessionId` continues that hosted session).
 */
export async function sendNativeHostedTurn(daemon: Daemon, token: string, text: string, continuationSessionId?: string, asAgent = false): Promise<NativeTurn> {
  const requestId = crypto.randomUUID();
  const inputId = crypto.randomUUID();
  const capture = await api(daemon, token, 'POST', '/api/work-ledger/intake/capture', {
    requestId, inputId, text, unsupportedSources: [], ...(continuationSessionId ? { continuation: { sessionId: continuationSessionId } } : {}),
  });
  if (capture.status !== 200) throw new Error(`capture ${capture.status}: ${capture.text.slice(0, 400)}`);
  let result = capture.body as { kind: string; projectId: string; sourceRef: { sourceRevision: unknown } };
  if (result.kind === 'captured') {
    const admit = await api(daemon, token, 'POST', '/api/work-ledger/intake/admit', { inputId, sourceRevision: result.sourceRef.sourceRevision });
    if (admit.status !== 200) throw new Error(`admit ${admit.status}: ${admit.text.slice(0, 400)}`);
    result = admit.body as typeof result;
  }
  if (result.kind !== 'turn') throw new Error(`the host did not admit a conversation turn: ${JSON.stringify(result).slice(0, 400)}`);
  const target = { projectId: result.projectId, inputId, sourceRevision: result.sourceRef.sourceRevision };
  // The Agent starts its hosted turns as the GoodVibes Agent (its tools and prompt); the web UI as itself.
  const start = await api(daemon, token, 'POST', asAgent ? '/api/work-ledger/turn/startAgent' : '/api/work-ledger/turn/start', target);
  return { projectId: result.projectId, inputId, requestId, sourceRevision: result.sourceRef.sourceRevision, start };
}

/** The hosted turn's snapshot (state, sessionId, failure). */
export async function nativeTurnStatus(daemon: Daemon, token: string, turn: NativeTurn): Promise<Record<string, unknown>> {
  const status = await api(daemon, token, 'POST', '/api/work-ledger/turn/status', { projectId: turn.projectId, inputId: turn.inputId, sourceRevision: turn.sourceRevision });
  return status.body as Record<string, unknown>;
}

/** The cluster routes answer `{ ok, data }`. */
function clusterData<T>(body: unknown): T {
  const wrapped = body as { data?: unknown } | null;
  return (wrapped && typeof wrapped === 'object' && 'data' in wrapped ? wrapped.data : body) as T;
}

export interface GroupNode {
  readonly name: string;
  readonly home: Home;
  daemon: Daemon;
  readonly token: string;
  /** This node's cluster node id (`cluster nodes`). */
  readonly nodeId: string;
  /** Restart this node's daemon; `crash` kills it (SIGKILL) first. */
  restart(options?: { readonly crash?: boolean }): Promise<Daemon>;
}

export interface Group {
  readonly base: string;
  readonly nodes: readonly GroupNode[];
  readonly model: import('./fake-model.ts').FakeModel;
  close(): Promise<void>;
}

/**
 * `names.length` daemons from the checkout in one group: each with its own
 * isolated home, cluster on, unicast peers on loopback (no multicast needed),
 * the first creating the group and the others joining with its join key.
 * Resolves once every node lists all of them as members.
 */
export async function startGroup(names: readonly string[], options: Omit<HomeOptions, 'modelBaseURL'> = {}): Promise<Group> {
  const { startFakeModel } = await import('./fake-model.ts');
  const base = scratchBase();
  const model = startFakeModel(MODEL_ID);
  const udp = names.map(() => freePort());
  const nodes: GroupNode[] = [];
  for (const [index, name] of names.entries()) {
    const home = makeHome(base, name, { ...options, modelBaseURL: model.baseURL });
    const file = join(home.daemonHome, 'settings.json');
    const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, `${JSON.stringify(deepMerge(current, { cluster: {
      enabled: true, port: udp[index], nodeName: name, beaconSeconds: 5, rosterGossipSeconds: 10,
      peers: udp.filter((_, other) => other !== index).map((port) => `127.0.0.1:${port}`),
    } }), null, 2)}\n`);
    const daemon = await startDaemon(home);
    const token = operatorToken(home);
    const status = await api(daemon, token, 'GET', '/api/cluster/status');
    const nodeId = String(clusterData<{ nodeId?: unknown }>(status.body).nodeId ?? '');
    const node: GroupNode = {
      name, home, daemon, token, nodeId,
      async restart(restartOptions) {
        if (restartOptions?.crash) await node.daemon.kill(); else await node.daemon.stop();
        node.daemon = await startDaemon(home);
        return node.daemon;
      },
    };
    nodes.push(node);
  }
  const [first, ...rest] = nodes;
  if (!first) throw new Error('startGroup needs at least one node');
  const created = await api(first.daemon, first.token, 'POST', '/api/cluster/create', { name: 'runthrough' });
  const group = clusterData<{ groupId?: string; joinKey?: string }>(created.body);
  if (!group.groupId || !group.joinKey) throw new Error(`cluster create failed: ${created.text.slice(0, 300)}`);
  for (const node of rest) {
    const joined = await api(node.daemon, node.token, 'POST', '/api/cluster/join', { groupId: group.groupId, joinKey: group.joinKey });
    if (joined.status >= 300) throw new Error(`${node.name} could not join: ${joined.text.slice(0, 300)}`);
  }
  for (const node of nodes) {
    const listed = await waitFor(async () => {
      const result = await api(node.daemon, node.token, 'GET', '/api/cluster/nodes');
      const members = clusterData<{ members?: unknown[] }>(result.body).members ?? [];
      return members.length >= nodes.length ? members : undefined;
    }, 60_000, 500);
    if (!listed) throw new Error(`${node.name} does not list every member`);
  }
  return {
    base, nodes, model,
    async close() {
      for (const node of nodes) await node.daemon.stop().catch(() => undefined);
      model.stop();
    },
  };
}
