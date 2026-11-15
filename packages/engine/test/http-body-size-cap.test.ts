/**
 *
 * JSON body-size cap on all HTTP routes.
 * Verifies that parseJsonBody (and parseOptionalJsonBody in router) returns
 * HTTP 413 for requests exceeding 1 MiB, and passes requests at or below 1 MiB.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { HttpListener } from '../platform/src/platform/daemon/http-listener.ts';
import { trackDisposables } from './_helpers/disposables.ts';
import { stopListenerTimers } from './_helpers/listener-teardown.ts';

// Each HttpListener here is constructed but never start()ed, so HttpListener.stop()
// never reaches the code that clears its two RateLimiter sweep intervals (it
// early-returns while this.server === null). stopListenerTimers() reaches those
// sweeps directly.
const disposables = trackDisposables();

const MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB

function tempDir(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `gv-http-body-${suffix}-`));
}

function makeHttpListener(dir: string): HttpListener {
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
  const configManager = new ConfigManager({ configDir: dir });
  return disposables.add(new HttpListener({
    port: 0,
    userAuth,
    configManager,
    rateLimit: 1000,
  }), stopListenerTimers);
}

/**
 * Access the private parseJsonBody method via reflection.
 */
function getParseJsonBody(listener: HttpListener): (req: Request) => Promise<Record<string, unknown> | Response> {
  return (listener as unknown as {
    parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  }).parseJsonBody.bind(listener);
}

describe('HttpListener parseJsonBody body-size cap', () => {
  test('Content-Length header > 1 MiB returns 413', async () => {
    const dir = tempDir('a');
    try {
      const listener = makeHttpListener(dir);
      const parseJsonBody = getParseJsonBody(listener);

      const req = new Request('http://localhost/', {
        method: 'POST',
        body: '{"x":1}',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_JSON_BYTES + 1),
        },
      });

      const result = await parseJsonBody(req);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(413);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('body > 1 MiB without Content-Length header returns 413', async () => {
    const dir = tempDir('b');
    try {
      const listener = makeHttpListener(dir);
      const parseJsonBody = getParseJsonBody(listener);

      // Build a body just over 1 MiB
      const bigBody = 'a'.repeat(MAX_JSON_BYTES + 1);
      const req = new Request('http://localhost/', {
        method: 'POST',
        body: bigBody,
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await parseJsonBody(req);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(413);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('valid JSON body within 1 MiB is parsed', async () => {
    const dir = tempDir('c');
    try {
      const listener = makeHttpListener(dir);
      const parseJsonBody = getParseJsonBody(listener);

      const req = new Request('http://localhost/', {
        method: 'POST',
        body: '{"ok":true}',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await parseJsonBody(req);
      expect(result).not.toBeInstanceOf(Response);
      expect((result as Record<string, unknown>).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// DaemonHttpRouter parseJsonBody / parseOptionalJsonBody
// ---------------------------------------------------------------------------

import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.ts';

const routerDirs: string[] = [];
afterEach(() => {
  for (const dir of routerDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRouter(): DaemonHttpRouter {
  const routerDir = tempDir('router');
  routerDirs.push(routerDir);
  const configManager = new ConfigManager({ configDir: routerDir });
  const ctx = new Proxy({} as ConstructorParameters<typeof DaemonHttpRouter>[0], {
    get: (_target, key) => {
      if (key === 'configManager') return configManager;
      if (key === 'telemetryApi') return null;
      return undefined;
    },
  });
  return new (DaemonHttpRouter as unknown as new (ctx: unknown) => DaemonHttpRouter)(ctx);
}

describe('DaemonHttpRouter parseJsonBody body-size cap', () => {
  test('Content-Length > 1 MiB returns 413', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"x":1}',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_JSON_BYTES + 1),
      },
    });

    const result = await router.parseJsonBody(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  test('parseOptionalJsonBody: Content-Length > 1 MiB returns 413', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"x":1}',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(MAX_JSON_BYTES + 1),
      },
    });

    const result = await router.parseOptionalJsonBody(req);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  test('parseOptionalJsonBody: empty body returns null', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await router.parseOptionalJsonBody(req);
    expect(result).toBeNull();
  });

  test('parseJsonBody: valid JSON within 1 MiB is parsed', async () => {
    const router = makeRouter();

    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{"hello":"world"}',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await router.parseJsonBody(req);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as Record<string, unknown>).hello).toBe('world');
  });
});

describe('HttpListener request metrics', () => {
  test('a redirect and a client error are counted under their own status class, not as 2xx', async () => {
    const { httpRequestsTotal, resetMetrics } = await import('../platform/src/platform/runtime/metrics.ts');
    resetMetrics();
    const dir = tempDir('metrics');
    try {
      const listener = makeHttpListener(dir);
      const answers = [304, 404, 200];
      (listener as unknown as { _handleRequestInner: () => Promise<Response> })._handleRequestInner =
        async () => new Response(null, { status: answers.shift() ?? 200 });
      const handle = (listener as unknown as { handleRequest: (req: Request, peerIp?: string) => Promise<Response> }).handleRequest.bind(listener);
      for (let index = 0; index < 3; index += 1) await handle(new Request('http://localhost/api/x'), '127.0.0.1');
      expect(httpRequestsTotal.total({ status_class: '3xx' })).toBe(1);
      expect(httpRequestsTotal.total({ status_class: '4xx' })).toBe(1);
      expect(httpRequestsTotal.total({ status_class: '2xx' })).toBe(1);
    } finally {
      resetMetrics();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
