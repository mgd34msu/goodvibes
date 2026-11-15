/** The startup refusal "enforceCors with no allowedOrigins on a network bind" is
 * decided from the address the listener really binds, not the hostMode text alone
 * (a custom host of 0.0.0.0 binds every interface),
 * and the webhook accepts only known hook phases. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { HttpListener } from '../platform/src/platform/daemon/http-listener.js';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { stopListenerTimers } from './_helpers/listener-teardown.ts';

const disposables = trackDisposables();

function fixture(settings: { hostMode?: string; host?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-cors-guard-'));
  mkdirSync(dir, { recursive: true });
  const configManager = new ConfigManager({ configDir: dir });
  if (settings.hostMode !== undefined) configManager.set('httpListener.hostMode', settings.hostMode as 'local' | 'network' | 'custom');
  if (settings.host !== undefined) configManager.set('httpListener.host', settings.host);
  configManager.set('httpListener.port', 59701);
  const userAuth = new UserAuthManager({
    users: [],
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
  return { dir, configManager, userAuth };
}

function construct(settings: { hostMode?: string; host?: string }, extra: { hookDispatcher?: unknown } = {}) {
  const { dir, configManager, userAuth } = fixture(settings);
  let captured: ((req: Request, server: { requestIP(req: Request): { address: string } }) => Promise<Response>) | null = null;
  const serveFactory = ((options: { fetch: typeof captured }) => {
    captured = options.fetch;
    return { stop: () => {} };
  }) as unknown as typeof Bun.serve;
  try {
    const listener = new HttpListener({
      configManager,
      userAuth,
      allowedOrigins: [],
      enforceCors: true,
      serveFactory,
      ...(extra.hookDispatcher ? { hookDispatcher: extra.hookDispatcher as never } : {}),
    });
    disposables.add(listener, stopListenerTimers);
    listener.enable({ httpListener: true }, 'test-token');
    return {
      listener,
      dispatch: (req: Request) => captured!(req, { requestIP: () => ({ address: '127.0.0.1' }) }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('enforceCors with empty allowedOrigins is refused for every network-reachable bind', () => {
  test.each([
    ['exact network', { hostMode: 'network' }],
    ['custom bound to every interface', { hostMode: 'custom', host: '0.0.0.0' }],
    ['custom bound to a LAN address', { hostMode: 'custom', host: '192.168.1.20' }],
  ])('%s', (_label, settings) => {
    expect(() => construct(settings)).toThrow('SECURITY_UNSAFE_ORIGIN_CONFIG');
  });

  test.each([
    ['local', { hostMode: 'local' }],
    ['custom bound to loopback', { hostMode: 'custom', host: '127.0.0.1' }],
  ])('%s binds loopback and constructs', (_label, settings) => {
    expect(() => construct(settings)).not.toThrow();
  });
});

describe('webhook hook phase', () => {
  test('an unknown phase is a 400 and never reaches the dispatcher', async () => {
    const fired: unknown[] = [];
    const { listener, dispatch } = construct({ hostMode: 'local' }, {
      hookDispatcher: { fire: async (event: unknown) => { fired.push(event); return { ok: true }; } },
    });
    await listener.start();
    const res = await dispatch(new Request('http://127.0.0.1/webhook', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'Sudo', event: 'anything' }),
    }));
    expect(res.status).toBe(400);
    expect(fired).toEqual([]);
    listener.stop();
  });

  test('a known phase is dispatched', async () => {
    const fired: Array<{ phase: string }> = [];
    const { listener, dispatch } = construct({ hostMode: 'local' }, {
      hookDispatcher: { fire: async (event: { phase: string }) => { fired.push(event); return { ok: true }; } },
    });
    await listener.start();
    const res = await dispatch(new Request('http://127.0.0.1/webhook', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'Fail', event: 'build' }),
    }));
    expect(res.status).toBe(200);
    expect(fired.map((event) => event.phase)).toEqual(['Fail']);
    listener.stop();
  });
});
