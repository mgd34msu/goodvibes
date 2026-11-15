/**
 * wrangler-CLI harness, @goodvibes-jev/engine/platform Workers parity test.
 *
 * Spawns `wrangler dev --local` against test/workers/worker.ts (see wrangler.toml),
 * the same worker the Miniflare harness in test/workers/workers.test.ts runs, and
 * exercises the same endpoint surface.
 *
 * IMPORTANT: `wrangler dev --local` uses Miniflare 4 as its local runtime
 * layer internally, it is NOT the raw workerd binary.
 *
 * What this harness adds over the standalone Miniflare harness:
 *   - Exercises wrangler's esbuild bundling pipeline (not the manual esbuild step)
 *   - Exercises wrangler CLI config surface (wrangler.toml, entry resolution)
 *
 * Run:
 *   bun run build && bun run test:workers:wrangler
 *
 * Prerequisites:
 *   - wrangler must be installed (devDependency); the suite is skipped without it
 *   - platform must be built (dist/web.js must exist)
 *   - No Cloudflare account or API token required (--local mode)
 *
 * Startup behaviour:
 *   - wrangler dev cold-starts in ~5-15s (first run populates Miniflare's workerd cache)
 *   - CI timeout: 120s for the job; wrangler startup timeout here: 60s
 *   - Port: reserved via the OS ephemeral-port allocator before wrangler starts
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

// ---------------------------------------------------------------------------
// Wrangler availability check. wrangler is a devDependency, so the installed
// copy is run directly under Node (wrangler refuses the Bun runtime): `bunx`
// would fetch it from the network when missing.
// The suite is skipped (not failed) when it has not been installed.
// ---------------------------------------------------------------------------
function resolveWranglerEntry(): string | null {
  try {
    execFileSync('node', ['--version'], { stdio: 'ignore' });
    return createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');
  } catch {
    return null;
  }
}

const wranglerEntry = resolveWranglerEntry();
const wranglerAvailable = wranglerEntry !== null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname); // test/workers-wrangler/

let port = 0;
let baseUrl = '';

// Maximum time to wait for wrangler to report ready (ms).
const STARTUP_TIMEOUT_MS = 60_000;
// Interval between health-check polls (ms).
const POLL_INTERVAL_MS = 500;

let wranglerProcess: ChildProcess;

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve an ephemeral port for wrangler.');
  }
  return address.port;
}

// ---------------------------------------------------------------------------
// Lifecycle: spawn wrangler dev, poll /health, kill after tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!wranglerEntry) return;

  port = await findAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  wranglerProcess = spawn(
    'node',
    [
      wranglerEntry,
      'dev',
      '--local',
      '--port', String(port),
    ],
    {
      cwd: HARNESS_DIR,
      // Inherit stderr so wrangler startup/error output appears in test logs.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Suppress wrangler telemetry and update checks in CI.
        WRANGLER_SEND_METRICS: 'false',
        NO_COLOR: '1',
        // Signal non-interactive mode to wrangler (suppresses prompts).
        CI: 'true',
      },
    },
  );

  // Capture wrangler stderr for diagnostics on failure.
  const stderrLines: string[] = [];
  wranglerProcess.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString());
  });
  wranglerProcess.stdout?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString());
  });

  // Poll /health until wrangler is ready or timeout.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    // If wrangler exited early, fail immediately with diagnostics.
    if (wranglerProcess.exitCode !== null) {
      const logs = stderrLines.join('');
      throw new Error(
        `wrangler dev exited early (code ${wranglerProcess.exitCode}).\n` +
        `Port: ${port}\n` +
        `Output:\n${logs}`,
      );
    }

    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // Not ready yet, keep polling.
    }
  }

  if (!ready) {
    const logs = stderrLines.join('');
    wranglerProcess.kill('SIGKILL');
    throw new Error(
      `wrangler dev did not become ready within ${STARTUP_TIMEOUT_MS}ms on port ${port}.\n` +
      `Output:\n${logs}`,
    );
  }
}, STARTUP_TIMEOUT_MS + 5_000);

afterAll(async () => {
  if (wranglerProcess && wranglerProcess.exitCode === null) {
    wranglerProcess.kill('SIGTERM');
    // Give it 3s to clean up before force-killing.
    await sleep(3000);
    if (wranglerProcess.exitCode === null) {
      wranglerProcess.kill('SIGKILL');
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests, match the Miniflare harness assertions
// ---------------------------------------------------------------------------

describe.skipIf(!wranglerAvailable)('Workers wrangler: smoke', () => {
  test('platform loads and factory produces a valid platform object through wrangler bundling pipeline', async () => {
    const { status, body } = await get('/smoke');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.hasOperator).toBe(true);
    expect(b.hasAuth).toBe(true);
    expect(b.hasRealtime).toBe(true);

    const keys = b.engineKeys as string[];
    expect(keys).toContain('operator');
    expect(keys).toContain('auth');
    expect(keys).toContain('realtime');
  }, 15_000);
});

describe.skipIf(!wranglerAvailable)('Workers wrangler: auth flow', () => {
  test('auth token is stored and retrievable inside wrangler-hosted worker', async () => {
    const { status, body } = await get('/auth');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.tokenMatches).toBe(true);
    expect(b.storedToken).toBe('workers-auth-token-abc123');
  }, 10_000);
});

describe.skipIf(!wranglerAvailable)('Workers wrangler: transport-http round-trip', () => {
  test('success path: mock returns real-shape JSON, result is populated', async () => {
    const { status, body } = await get('/transport-success');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.result).not.toBeNull();

    const result = b.result as Record<string, unknown>;
    expect(result).toHaveProperty('totals');
    expect(result).toHaveProperty('sessions');
    const [session] = result.sessions as [Record<string, unknown>];
    expect(session.kind).toBe('tui');
    expect(session.lastActivityAt).toBe(1700000000000);
    expect(b.kind).toBeNull();
    expect(b.ctor).toBeNull();
  }, 10_000);

  test('error path: mock returns 5xx, errorKind is typed \'service\'', async () => {
    const { status, body } = await get('/transport-error');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.result).toBeNull();

    const validKinds = ['auth', 'config', 'contract', 'network', 'not-found', 'protocol', 'rate-limit', 'service', 'internal', 'tool', 'validation', 'unknown'];
    expect(b.kind).toBe('service');
    expect(validKinds).toContain(b.kind as string);
    // esbuild mangles class names with '_' prefix; match pattern instead of exact name
    expect(typeof b.ctor).toBe('string');
    expect(b.ctor as string).toMatch(/Error$/);
    expect(b.kind).not.toBeNull();
  }, 10_000);
});

describe.skipIf(!wranglerAvailable)('Workers wrangler: error taxonomy', () => {
  test('errors subpath loads and GoodVibesError is instantiable', async () => {
    const { status, body } = await get('/errors');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.engineErrorWorks).toBe(true);

    const names = b.errorClassNames as string[];
    expect(names).toContain('GoodVibesError');
  }, 10_000);
});

describe.skipIf(!wranglerAvailable)('Workers wrangler: crypto', () => {
  test('crypto.randomUUID produces valid UUID v4 in wrangler-hosted worker', async () => {
    const { status, body } = await get('/crypto');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.isValidUuid).toBe(true);
    expect(b.hasCryptoSubtle).toBe(true);
    expect(b.sha256Vector).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(b.sha256HashLength).toBe(64);
  }, 10_000);
});

describe.skipIf(!wranglerAvailable)('Workers wrangler: globals audit', () => {
  test('fetch, Request, Response, Headers, URL, crypto are available', async () => {
    const { status, body } = await get('/globals');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    const globals = b.globals as Record<string, boolean>;
    expect(globals.fetch).toBe(true);
    expect(globals.Request).toBe(true);
    expect(globals.Response).toBe(true);
    expect(globals.Headers).toBe(true);
    expect(globals.URL).toBe(true);
    expect(globals.crypto).toBe(true);
    expect(globals.cryptoSubtle).toBe(true);
    expect(globals.cryptoRandomUUID).toBe(true);
    expect(globals.setTimeout).toBe(true);
  }, 10_000);

  // The EventSource-less realtime check lives in the Miniflare harness: it removes
  // the global inside the isolate, which does not depend on how the worker is bundled.

  test('location is NOT available in wrangler-hosted worker (must pass explicit baseUrl)', async () => {
    const { status, body } = await get('/globals');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    const globals = b.globals as Record<string, boolean>;
    expect(globals.location).toBe(false);
  }, 10_000);
});
