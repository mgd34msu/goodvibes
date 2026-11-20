// Proves: The control-plane socket is opened without a credential, or by a page from another origin riding the owner's sign-in cookie.
// Red when: The socket upgrade goes ahead without an authenticated principal, or for a sign-in cookie sent by a page whose origin is neither the daemon's own nor on the allowed list (or with no origin and no bearer).
/**
 * This is the only place a control-plane socket is created, and it is created
 * already authenticated with the full event grant. The real
 * DaemonControlPlaneHelper over a real UserAuthManager and pairing store; the
 * server's upgrade is the stand-in and records what it was asked to open.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { ownBrowserOrigins } from '../platform/src/platform/daemon/http/browser-origin.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const OPERATOR_TOKEN = 'synthetic-operator-token-for-the-socket-proof';
const DAEMON = 'http://127.0.0.1:3421';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-socket-upgrade-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('no credential, a wrong one, or the sign-in cookie from another origin opens no socket; the own origin, an allowed one and a bearer do', () => {
  const config = new ConfigManager({ configDir: join(dir, 'config'), workingDir: dir, homeDir: join(dir, 'home'), surfaceRoot: 'goodvibes', daemonTierPath: join(dir, 'daemon', 'settings.json'), ownsDaemonTier: true });
  config.set('controlPlane.cors.allowedOrigins', 'https://allowed.example');
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: new GatewayMethodCatalog(), userAuth, pairingTokens: new PairingTokenManager(join(dir, 'pairing-tokens.json')),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 3421,
    // The daemon's own browser origins as its composition reads them: the bound listener and the settings (an allowed origin among them).
    allowedBrowserOrigins: () => ownBrowserOrigins(config, () => ({ host: '127.0.0.1', port: 3421, scheme: 'http' })),
  } as unknown as DaemonControlPlaneContext);
  const cookie = `goodvibes_session=${encodeURIComponent(userAuth.createSession('admin').token)}`;
  const opened: { authenticated?: boolean }[] = [];
  const server = { upgrade: (_req: Request, options?: { data?: unknown }) => { opened.push(options?.data as { authenticated?: boolean }); return true; } };
  const upgrade = (headers: Record<string, string>) => {
    const before = opened.length;
    const result = helper.tryUpgradeControlPlaneWebSocket(new Request(`${DAEMON}/api/control-plane/ws`, { headers }), server);
    return `${result instanceof Response ? result.status : result}${opened.length > before ? ' opened' : ''}`;
  };
  const rows: ReadonlyArray<readonly [string, Record<string, string>, string]> = [
    ['no credential', { origin: DAEMON }, '401'],
    ['a wrong bearer', { authorization: 'Bearer not-the-token' }, '401'],
    ['the cookie from another origin', { cookie, origin: 'https://elsewhere.example' }, '403'],
    ['the cookie from another port on this host', { cookie, origin: 'http://127.0.0.1:8080' }, '403'],
    ['the cookie from an opaque origin', { cookie, origin: 'null' }, '403'],
    ['the cookie with no origin and no bearer', { cookie }, '403'],
    ['the cookie from the daemon\'s own origin', { cookie, origin: DAEMON }, 'upgraded opened'],
    ['the cookie from an allowed origin', { cookie, origin: 'https://allowed.example' }, 'upgraded opened'],
    ['a bearer with no origin', { authorization: `Bearer ${OPERATOR_TOKEN}` }, 'upgraded opened'],
  ];
  for (const [name, headers, expected] of rows) expect(`${name}: ${upgrade(headers)}`).toBe(`${name}: ${expected}`);
  expect(opened.every((data) => data.authenticated === true)).toBe(true);
});
