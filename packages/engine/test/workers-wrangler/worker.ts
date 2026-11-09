/**
 * Cloudflare Workers test script for @goodvibes-jev/engine/platform, wrangler-CLI harness.
 *
 * Mirrors test/workers/worker.ts exactly. This version is bundled by wrangler dev
 * (esbuild pipeline) rather than Miniflare's programmatic API.
 *
 * IMPORTANT: Despite the name, `wrangler dev --local` does NOT use the raw workerd
 * binary directly, it uses Miniflare 4 as its local runtime layer. This means
 * EventSource IS available here (same as the standalone Miniflare harness). The
 * value of this harness is exercising wrangler's esbuild bundling pipeline and CLI
 * config surface, not a different runtime. To verify production-workerd behaviour
 * (where EventSource is truly absent), a real CF deployment is required.
 *
 * Imports resolve against packages/platform/dist via the relative path from this file.
 * wrangler dev bundles via its own esbuild pipeline before handing to Miniflare 4.
 */

import type { ExportedHandler, ExecutionContext } from '@cloudflare/workers-types';
import { createWebGoodVibesPlatform } from '../../platform/dist/web.js';
import * as PlatformErrors from '../../platform/dist/errors.js';

interface Env {}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleSmoke(): Response {
  const platformClient = createWebGoodVibesPlatform({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
  });

  const hasOperator = platformClient.operator != null && typeof platformClient.operator === 'object';
  const hasAuth = platformClient.auth != null && typeof platformClient.auth === 'object';
  const hasRealtime = platformClient.realtime != null && typeof platformClient.realtime === 'object';

  return json({
    ok: true,
    hasOperator,
    hasAuth,
    hasRealtime,
    engineKeys: Object.keys(platformClient).sort(),
  });
}

async function handleAuth(): Promise<Response> {
  const token = 'workers-auth-token-abc123';
  const platformClient = createWebGoodVibesPlatform({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: token,
  });

  const storedToken = await platformClient.auth.getToken();
  const tokenMatches = storedToken === token;

  return json({ ok: true, tokenMatches, storedToken });
}

async function handleTransportSuccess(): Promise<Response> {
  const mockPayload = {
    totals: { sessions: 1, active: 1, closed: 0 },
    sessions: [{
      id: 'session-001',
      kind: 'tui',
      // project-as-data, required on the wire since the identity
      // spine landed; a mock missing it fails output-schema validation.
      project: '/tmp/mock-project',
      title: 'Test Session',
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      lastActivityAt: 1700000000000,
      messageCount: 0,
      pendingInputCount: 0,
      routeIds: [],
      surfaceKinds: [],
      participants: [],
      metadata: {},
    }],
  };

  const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('/api/sessions')) {
      return new Response(JSON.stringify(mockPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };

  const platformClient = createWebGoodVibesPlatform({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
    fetch: mockFetch as unknown as typeof fetch,
    retry: { maxAttempts: 1 },
  });

  let result: unknown = null;
  let kind: string | null = null;
  let ctor: string | null = null;
  try {
    result = await platformClient.operator.sessions.list();
  } catch (err: unknown) {
    kind = (err as Record<string, unknown>)?.kind as string ?? null;
    ctor = (err as Record<string, unknown>)?.constructor instanceof Function
      ? ((err as Record<string, unknown>).constructor as { name?: string }).name ?? null
      : null;
  }

  return json({ ok: true, result, kind, ctor });
}

async function handleTransportError(): Promise<Response> {
  const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', code: 'MOCK_500' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const platformClient = createWebGoodVibesPlatform({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
    fetch: mockFetch as unknown as typeof fetch,
    retry: { maxAttempts: 1 },
  });

  let result: unknown = null;
  let kind: string | null = null;
  let ctor: string | null = null;
  try {
    result = await platformClient.operator.sessions.list();
  } catch (err: unknown) {
    kind = (err as Record<string, unknown>)?.kind as string ?? null;
    ctor = (err as Record<string, unknown>)?.constructor instanceof Function
      ? ((err as Record<string, unknown>).constructor as { name?: string }).name ?? null
      : null;
  }

  return json({ ok: true, result, kind, ctor });
}

function handleErrors(): Response {
  const errorClassNames = Object.keys(PlatformErrors).filter((k) => {
    const v = (PlatformErrors as Record<string, unknown>)[k];
    return typeof v === 'function' && (v as { prototype?: unknown }).prototype instanceof Error;
  });

  let engineErrorWorks = false;
  const GoodVibesError = (PlatformErrors as Record<string, unknown>).GoodVibesError as
    | (new (msg: string, meta: Record<string, unknown>) => Error)
    | undefined;
  if (GoodVibesError) {
    const e = new GoodVibesError('test', {
      kind: 'unknown',
      category: 'internal',
      source: 'transport',
      recoverable: false,
    });
    engineErrorWorks = e instanceof Error && e.message === 'test';
  }

  return json({ ok: true, errorClassNames, engineErrorWorks });
}

async function handleCrypto(): Promise<Response> {
  const uuid = crypto.randomUUID();
  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);

  const hasCryptoSubtle = typeof crypto.subtle === 'object';

  const encoded = new TextEncoder().encode('abc');
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return json({
    ok: true,
    uuid,
    isValidUuid,
    hasCryptoSubtle,
    sha256HashLength: hashHex.length,
    sha256Vector: hashHex,
  });
}

function handleGlobals(): Response {
  return json({
    ok: true,
    globals: {
      fetch: typeof fetch !== 'undefined',
      Request: typeof Request !== 'undefined',
      Response: typeof Response !== 'undefined',
      Headers: typeof Headers !== 'undefined',
      URL: typeof URL !== 'undefined',
      URLSearchParams: typeof URLSearchParams !== 'undefined',
      crypto: typeof crypto !== 'undefined',
      cryptoSubtle: typeof crypto?.subtle !== 'undefined',
      cryptoRandomUUID: typeof crypto?.randomUUID === 'function',
      WebSocket: typeof WebSocket !== 'undefined',
      // wrangler dev --local uses Miniflare 4 internally, which injects EventSource.
      // Both this harness and the standalone Miniflare harness will be true here.
      // Production workerd does NOT inject EventSource, verifiable only via real CF deployment.
      EventSource: typeof EventSource !== 'undefined',
      location: typeof (globalThis as Record<string, unknown>).location !== 'undefined',
      setTimeout: typeof setTimeout === 'function',
      setInterval: typeof setInterval === 'function',
      clearTimeout: typeof clearTimeout === 'function',
      process: typeof (globalThis as Record<string, unknown>).process !== 'undefined',
      Buffer: typeof (globalThis as Record<string, unknown>).Buffer !== 'undefined',
    },
  });
}

// The handler's `fetch` returns the global (DOM/bun) Response type, not
// @cloudflare/workers-types' Response (which additionally requires a
// `webSocket` property). At runtime under Miniflare/wrangler dev these are
// interchangeable, only the type declarations collide, so the exported
// object is asserted to the workers-types shape rather than typed directly.
const handler = {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/health':
          return new Response('ok', { status: 200 });
        case '/smoke':
          return handleSmoke();
        case '/auth':
          return await handleAuth();
        case '/transport-success':
          return await handleTransportSuccess();
        case '/transport-error':
          return await handleTransportError();
        case '/errors':
          return handleErrors();
        case '/crypto':
          return await handleCrypto();
        case '/globals':
          return handleGlobals();
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err: unknown) {
      const e = err as { message?: string; stack?: string };
      return new Response(
        JSON.stringify({ error: String(err), stack: e?.stack }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
};

export default handler as unknown as ExportedHandler<Env>;
