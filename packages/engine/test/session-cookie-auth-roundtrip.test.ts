/**
 * session-cookie-auth-roundtrip.test.ts
 *
 * Session-cookie authentication when a shared operator token is also
 * configured (the Android companion client logs in with a cookie while the
 * daemon has a shared token).
 *
 * Coverage:
 *   1. authenticateOperatorToken accepts session tokens with or without a
 *      shared token, and rejects unknown and revoked ones
 *   2. Through the real DaemonHttpRouter and DaemonControlPlaneHelper: a login
 *      cookie authenticates GET /api/control-plane/auth and
 *      POST /api/companion/chat/sessions; the same requests without the cookie
 *      are refused
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  authenticateOperatorToken,
  OPERATOR_SESSION_COOKIE_NAME,
  buildOperatorSessionCookie,
} from '../platform/src/platform/security/http-auth.js';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import type { CompanionLLMProvider, CompanionChatEventPublisher, CompanionProviderChunk } from '../platform/src/platform/companion/companion-chat-manager.js';
import { CompanionChatManager } from '../platform/src/platform/companion/companion-chat-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-auth-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeUserAuth(dir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
    // Seed explicit users so we skip filesystem bootstrap for determinism
    users: [{
      username: 'testuser',
      passwordHash: UserAuthManager.hashPassword('testpass123'),
      roles: ['admin'],
    }],
  });
}

function makeMockProvider(): CompanionLLMProvider {
  return {
    async *chatStream(): AsyncIterable<CompanionProviderChunk> {
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done' };
    },
  };
}

function makeCompanionManager(): CompanionChatManager {
  const publisher: CompanionChatEventPublisher = { publishEvent() {} };
  return new CompanionChatManager({
    provider: makeMockProvider(),
    eventPublisher: publisher,
    gcIntervalMs: 999_999,
  });
}

/**
 * The real router with the real operator-auth helper behind its auth gate, the
 * way the daemon facade wires it. Only collaborators the exercised routes never
 * touch are left out.
 */
function makeRouter(userAuth: UserAuthManager, sharedToken: string | null, manager: CompanionChatManager): DaemonHttpRouter {
  const gatewayMethods = { findByHttpBinding: () => null, get: () => null, list: () => [], listEvents: () => [], getAllScopes: () => [] as string[] };
  const helper = new DaemonControlPlaneHelper({
    authToken: () => sharedToken,
    userAuth,
    gatewayMethods,
    trustProxyEnabled: () => false,
  } as unknown as DaemonControlPlaneContext);
  return new DaemonHttpRouter({
    configManager: { get: () => undefined },
    gatewayMethods,
    controlPlaneGateway: {},
    userAuth,
    runtimeStore: null,
    runtimeDispatch: null,
    authToken: () => sharedToken,
    authenticateRequest: (req: Request) => helper.authenticateRequest(req),
    extractAuthToken: (req: Request) => helper.extractAuthToken(req),
    requireAuthenticatedSession: (req: Request) => helper.requireAuthenticatedSession(req),
    companionChatManager: manager,
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);
}

function loginCookie(userAuth: UserAuthManager): string {
  const loginAuth = userAuth.authenticate('testuser', 'testpass123');
  if (!loginAuth.ok) throw new Error('Expected successful auth');
  const session = userAuth.createSession(loginAuth.user.username);
  const cookieHeader = buildOperatorSessionCookie(session.token, {
    req: new Request('http://127.0.0.1/login', { method: 'POST' }),
    expiresAt: session.expiresAt,
  });
  // Just the name=value pair, as a client sends it back.
  return cookieHeader.split(';')[0]!;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];
const cleanupManagers: CompanionChatManager[] = [];

afterEach(() => {
  for (const manager of cleanupManagers.splice(0)) {
    manager.dispose();
  }
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Test cleanup should not mask the assertion result.
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Unit: authenticateOperatorToken with sharedToken set must accept session tokens
// ---------------------------------------------------------------------------

describe('authenticateOperatorToken session validation when sharedToken is set', () => {
  test('accepts a valid session token even when sharedToken is configured', () => {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const authResult = userAuth.authenticate('testuser', 'testpass123');
    if (!authResult.ok) throw new Error('Expected successful auth');
    const session = userAuth.createSession(authResult.user.username);
    const sharedToken = 'operator-shared-token-xyz';

    const result = authenticateOperatorToken(session.token, { sharedToken, userAuth });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('session');
    if (result!.kind === 'session') {
      expect(result!.username).toBe('testuser');
      expect(result!.roles).toContain('admin');
    }
  });

  test('rejects a token that matches neither shared-token nor any session', () => {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const sharedToken = 'operator-shared-token-xyz';

    const result = authenticateOperatorToken('bogus-token-that-does-not-match-anything', { sharedToken, userAuth });
    expect(result).toBeNull();
  });

  test('accepts the sharedToken itself when sharedToken is configured', () => {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const sharedToken = 'operator-shared-token-xyz';

    const result = authenticateOperatorToken(sharedToken, { sharedToken, userAuth });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('shared-token');
  });

  test('accepts a valid session token when NO sharedToken is configured', () => {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const authResult = userAuth.authenticate('testuser', 'testpass123');
    if (!authResult.ok) throw new Error('Expected successful auth');
    const session = userAuth.createSession(authResult.user.username);

    const result = authenticateOperatorToken(session.token, { sharedToken: null, userAuth });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('session');
  });

  test('rejects a revoked session token even when sharedToken is set', () => {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const sharedToken = 'operator-shared-token-xyz';

    const authResult = userAuth.authenticate('testuser', 'testpass123');
    if (!authResult.ok) throw new Error('Expected successful auth');
    const session = userAuth.createSession(authResult.user.username);
    // Revoke the session, it should no longer validate
    userAuth.revokeSession(session.token);

    const result = authenticateOperatorToken(session.token, { sharedToken, userAuth });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Through the router: cookie -> auth gate -> route
// ---------------------------------------------------------------------------

const SHARED_TOKEN = 'daemon-operator-shared-token';

describe('session-cookie auth through the daemon router', () => {
  function setup() {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const manager = makeCompanionManager();
    cleanupManagers.push(manager);
    return { userAuth, router: makeRouter(userAuth, SHARED_TOKEN, manager) };
  }

  const authRequest = (headers: Record<string, string>) =>
    new Request('http://127.0.0.1/api/control-plane/auth', { method: 'GET', headers });

  test('GET /api/control-plane/auth reports the logged-in user for a session cookie while a shared token is configured', async () => {
    const { userAuth, router } = setup();
    const res = await router.handleRequest(authRequest({ Cookie: loginCookie(userAuth) }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      authenticated: boolean; authMode: string; sessionCookiePresent: boolean; principalId: string | null; principalKind: string | null;
    };
    expect(body.authenticated).toBe(true);
    expect(body.authMode).toBe('session');
    expect(body.sessionCookiePresent).toBe(true);
    expect(body.principalId).toBe('testuser');
    expect(body.principalKind).toBe('user');
  });

  test('a percent-encoded cookie value is decoded the way the browser sends it back', async () => {
    const { userAuth, router } = setup();
    const [name, value] = loginCookie(userAuth).split('=') as [string, string];
    const res = await router.handleRequest(authRequest({ Cookie: `other=1; ${name}=${encodeURIComponent(value)}` }));
    const body = await res.json() as { authenticated: boolean; authMode: string };
    expect(body.authMode).toBe('session');
    expect(body.authenticated).toBe(true);
  });

  test('GET /api/control-plane/auth reports the shared token, and calls an unrecognized bearer or cookie invalid', async () => {
    const { router } = setup();
    const shared = await router.handleRequest(authRequest({ Authorization: `Bearer ${SHARED_TOKEN}` }));
    expect(await shared.json()).toMatchObject({ authenticated: true, authMode: 'shared-token' });

    const bogusBearer = await router.handleRequest(authRequest({ Authorization: 'Bearer completely-unknown-token' }));
    expect(await bogusBearer.json()).toMatchObject({ authenticated: false, authMode: 'invalid' });
    const bogusCookie = await router.handleRequest(authRequest({ Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=completely-unknown-token` }));
    expect(await bogusCookie.json()).toMatchObject({ authenticated: false, authMode: 'invalid', sessionCookiePresent: true });
  });

  test('a request with no credentials is reported anonymous', async () => {
    const { router } = setup();
    const res = await router.handleRequest(authRequest({}));
    expect(await res.json()).toMatchObject({ authenticated: false, authMode: 'anonymous' });
  });
});

describe('companion-chat session creation via session-cookie auth', () => {
  const createRequest = (headers: Record<string, string>) =>
    new Request('http://127.0.0.1/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ title: 'android-test-session', provider: 'inception', model: 'mercury-2' }),
    });

  function setup() {
    const dir = makeTmpDir();
    cleanupDirs.push(dir);
    const userAuth = makeUserAuth(dir);
    const manager = makeCompanionManager();
    cleanupManagers.push(manager);
    return { userAuth, router: makeRouter(userAuth, SHARED_TOKEN, manager) };
  }

  test('POST /api/companion/chat/sessions creates a session for a valid cookie, with a shared token configured', async () => {
    const { userAuth, router } = setup();
    const res = await router.handleRequest(createRequest({ Cookie: loginCookie(userAuth) }));
    expect(res.status).toBe(201);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('the same request without the cookie, or with a revoked session cookie, is refused and creates nothing', async () => {
    const { userAuth, router } = setup();
    const cookie = loginCookie(userAuth);
    userAuth.revokeSession(cookie.split('=')[1]!);

    expect((await router.handleRequest(createRequest({}))).status).toBe(401);
    expect((await router.handleRequest(createRequest({ Cookie: cookie }))).status).toBe(401);
  });
});
