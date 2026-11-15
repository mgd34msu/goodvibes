/**
 * auth-flow-e2e.test.ts
 *
 * Boots a fake Bun.serve HTTP server that emulates the daemon's auth endpoints
 * at the paths the operator contract declares, then drives the real
 * `createOperatorApiClient` + `createGoodVibesAuthClient` against it, so a wrong
 * path, method or response shape in the client fails here.
 *
 * Auth flow modelled:
 *   POST   /login                       -> create a session; return { token, authenticated, username, expiresAt }
 *   GET    /api/control-plane/auth      -> bearer or cookie; return the auth snapshot
 *   DELETE /api/local-auth/sessions/:id -> revoke sessions (no operator client method exists, raw fetch)
 *   any other request                   -> 401 without valid auth
 *
 * Covers:
 *   1. Session mode: login through the auth client persists the token, current
 *      authenticates with it, revoke makes it anonymous and protected calls 401
 *   2. Shared-token mode: bearer token accepted, unknown bearer anonymous
 *   3. Both configured: session and shared token both resolve
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { createGoodVibesAuthClient, createMemoryTokenStore } from '../../platform/src/auth.js';
import { createOperatorApiClient } from '../../operator-client/src/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FakeServerSession {
  token: string;
  username: string;
  expiresAt: number;
}

interface FakeServer {
  readonly baseUrl: string;
  readonly stop: () => void;
  readonly revokeSession: () => void;
  readonly getSessions: () => ReadonlyMap<string, FakeServerSession>;
}

// ---------------------------------------------------------------------------
// Fake operator HTTP server factory
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'goodvibes_session';
const SHARED_TOKEN = 'fake-shared-token-xyz';

function buildFakeOperatorServer(opts: {
  sharedTokenEnabled: boolean;
  sessionEnabled: boolean;
}): FakeServer {
  const sessions = new Map<string, FakeServerSession>();
  let globalRevoked = false;

  function resolveAuth(req: Request): { kind: 'session' | 'shared-token'; username?: string } | null {
    // Check bearer header
    const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (bearer) {
      if (opts.sharedTokenEnabled && bearer === SHARED_TOKEN) {
        return { kind: 'shared-token' };
      }
      if (opts.sessionEnabled && !globalRevoked) {
        const sess = sessions.get(bearer);
        if (sess && Date.now() < sess.expiresAt) {
          return { kind: 'session', username: sess.username };
        }
      }
      return null;
    }

    // Check session cookie
    const cookieHeader = req.headers.get('cookie') ?? '';
    for (const segment of cookieHeader.split(';')) {
      const [rawName, ...parts] = segment.split('=');
      const name = rawName?.trim();
      if (name === COOKIE_NAME) {
        const token = decodeURIComponent(parts.join('=').trim());
        if (opts.sessionEnabled && !globalRevoked) {
          const sess = sessions.get(token);
          if (sess && Date.now() < sess.expiresAt) {
            return { kind: 'session', username: sess.username };
          }
        }
        return null;
      }
    }

    return null;
  }

  function makeSessionToken(): string {
    return crypto.randomUUID();
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req: Request): Response {
      const url = new URL(req.url);

      // POST /login
      if (req.method === 'POST' && url.pathname === '/login') {
        const token = makeSessionToken();
        const expiresAt = Date.now() + 60_000;
        const session: FakeServerSession = { token, username: 'alice', expiresAt };
        sessions.set(token, session);

        const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
        return new Response(
          JSON.stringify({
            token,
            authenticated: true,
            username: 'alice',
            expiresAt,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Set-Cookie': cookie,
            },
          },
        );
      }

      // GET /api/control-plane/auth
      if (req.method === 'GET' && url.pathname === '/api/control-plane/auth') {
        const auth = resolveAuth(req);
        if (!auth) {
          return new Response(
            JSON.stringify({
              authenticated: false,
              authMode: 'anonymous',
              tokenPresent: false,
              authorizationHeaderPresent: false,
              sessionCookiePresent: false,
              principalId: null,
              principalKind: null,
              admin: false,
              scopes: [],
              roles: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            authenticated: true,
            authMode: auth.kind,
            tokenPresent: true,
            authorizationHeaderPresent: req.headers.has('authorization'),
            sessionCookiePresent: (req.headers.get('cookie') ?? '').includes(COOKIE_NAME),
            principalId: auth.username ?? 'shared-token',
            principalKind: auth.kind === 'shared-token' ? 'token' : 'user',
            admin: auth.kind === 'shared-token',
            scopes: ['read'],
            roles: auth.kind === 'shared-token' ? [] : ['viewer'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // DELETE /api/local-auth/sessions/:id
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/local-auth/sessions/')) {
        const auth = resolveAuth(req);
        if (!auth || auth.kind !== 'session') {
          return new Response(JSON.stringify({ error: 'not authenticated' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        globalRevoked = true;
        sessions.clear();
        return new Response(JSON.stringify({ revoked: true }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
          },
        });
      }

      // Any other request: check auth
      const auth = resolveAuth(req);
      if (!auth) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const port = server.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => server.stop(true),
    revokeSession: () => { globalRevoked = true; sessions.clear(); },
    getSessions: () => sessions as ReadonlyMap<string, FakeServerSession>,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function operatorFor(baseUrl: string, authToken?: string | null) {
  return createOperatorApiClient({ baseUrl, ...(authToken ? { authToken } : {}) });
}

const CREDENTIALS = { username: 'alice', password: 'secret' };

// Cleanup registry
const serversToStop: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const s of serversToStop.splice(0)) {
    try {
      s.stop();
    } catch {
      // Test server cleanup should not mask the assertion result.
    }
  }
});

// ---------------------------------------------------------------------------
// Test 1.1: Session mode
// ---------------------------------------------------------------------------

describe('auth-flow-e2e: session mode', () => {
  test('login persists the token, current authenticates, revoke makes it anonymous and protected calls 401', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: false, sessionEnabled: true });
    serversToStop.push(srv);

    const tokenStore = createMemoryTokenStore();
    const authClient = createGoodVibesAuthClient(operatorFor(srv.baseUrl), tokenStore);
    expect(authClient.writable).toBe(true);

    const login = await authClient.login(CREDENTIALS);
    expect(login.authenticated).toBe(true);
    expect(login.username).toBe('alice');
    const sessionToken = await authClient.getToken();
    expect(sessionToken).toBe(login.token);
    expect(srv.getSessions().has(login.token)).toBe(true);

    const authed = createGoodVibesAuthClient(operatorFor(srv.baseUrl, sessionToken), tokenStore);
    const current = await authed.current();
    expect(current.authenticated).toBe(true);
    expect(current.authMode).toBe('session');
    expect(current.principalId).toBe('alice');
    expect(authed.permissionResolver(current).hasRole('viewer')).toBe(true);

    const revokeRes = await fetch(`${srv.baseUrl}/api/local-auth/sessions/${login.token}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await authed.current();
    expect(afterRevoke.authenticated).toBe(false);
    expect(afterRevoke.authMode).toBe('anonymous');

    const protectedRes = await fetch(`${srv.baseUrl}/api/protected`, {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(protectedRes.status).toBe(401);

    await authClient.clearToken();
    expect(await authClient.getToken()).toBeNull();
  });

  test('login with persistToken false leaves the token store empty', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: false, sessionEnabled: true });
    serversToStop.push(srv);

    const authClient = createGoodVibesAuthClient(operatorFor(srv.baseUrl), createMemoryTokenStore());
    const login = await authClient.login(CREDENTIALS, { persistToken: false });
    expect(login.token.length).toBeGreaterThan(0);
    expect(await authClient.getToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 1.2: Shared-token-only mode
// ---------------------------------------------------------------------------

describe('auth-flow-e2e: shared-token-only mode', () => {
  test('shared token bearer is accepted as a token principal', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: true, sessionEnabled: true });
    serversToStop.push(srv);

    const authClient = createGoodVibesAuthClient(operatorFor(srv.baseUrl, SHARED_TOKEN), null);
    expect(authClient.writable).toBe(false);
    const current = await authClient.current();
    expect(current.authenticated).toBe(true);
    expect(current.authMode).toBe('shared-token');
    expect(current.principalKind).toBe('token');
  });

  test('unknown bearer token resolves to anonymous', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: true, sessionEnabled: false });
    serversToStop.push(srv);

    const authClient = createGoodVibesAuthClient(operatorFor(srv.baseUrl, 'wrong-token'), null);
    const current = await authClient.current();
    expect(current.authenticated).toBe(false);
    expect(current.authMode).toBe('anonymous');
  });
});

// ---------------------------------------------------------------------------
// Test 1.3: Both-configured fallthrough
// (sharedToken configured; session token still authenticated)
// ---------------------------------------------------------------------------

describe('auth-flow-e2e: both-configured fallthrough', () => {
  test('session token validates even when sharedToken is configured', async () => {
    const srv = buildFakeOperatorServer({ sharedTokenEnabled: true, sessionEnabled: true });
    serversToStop.push(srv);

    const login = await createGoodVibesAuthClient(operatorFor(srv.baseUrl), null).login(CREDENTIALS);

    const sessionCurrent = await createGoodVibesAuthClient(operatorFor(srv.baseUrl, login.token), null).current();
    expect(sessionCurrent.authenticated).toBe(true);
    expect(sessionCurrent.authMode).toBe('session');

    const sharedCurrent = await createGoodVibesAuthClient(operatorFor(srv.baseUrl, SHARED_TOKEN), null).current();
    expect(sharedCurrent.authenticated).toBe(true);
    expect(sharedCurrent.authMode).toBe('shared-token');
  });
});
