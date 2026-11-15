import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from '../platform/src/platform/mcp/client.ts';
import { McpRegistry } from '../platform/src/platform/mcp/registry.ts';

// Fake stdio server. MCP_MODE:
//   never-negotiates : exits immediately, before answering anything
//   hang-after-first : spawn 1 negotiates then exits; later spawns answer discover (error -> legacy
//                      handshake) but never answer `initialize`, staying alive
//   silent           : stays alive and never writes a byte (pid written to MCP_PID_FILE)
//   steady           : negotiates and stays up
//   barrier          : answers initialize only once the other barrier server has also started (needs both connecting at once)
//   close-stdout     : spawn 1 negotiates then exits (its shell wrapper closes stdout and lives on); later spawns are steady
const scratch = mkdtempSync(join(tmpdir(), 'mcp-restart-'));
const serverScript = join(scratch, 'server.ts');
const spawnFile = join(scratch, 'spawns');

beforeAll(() => {
  writeFileSync(serverScript, `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const mode = process.env.MCP_MODE;
const file = process.env.MCP_SPAWN_FILE!;
const n = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
writeFileSync(file, String(n));
if (mode === 'never-negotiates') process.exit(1);
if (process.env.MCP_PID_FILE) writeFileSync(process.env.MCP_PID_FILE, String(process.pid));
const silent = mode === 'silent';
const hang = mode === 'hang-after-first' && n > 1;
let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let idx: number;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined || silent) continue;
    if (msg.method === 'initialize') {
      if (hang) continue;
      if (mode === 'barrier') {
        writeFileSync(process.env.MCP_BARRIER_SELF!, '1');
        const answer = () => {
          if (!existsSync(process.env.MCP_BARRIER_OTHER!)) { setTimeout(answer, 5); return; }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'f', version: '1' } } }) + '\\n');
        };
        answer();
        continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'f', version: '1' } } }) + '\\n');
      if (n === 1 && (mode === 'hang-after-first' || mode === 'close-stdout')) setTimeout(() => process.exit(1), 30);
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }) + '\\n');
    }
  }
});
`);
});

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const clients: McpClient[] = [];

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
  if (existsSync(spawnFile)) rmSync(spawnFile);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Shrink the 30s handshake bound and 3s discover probe so a silent server fails in a test-sized window. */
function speedUpHandshakeBounds(): void {
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 30_000) return realSetTimeout(fn, 200, ...rest);
    if (ms === 3_000) return realSetTimeout(fn, 50, ...rest);
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function make(mode: string, timeout = 10_000): { client: McpClient; spawns: () => number } {
  let started = 0;
  const client = new McpClient(
    { name: `fake-${mode}`, command: process.execPath, args: [serverScript], env: { MCP_MODE: mode, MCP_SPAWN_FILE: spawnFile } },
    { timeout, restartDelayMs: 10, beforeProcessStart: () => { started++; } },
  );
  clients.push(client);
  return { client, spawns: () => started };
}
const sleep = (ms: number) => new Promise<void>(r => realSetTimeout(r, ms));

/** Poll for a condition the client reaches on its own; the deadline only turns a hang into a failure. */
async function until(condition: () => boolean, what: string, deadlineMs = 10_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe('MCP stdio restart lifecycle', () => {
  test('a server that spawns but never negotiates runs out of restart attempts', async () => {
    const { client, spawns } = make('never-negotiates');
    await client.connect().catch(() => undefined);
    await until(() => client.phase === 'gave-up', 'the client to give up');
    // the first start plus MAX_RESTART_ATTEMPTS (3) restarts, then it gives up
    expect(spawns()).toBe(4);
    expect(client.isConnected).toBe(false);
  }, 15_000);

  test('a restart whose negotiation fails is torn down and retried, then reported disconnected', async () => {
    const { client, spawns } = make('hang-after-first', 150);
    await client.connect();
    expect(client.isConnected).toBe(true);
    await until(() => client.phase === 'gave-up', 'the client to give up');
    // spawn 1 negotiated then crashed; restarts 1..3 spawned but never negotiated
    expect(spawns()).toBe(4);
    expect(client.isConnected).toBe(false);
  }, 15_000);

  test('a deliberate disconnect cancels the pending restart timer', async () => {
    // A long delay keeps the scheduled restart pending for the whole test.
    const client = new McpClient(
      { name: 'fake-steady', command: process.execPath, args: [serverScript], env: { MCP_MODE: 'steady', MCP_SPAWN_FILE: spawnFile } },
      { restartDelayMs: 60_000 },
    );
    clients.push(client);
    await client.connect();
    const internals = client as unknown as { _scheduleRestart(): void; restartTimer: unknown };
    internals._scheduleRestart();
    expect(client.phase).toBe('restart-wait');
    expect(internals.restartTimer).not.toBeNull();
    await client.disconnect();
    expect(internals.restartTimer).toBeNull();
  });

  test('a server that never answers initialize is refused within the handshake bound, not forever', async () => {
    const client = new McpClient(
      { name: 'silent', command: process.execPath, args: [serverScript], env: { MCP_MODE: 'silent', MCP_SPAWN_FILE: spawnFile } },
      { initializeTimeoutMs: 200 },
    );
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/initialize.*timed out/);
    expect(client.phase).toBe('gave-up');
    expect(client.lastError).toMatch(/initialize.*timed out/);
  }, 15_000);

  test('a silent server does not stop the next configured server from connecting', async () => {
    speedUpHandshakeBounds();
    const pidFile = join(scratch, 'silent.pid');
    const registry = new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) },
      sandboxSessions: { start: () => 'sandbox-1', stop: () => {} } as never,
    });
    try {
      await registry.applyConfig([
        { name: 'silent', command: process.execPath, args: [serverScript], env: { MCP_MODE: 'silent', MCP_SPAWN_FILE: join(scratch, 'silent-spawns'), MCP_PID_FILE: pidFile } },
        { name: 'steady', command: process.execPath, args: [serverScript], env: { MCP_MODE: 'steady', MCP_SPAWN_FILE: join(scratch, 'steady-spawns') } },
      ]);
      const servers = new Map(registry.listServers().map(server => [server.name, server]));
      expect(servers.get('steady')).toMatchObject({ connected: true, phase: 'ready' });
      expect(servers.get('silent')).toMatchObject({ connected: false, phase: 'gave-up' });
      expect(servers.get('silent')?.lastError).toMatch(/initialize.*timed out/);
      await sleep(200);
      expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
      await expect(registry.callTool('mcp:silent:anything', {})).rejects.toThrow(/not connected \(gave-up: .*timed out.*\); fix the server/);
    } finally {
      await registry.disconnectAll().catch(() => {});
    }
  }, 15_000);

  test('servers are connected at the same time, so one slow handshake does not queue the rest behind it', async () => {
    const registry = new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) },
      sandboxSessions: { start: () => 'sandbox-1', stop: () => {} } as never,
    });
    const marker = (name: string) => join(scratch, `barrier-${name}`);
    const server = (name: string, other: string) => ({
      name, command: process.execPath, args: [serverScript],
      env: { MCP_MODE: 'barrier', MCP_SPAWN_FILE: join(scratch, `${name}-spawns`), MCP_BARRIER_SELF: marker(name), MCP_BARRIER_OTHER: marker(other) },
    });
    try {
      // Each server answers only after the other has started: one after another would never finish.
      const result = await registry.applyConfig([server('left', 'right'), server('right', 'left')]);
      expect(result.servers.map((entry) => [entry.name, entry.connected])).toEqual([['left', true], ['right', true]]);
    } finally {
      await registry.disconnectAll().catch(() => {});
    }
  }, 20_000);

  test('a server that closes stdout but keeps running is killed and restarted, not left connected with no reader', async () => {
    const pidFile = join(scratch, 'close-stdout.pid');
    let started = 0;
    // The shell outlives the server it wraps and closes its own stdout, so the pipe ends while the process lives.
    const script = `echo $$ > "${pidFile}"; "${process.execPath}" "${serverScript}"; exec >&-; exec sleep 30`;
    const client = new McpClient(
      { name: 'close-stdout', command: 'sh', args: ['-c', script], env: { MCP_MODE: 'close-stdout', MCP_SPAWN_FILE: spawnFile } },
      { timeout: 2_000, restartDelayMs: 10, beforeProcessStart: () => { started++; } },
    );
    clients.push(client);
    await client.connect();
    const firstPid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => started === 2 && client.phase === 'ready', 'the restarted server to be ready');
    expect(started).toBe(2);
    expect(alive(firstPid)).toBe(false);
    expect(client.isConnected).toBe(true);
    expect(client.phase).toBe('ready');
  }, 15_000);
});
