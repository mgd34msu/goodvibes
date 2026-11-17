/**
 * Password guessing on POST /login is throttled per caller, the throttle holds
 * even for the right password, a caller cannot buy a fresh budget by naming
 * another address unless the listener trusts a proxy, and a disallowed origin
 * is refused before the sign-in is read.
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

test('without a trusted proxy, naming another address in a forwarding header buys no fresh budget', async () => {
  const { listener, dispatch } = await listen({ loginRateLimit: 2 });
  const statuses: number[] = [];
  for (const forwarded of ['10.1.0.1', '10.1.0.2', '10.1.0.3', '10.1.0.4']) {
    statuses.push((await dispatch(login('guess', { 'x-forwarded-for': forwarded }), '198.51.100.7')).status);
  }
  expect(statuses).toEqual([401, 401, 429, 429]);
  listener.stop();
});

test('behind a trusted proxy each forwarded client has its own budget', async () => {
  const { listener, dispatch } = await listen({ loginRateLimit: 2, trustProxy: true });
  const first = [];
  for (let i = 0; i < 3; i++) first.push((await dispatch(login('guess', { 'x-forwarded-for': '10.1.0.1' }))).status);
  expect(first).toEqual([401, 401, 429]);
  expect((await dispatch(login('guess', { 'x-forwarded-for': '10.1.0.2' }))).status).toBe(401);
  listener.stop();
});

test('a disallowed origin is refused before the sign-in is read', async () => {
  const { listener, dispatch } = await listen({ loginRateLimit: 5, allowedOrigins: ['http://allowed.example.com'], enforceCors: true });
  expect((await dispatch(login('owner-password', { Origin: 'http://evil.attacker.com' }))).status).toBe(403);
  listener.stop();
});
