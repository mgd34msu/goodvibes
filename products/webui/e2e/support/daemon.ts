/**
 * A real daemon for a browser journey: the daemon started from this checkout,
 * in its own scratch home on free loopback ports, serving the web UI build the
 * run made (globalSetup). Nothing reads or writes the login home: HOME, the
 * GoodVibes homes, the XDG folders and TMPDIR all point inside the scratch
 * folder, and the engine's network preload and the port guard (port-guard.ts
 * beside this file) are preloaded into the daemon so it refuses any connection
 * off loopback or to a port that was listening before (the owner's own daemon
 * among them).
 *
 * The only stand-in is the conversation model at the HTTP wire: an
 * OpenAI-compatible endpoint on loopback that asks for one command and then
 * answers in text.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_DIST_DIR } from './build';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const DAEMON_ENTRY = join(REPO, 'products/daemon/src/cli/entrypoint.ts');
const NETWORK_GUARD = join(REPO, 'packages/engine/toolchain/src/test-runner/test-network-preload.ts');
const PORT_GUARD = fileURLToPath(new URL('./port-guard.ts', import.meta.url));
const MODEL_ID = 'e2e-1';

export interface ScriptedCommand {
  /** A word the owner's message carries that makes the model ask for `command`. */
  readonly marker: string;
  readonly command: string;
  /** The text answer after the command ran. */
  readonly answer: string;
}

export interface RealDaemon {
  readonly baseUrl: string;
  /** The web UI at the network address it was started with (`publicHost`): `web.publicBaseUrl`, which the browser maps to this loopback listener. */
  readonly publicUrl: string | undefined;
  /** The operator credential the daemon minted in its own home (what the owner's apps on this machine hold). */
  readonly ownerToken: string;
  invoke(token: string, method: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown; text: string }>;
  api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** Loopback ports listening before this daemon started: the guard refuses them. */
function listeningPorts(): number[] {
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && fields[1]) ports.add(parseInt(fields[1].split(':').at(-1) ?? '0', 16));
    }
  }
  return [...ports];
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

type WireMessage = { role: string; content?: unknown };

/** The model at the HTTP wire: an exec call for a message carrying a marker, then the scripted answer. */
function startModel(commands: readonly ScriptedCommand[]): Promise<{ server: Server; baseURL: string }> {
  let calls = 0;
  const server = createHttpServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'e2e', context_length: 200000 }] }));
        return;
      }
      const body = JSON.parse(raw || '{}') as { messages?: WireMessage[]; model?: string };
      const messages = body.messages ?? [];
      const lastUser = messages.map((message) => message.role).lastIndexOf('user');
      const userText = lastUser >= 0 ? JSON.stringify(messages[lastUser]!.content ?? '') : '';
      const after = messages.slice(lastUser + 1);
      const scripted = commands.find((entry) => userText.includes(entry.marker));
      const base = { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0, model: body.model ?? MODEL_ID };
      let out = sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      if (scripted && !after.some((message) => message.role === 'tool')) {
        out += sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_e2e_${++calls}`, type: 'function',
          function: { name: 'exec', arguments: JSON.stringify({ commands: [{ cmd: scripted.command }] }) } }] }, finish_reason: null }] });
        out += sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        out += sse({ ...base, choices: [{ index: 0, delta: { content: scripted?.answer ?? 'Noted.' }, finish_reason: null }] });
        out += sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      out += sse({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      out += 'data: [DONE]\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(out);
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ server, baseURL: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/** Start the daemon from source in a fresh scratch home; resolves once it reports it is ready. */
export async function startRealDaemon(options: {
  commands?: readonly ScriptedCommand[];
  /** A host name the web UI is also served at over plain http (`web.publicBaseUrl`), as a phone on the local network reaches it. */
  publicHost?: string;
} = {}): Promise<RealDaemon> {
  const before = listeningPorts();
  const model = await startModel(options.commands ?? []);
  const root = mkdtempSync(join(tmpdir(), 'gv-webui-e2e-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const daemonHome = join(home, '.goodvibes', 'daemon');
  const tmp = join(root, 'tmp');
  for (const dir of [home, workspace, daemonHome, tmp, join(home, '.config'), join(home, '.cache'), join(home, '.local/share'), join(home, '.local/state')]) mkdirSync(dir, { recursive: true });
  const ports = { controlPlane: await freePort(), http: await freePort(), web: await freePort() };
  const publicUrl = options.publicHost ? `http://${options.publicHost}:${ports.controlPlane}` : undefined;
  writeFileSync(join(daemonHome, 'settings.json'), JSON.stringify({
    judgment: { policy: 'No Decision Model' },
    controlPlane: { host: '127.0.0.1', port: ports.controlPlane, webui: { serve: true, bundleDir: E2E_DIST_DIR } },
    httpListener: { host: '127.0.0.1', port: ports.http },
    web: { host: '127.0.0.1', port: ports.web, ...(publicUrl ? { publicBaseUrl: publicUrl } : {}) },
  }, null, 2));
  // The model setting and the provider file, in each surface's settings as the apps on this machine write them.
  for (const surface of ['tui', 'agent', 'daemon-host']) {
    const dir = join(home, '.goodvibes', surface);
    mkdirSync(join(dir, 'providers'), { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ provider: { model: `e2efake:${MODEL_ID}` } }, null, 2));
    writeFileSync(join(dir, 'providers', 'e2efake.json'), JSON.stringify({
      name: 'e2efake', displayName: 'E2E scripted model', type: 'openai-compat', baseURL: model.baseURL, apiKeyEnv: 'E2E_FAKE_API_KEY',
      models: [{ id: MODEL_ID, displayName: MODEL_ID, description: 'scripted', contextWindow: 200000, capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
    }, null, 2));
  }
  const own = new Set([ports.controlPlane, ports.http, ports.web, Number(new URL(model.baseURL).port)]);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', TZ: 'UTC', NO_COLOR: '1',
    HOME: home, USERPROFILE: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemonHome, GOODVIBES_WORKING_DIR: workspace,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_RUNTIME_DIR: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    E2E_FAKE_API_KEY: 'e2e-local-key',
    BUN_OPTIONS: `--preload ${NETWORK_GUARD} --preload ${PORT_GUARD}`,
    DAEMON_GUARD_DENY_PORTS: before.filter((port) => !own.has(port)).join(','),
  };
  const child: ChildProcess = spawn('bun', ['--no-env-file', DAEMON_ENTRY, 'serve', '--port', String(ports.controlPlane), '--hostname', '127.0.0.1'], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((done, fail) => {
    const seen = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (/host started \((ready|degraded)\)/.test(output)) done();
    };
    child.stdout?.on('data', seen);
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', (code) => fail(new Error(`the daemon exited ${code} before it was ready: ${output.slice(-1500)}`)));
  });
  const baseUrl = `http://127.0.0.1:${ports.controlPlane}`;
  const tokens = JSON.parse(readFileSync(join(daemonHome, 'operator-tokens.json'), 'utf8')) as { token?: string; operator?: { token?: string }; tokens?: { token?: string }[] };
  const ownerToken = [tokens.token, tokens.operator?.token, ...(tokens.tokens ?? []).map((entry) => entry.token)].find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (!ownerToken) throw new Error('the daemon wrote no operator token');
  const api: RealDaemon['api'] = async (token, method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text };
  };
  return {
    baseUrl, publicUrl, ownerToken, api,
    invoke: (token, method, body = {}) => api(token, 'POST', `/api/control-plane/methods/${method}/invoke`, { body }),
    async stop() {
      const exited = child.exitCode === null ? new Promise<void>((done) => child.once('exit', () => done())) : Promise.resolve();
      child.kill('SIGTERM');
      await exited;
      await new Promise<void>((done) => model.server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Pair the browser as the owner's own device, as the terminal's pairing QR does; returns the link's fragment and token.
 * `forThisMachine: false` asks for the code a phone scans, which the daemon makes only when its web address reaches other devices.
 */
export async function ownerPairingLink(daemon: RealDaemon, options: { forThisMachine?: boolean } = {}): Promise<{ fragment: string; token: string }> {
  const minted = await daemon.invoke(daemon.ownerToken, 'pairing.handoff.create', { name: 'e2e-browser', offers: [], forThisMachine: options.forThisMachine ?? true });
  const body = minted.body as { fragment?: string; token?: { token?: string } };
  if (minted.status !== 200 || !body.fragment || !body.token?.token) throw new Error(`pairing.handoff.create answered ${minted.status}: ${minted.text.slice(0, 300)}`);
  return { fragment: body.fragment, token: body.token.token };
}
