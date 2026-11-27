// Proves: Password guessing against one username from changing addresses is unlimited.
// Red when: The per-username slow-down in `UserAuthManager.authenticateSignIn` is removed or stops counting across addresses: after fifty failures from changing addresses, the right password from an address that failed once answers 200.
// Proves: Password guessing from one caller is not throttled.
// Red when: The sign-in limiter is not consulted before the password check, or a right password skips it: the fourth and fifth attempts are not 429.
/**
 * Password guessing on POST /login is throttled per caller, the throttle holds
 * even for the right password, and once a username has failed many times from
 * changing addresses every address that failed for it waits; an address that
 * never failed is not held (the owner's way back in).
 *
 * The real HttpListener, its limiter, router and the real user store over a
 * temp directory; only Bun.serve is replaced by an in-process dispatch, so no
 * port is bound.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { HttpListener } from '../platform/src/platform/daemon/http-listener.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';

/** A cheap hash cost: the throttle is under test, not scrypt. */
const FAST = { N: 1024, r: 1, p: 1 };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-login-rate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Fetch = (req: Request, server: { requestIP(req: Request): { address: string } }) => Promise<Response>;

async function listen(opts: { loginRateLimit: number; trustProxy?: boolean; allowedOrigins?: string[]; enforceCors?: boolean }) {
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'), bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'), scryptParams: FAST,
  });
  userAuth.addUser('owner', 'owner-password', ['admin']);
  let fetch: Fetch | null = null;
  const serveFactory = ((options: { fetch: Fetch }) => { fetch = options.fetch; return { stop: () => {} }; }) as unknown as typeof Bun.serve;
  const listener = new HttpListener({
    configManager: new ConfigManager({ configDir: join(dir, 'config') }), userAuth,
    rateLimit: 60, loginRateLimit: opts.loginRateLimit, allowedOrigins: opts.allowedOrigins ?? [],
    trustProxy: opts.trustProxy ?? false, enforceCors: opts.enforceCors, serveFactory,
  });
  listener.enable({ httpListener: true }, 'test-shared-token');
  await listener.start();
  const dispatch = (req: Request, peer = '127.0.0.1') => {
    if (!fetch) throw new Error('listener not started');
    return fetch(req, { requestIP: () => ({ address: peer }) });
  };
  return { listener, dispatch };
}

function login(password: string, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'owner', password }),
  });
}

test('after the budget every attempt from that caller is refused, the right password included', async () => {
  const { listener, dispatch } = await listen({ loginRateLimit: 3 });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await dispatch(login('guess'), '198.51.100.7')).status);
  statuses.push((await dispatch(login('owner-password'), '198.51.100.7')).status);
  statuses.push((await dispatch(login('guess'), '198.51.100.7')).status);
  expect(statuses).toEqual([401, 401, 401, 429, 429]);
  // Another caller is not held by the first one's guesses.
  expect((await dispatch(login('owner-password'), '198.51.100.8')).status).toBe(200);
  listener.stop();
});

test('after many failures from changing addresses every address that guessed waits; one that never failed signs in', async () => {
  const { listener, dispatch } = await listen({ loginRateLimit: 1_000 });
  for (let i = 1; i <= 50; i++) expect((await dispatch(login('guess'), `198.51.100.${i}`)).status).toBeOneOf([401, 429]);
  // An address that failed once: its own one failure holds nothing, the fifty counted across addresses do, the right
  // password included.
  const guessed = await dispatch(login('owner-password'), '198.51.100.7');
  expect(guessed.status).toBe(429);
  expect(Number(guessed.headers.get('retry-after'))).toBeGreaterThan(0);
  // The control, and the owner's way back in: an address that never failed is never held by the others' guesses.
  expect((await dispatch(login('owner-password'), '203.0.113.9')).status).toBe(200);
  listener.stop();
});
