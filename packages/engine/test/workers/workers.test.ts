/**
 * Cloudflare Workers runtime harness.
 *
 * Uses Miniflare (programmatic API, v4) to run the built ./web entry under
 * the actual workerd V8 isolate. Each test dispatches a real HTTP fetch to
 * the worker and asserts the JSON response.
 *
 * Architecture decision: ./web entry (dist/web.js) is sufficient for normal
 * Worker-hosted operator HTTP clients. The separate ./workers entry is only
 * for the optional GoodVibes Worker bridge around daemon batch queue/tick
 * integration.
 *
 * Bundling: esbuild inlines the built platform (packages/engine/platform/dist,
 * imported by relative path from worker.ts) into one module written to a
 * per-run temp directory. Nothing is written into dist, so concurrent runs
 * and builds cannot clobber each other. esbuild is the copy wrangler ships.
 *
 * Run:
 *   bun run build && bun test test/workers/workers.test.ts
 *
 * Or via the dedicated script:
 *   bun run test:workers
 */

import { resolve, dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';

// fileURLToPath alias: __dirname here is a local const, not the Node.js global
// __dirname, which is unavailable in ESM.
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SOURCE = resolve(__dirname, 'worker.ts');

let mf: Miniflare;
let tmpDir = '';

// esbuild is a dependency of wrangler, not of the engine: resolve the copy that
// wrangler uses instead of fetching one with bunx.
// The engine does not depend on esbuild, so its types are not resolvable here:
// this is the slice of the build options the bundle step uses.
interface EsbuildBundleOptions {
  readonly entryPoints: readonly string[];
  readonly bundle: boolean;
  readonly platform: 'browser';
  readonly format: 'esm';
  readonly target: string;
  readonly external: readonly string[];
  readonly outfile: string;
  readonly logLevel: 'silent';
}
function loadEsbuild(): { build: (options: EsbuildBundleOptions) => Promise<unknown> } {
  const fromHere = createRequire(import.meta.url);
  return createRequire(fromHere.resolve('wrangler'))('esbuild');
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'goodvibes-workers-'));
  const bundled = join(tmpDir, 'worker.mjs');

  // Pre-bundle the worker entry so bare-module specifiers (e.g. 'zod/v4') that
  // Miniflare cannot resolve locally are inlined into one self-contained module.
  await loadEsbuild().build({
    entryPoints: [WORKER_SOURCE],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    // Node built-ins stay external; Miniflare resolves them through the
    // nodejs_compat flag below.
    external: ['fs', 'path', 'node:fs', 'node:path'],
    outfile: bundled,
    logLevel: 'silent',
  });

  mf = new Miniflare({
    modules: true,
    scriptPath: bundled,
    modulesRoot: tmpDir,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'] },
    ],
    // Worker compatibility date policy: bump quarterly and pick a date within
    // the last calendar quarter.
    compatibilityDate: '2026-04-01',
    // nodejs_compat lets Miniflare resolve bare node built-in specifiers
    // (fs, path, node:fs, node:path) that esbuild leaves in the bundle when
    // they are marked --external. Without this flag Miniflare throws
    // ERR_MODULE_RULE for any bare 'fs' import encountered at load time.
    compatibilityFlags: ['nodejs_compat'],
  });
  await mf.ready;
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Smoke ───────────────────────────────────────────────────────────────────

describe('Workers harness: smoke', () => {
  test('platform loads and factory produces a valid platform object', async () => {
    const res = await mf.dispatchFetch('http://workers.test/smoke');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.hasOperator).toBe(true);
    expect(body.hasAuth).toBe(true);
    expect(body.hasRealtime).toBe(true);
    // Verify expected top-level platform namespaces are present
    const keys = body.engineKeys as string[];
    expect(keys).toContain('operator');
    expect(keys).toContain('auth');
    expect(keys).toContain('realtime');
  }, 15_000);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('Workers harness: auth flow', () => {
  test('auth token is stored and retrievable inside isolate', async () => {
    const res = await mf.dispatchFetch('http://workers.test/auth');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.tokenMatches).toBe(true);
    expect(body.storedToken).toBe('workers-auth-token-abc123');
  }, 10_000);
});

// ─── Transport HTTP ───────────────────────────────────────────────────────────

describe('Workers harness: transport-http round-trip', () => {
  // Success path: mock returns real-shape JSON for GET /api/sessions.
  // Asserts that result is non-null and contains expected fields, proving the
  // transport completed the full HTTP round-trip successfully, not just that
  // it didn't crash.
  test('success path: mock returns real-shape JSON, result is populated', async () => {
    const res = await mf.dispatchFetch('http://workers.test/transport-success');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // result must be non-null: mock matched the real platform route (GET /api/sessions)
    expect(body.result).not.toBeNull();
    // Verify real-shape fields from sessions.list output schema
    const result = body.result as Record<string, unknown>;
    expect(result).toHaveProperty('totals');
    expect(result).toHaveProperty('sessions');
    const [session] = result.sessions as [Record<string, unknown>];
    expect(session.kind).toBe('tui');
    expect(session.lastActivityAt).toBe(1700000000000);
    // No error on the success path
    expect(body.kind).toBeNull();
    expect(body.ctor).toBeNull();
  }, 10_000);

  // Error path: mock returns 5xx. Asserts errorKind === 'service' (exact
  // literal, not regex), proving platform error taxonomy works under Workers runtime.
  // kind and ctor are returned as separate fields to avoid conflating
  // typed EngineErrorKind values with raw constructor names.
  test('error path: mock returns 5xx, errorKind is typed \'service\'', async () => {
    const res = await mf.dispatchFetch('http://workers.test/transport-error');
    // Worker must not crash (status 200 = error was caught and returned as JSON)
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // result is null because the call threw
    expect(body.result).toBeNull();

    // Assert 'kind' is a typed EngineErrorKind, not a constructor name.
    const validKinds = ['auth', 'config', 'contract', 'network', 'not-found', 'protocol', 'rate-limit', 'service', 'internal', 'tool', 'validation', 'unknown'];
    expect(body.kind).toBe('service'); // 500 maps to category 'service' -> kind 'service'
    expect(validKinds).toContain(body.kind as string);

    // Assert 'ctor' is a string ending with 'Error' (the constructor name of
    // the thrown error). esbuild mangles class names with a '_' prefix to avoid
    // collisions, so we cannot assert an exact name, just that it is a named
    // Error subclass (ends with 'Error') and not a raw RuntimeError or string.
    expect(typeof body.ctor).toBe('string');
    expect(body.ctor as string).toMatch(/Error$/);
    // The thrown error must have a typed kind (not null)
    expect(body.kind).not.toBeNull();
  }, 10_000);
});

// ─── Error taxonomy ───────────────────────────────────────────────────────────

describe('Workers harness: error taxonomy', () => {
  test('errors subpath loads and GoodVibesError is instantiable', async () => {
    const res = await mf.dispatchFetch('http://workers.test/errors');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.engineErrorWorks).toBe(true);
    // errorClassNames contains only actual Error subclasses.
    const names = body.errorClassNames as string[];
    // Sentinel: GoodVibesError must be present (it IS an Error subclass)
    expect(names).toContain('GoodVibesError');
  }, 10_000);
});

// ─── Crypto ───────────────────────────────────────────────────────────────────

describe('Workers harness: crypto.subtle + randomUUID', () => {
  test('crypto.randomUUID produces valid UUID v4', async () => {
    const res = await mf.dispatchFetch('http://workers.test/crypto');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.isValidUuid).toBe(true);
    expect(body.hasCryptoSubtle).toBe(true);
    expect(body.sha256Vector).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(body.sha256HashLength).toBe(64); // SHA-256 = 32 bytes = 64 hex chars
  }, 10_000);
});

// ─── Globals audit ────────────────────────────────────────────────────────────

describe('Workers harness: globals audit', () => {
  test('fetch, Request, Response, Headers, URL, crypto are available', async () => {
    const res = await mf.dispatchFetch('http://workers.test/globals');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    const globals = body.globals as Record<string, boolean>;
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

  // Miniflare injects EventSource and production Workers do not, so the global's
  // presence proves nothing. What matters is that SSE realtime works without it.
  test('SSE realtime delivers an event when EventSource is absent from the isolate', async () => {
    const res = await mf.dispatchFetch('http://workers.test/realtime-without-eventsource');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.eventSourceAbsent).toBe(true);
    expect(body.constructionError).toBeNull();
    expect(body.errors).toEqual([]);
    expect(body.delivered).toEqual({ type: 'TURN_SUBMITTED', sessionId: 'workers-sse-session' });
  }, 10_000);

  test('location is NOT available (must pass explicit baseUrl)', async () => {
    const res = await mf.dispatchFetch('http://workers.test/globals');
    const body = await res.json() as Record<string, unknown>;
    const globals = body.globals as Record<string, boolean>;

    // location.origin is absent in Workers, platform throws ConfigurationError
    // if baseUrl is omitted. Workers callers must pass baseUrl explicitly.
    expect(globals.location).toBe(false);
  }, 10_000);
});
