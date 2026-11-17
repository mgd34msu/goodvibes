/**
 * Changing address does not buy fresh password guesses on POST /login: the
 * addresses of one IPv6 /64 share one budget, and once a username has failed
 * many times from any addresses every sign-in for it waits, the right
 * password included.
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
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-login-rotation-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Fetch = (req: Request, server: { requestIP(req: Request): { address: string } }) => Promise<Response>;

async function listen(loginRateLimit: number) {
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(dir, 'auth-users.json'), bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'), scryptParams: FAST,
  });
  userAuth.addUser('owner', 'owner-password', ['admin']);
  let fetch: Fetch | null = null;
  const serveFactory = ((options: { fetch: Fetch }) => { fetch = options.fetch; return { stop: () => {} }; }) as unknown as typeof Bun.serve;
  const listener = new HttpListener({
    configManager: new ConfigManager({ configDir: join(dir, 'config') }), userAuth,
    rateLimit: 60, loginRateLimit, allowedOrigins: [], trustProxy: false, serveFactory,
  });
  listener.enable({ httpListener: true }, 'test-shared-token');
  await listener.start();
  const dispatch = (password: string, peer: string) => {
    if (!fetch) throw new Error('listener not started');
    const req = new Request('http://127.0.0.1/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }),
    });
    return fetch(req, { requestIP: () => ({ address: peer }) });
  };
  return { listener, dispatch };
}

test('the addresses of one IPv6 /64 share one sign-in budget', async () => {
  const { listener, dispatch } = await listen(2);
  const statuses: number[] = [];
  for (const peer of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff::3']) {
    statuses.push((await dispatch('guess', peer)).status);
  }
  expect(statuses).toEqual([401, 401, 429]);
  // Another /64 is another budget.
  expect((await dispatch('owner-password', '2001:db8:1:3::1')).status).toBe(200);
  listener.stop();
});

test('after many failures from changing addresses every sign-in for the username waits', async () => {
  const { listener, dispatch } = await listen(1_000);
  for (let i = 1; i <= 50; i++) expect((await dispatch('guess', `198.51.100.${i}`)).status).toBeOneOf([401, 429]);
  const answer = await dispatch('owner-password', '203.0.113.9');
  expect(answer.status).toBe(429);
  expect(Number(answer.headers.get('retry-after'))).toBeGreaterThan(0);
  listener.stop();
});
