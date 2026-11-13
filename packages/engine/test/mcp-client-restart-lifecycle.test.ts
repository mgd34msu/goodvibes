import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from '../platform/src/platform/mcp/client.ts';

// Fake stdio server. MCP_MODE:
//   never-negotiates : exits immediately, before answering anything
//   hang-after-first : spawn 1 negotiates then exits; later spawns answer discover (error -> legacy
//                      handshake) but never answer `initialize`, staying alive
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
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      if (hang) continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'f', version: '1' } } }) + '\\n');
      if (n === 1) setTimeout(() => process.exit(1), 30);
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }) + '\\n');
    }
  }
});
`);
});

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const restartTimers = new Set<unknown>();
const clearedRestartTimers = new Set<unknown>();
const clients: McpClient[] = [];

/** Shrink the 2s/4s/6s restart backoff to tens of milliseconds and remember those timers. */
function speedUpBackoff(): void {
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === 'number' && ms >= 2000 && ms % 2000 === 0 && ms <= 6000) {
      const handle = realSetTimeout(fn, (ms / 2000) * 40, ...rest);
      restartTimers.add(handle);
      return handle;
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
  (globalThis as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    if (restartTimers.has(handle)) clearedRestartTimers.add(handle);
    return realClearTimeout(handle as never);
  }) as typeof clearTimeout;
}

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  restartTimers.clear();
  clearedRestartTimers.clear();
  for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
  if (existsSync(spawnFile)) rmSync(spawnFile);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function make(mode: string, timeout = 10_000): { client: McpClient; spawns: () => number } {
  let started = 0;
  const client = new McpClient(
    { name: `fake-${mode}`, command: process.execPath, args: [serverScript], env: { MCP_MODE: mode, MCP_SPAWN_FILE: spawnFile } },
    { timeout, beforeProcessStart: () => { started++; } },
  );
  clients.push(client);
  return { client, spawns: () => started };
}
const sleep = (ms: number) => new Promise<void>(r => realSetTimeout(r, ms));

describe('MCP stdio restart lifecycle', () => {
  test('a server that spawns but never negotiates runs out of restart attempts', async () => {
    speedUpBackoff();
    const { client, spawns } = make('never-negotiates');
    await client.connect().catch(() => undefined);
    await sleep(1500);
    // the first start plus MAX_RESTART_ATTEMPTS (3) restarts, then it gives up
    expect(spawns()).toBe(4);
    await sleep(300);
    expect(spawns()).toBe(4);
    expect(client.isConnected).toBe(false);
  }, 15_000);

  test('a restart whose negotiation fails is torn down and retried, then reported disconnected', async () => {
    speedUpBackoff();
    const { client, spawns } = make('hang-after-first', 150);
    await client.connect();
    expect(client.isConnected).toBe(true);
    await sleep(3500);
    // spawn 1 negotiated then crashed; restarts 1..3 spawned but never negotiated
    expect(spawns()).toBe(4);
    expect(client.isConnected).toBe(false);
  }, 15_000);

  test('a deliberate disconnect cancels the pending restart timer', async () => {
    speedUpBackoff();
    const { client } = make('hang-after-first');
    await client.connect();
    await sleep(300); // spawn 1 exits; the restart is now pending (tens of ms) or already fired
    restartTimers.clear();
    // force a fresh crash-style schedule and disconnect before it fires
    (client as unknown as { _scheduleRestart(): void })._scheduleRestart();
    expect(restartTimers.size).toBe(1);
    await client.disconnect();
    expect(clearedRestartTimers.size).toBe(1);
  }, 15_000);
});
