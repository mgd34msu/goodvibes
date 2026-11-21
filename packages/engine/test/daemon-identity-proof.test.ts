// Proves: A starting app sends the operator token to whatever answers the daemon's port.
// Red when: The token is sent before the daemon's identity answer is verified for the dialled port.
// Proves: A client sends this machine's daemon token, or the token stored for one daemon, to another daemon it was not issued for.
// Red when: The target resolver falls back to this machine's token for a connected or typed daemon that is not this machine's, the one header builder attaches a bound credential to a URL on another origin, or the Agent's credential reader or the pair command's local target hands this machine's token to another machine's address.
/**
 * A terminal app that finds something listening on the daemon's port asks it to
 * prove it holds the operator token before it sends that token. The stand-in is
 * a loopback server that records every Authorization header it receives and
 * answers in one of three ways: with no proof, with a proof made for another
 * port (what a process that forwards the challenge to the real daemon gets
 * back), or with the proof for the port the app dialled. Only the last receives
 * the token. The app's own start-up path (`startHostServices`, its port probe and
 * its identity probe) runs unchanged.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import {
  createDaemonIdentityProof,
  DAEMON_CHALLENGE_HEADER,
  DAEMON_PROOF_HEADER,
  DAEMON_PROOF_PORT_HEADER,
} from '../platform/src/platform/daemon/identity-proof.ts';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';
import { startHostServices } from '../platform/src/platform/runtime/bootstrap-services.ts';
import { resolveDaemonTarget } from '../platform/src/platform/runtime/client/daemon-target-resolver.ts';
import { daemonAuthHeaders } from '../platform/src/platform/runtime/client/daemon-target.ts';
import { writeConnectedDaemonToken } from '../platform/src/platform/runtime/client/daemon-credentials.ts';
import { getOrCreateCompanionToken } from '../platform/src/platform/pairing/companion-token.ts';
import { resolveGoodVibesDaemonHome } from '../platform/src/platform/config/goodvibes-home.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { readConnectedHostBootstrapToken, readConnectedHostOperatorToken } from '../terminal-shell/src/agent-turn/connected-host-auth.ts';
import { resolveLocalDaemonTarget } from '../terminal-shell/src/cluster-remote-daemon-target.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema-types.ts';
import type { RuntimeServices } from '../platform/src/platform/runtime/services.ts';

const TOKEN = 'operator-token-held-by-the-daemon';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type Answer = 'no proof' | 'proof for another port' | 'proof for this port';

/** Something on the daemon's port: it records each Authorization header and answers as told. */
function listener(answer: Answer) {
  const authorizations: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, self) {
      const auth = request.headers.get('authorization');
      if (auth) authorizations.push(auth);
      const challenge = request.headers.get(DAEMON_CHALLENGE_HEADER) ?? '';
      const port = answer === 'proof for this port' ? self.port! : self.port! + 1;
      const proof = answer === 'no proof' ? {} : { [DAEMON_PROOF_HEADER]: createDaemonIdentityProof(TOKEN, challenge, port), [DAEMON_PROOF_PORT_HEADER]: String(port) };
      return auth === `Bearer ${TOKEN}`
        ? Response.json({ status: 'running', version: '1.0.0' }, { headers: proof })
        : Response.json({ error: 'unauthorized' }, { status: 401, headers: proof });
    },
  });
  cleanups.push(() => { void server.stop(true); });
  return { port: server.port!, authorizations };
}

async function startApp(port: number) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-identity-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configManager = new ConfigManager({ configDir: join(dir, 'config') });
  // Start-up reads only these two services, and only when it builds an HTTP listener, which this app does not.
  const services = { localUserAuthManager: undefined, configManager } as unknown as RuntimeServices;
  const handle = await startHostServices(configManager, new HookDispatcher(), services, {
    daemon: resolveDaemonTarget({ configManager, homeDirectory: dir, explicit: { url: `http://127.0.0.1:${port}`, token: TOKEN } }),
    localDaemonVersion: '1.0.0',
  });
  await handle.stop();
  return handle.daemonStatus.mode;
}

test('the token is sent only to an answer that proves it is the daemon on the dialled port', async () => {
  const seen: Array<[Answer, { mode: string; authorizations: string[] }]> = [];
  for (const answer of ['no proof', 'proof for another port', 'proof for this port'] as const) {
    const server = listener(answer);
    seen.push([answer, { mode: await startApp(server.port), authorizations: server.authorizations }]);
  }
  expect(Object.fromEntries(seen)).toEqual({
    'no proof': { mode: 'blocked', authorizations: [] },
    'proof for another port': { mode: 'blocked', authorizations: [] },
    'proof for this port': { mode: 'external', authorizations: [`Bearer ${TOKEN}`] },
  });
});

test('a credential goes only to the daemon it was issued for: this machine\'s token never to another daemon, a stored token never to a third', () => {
  const home = mkdtempSync(join(tmpdir(), 'gv-bound-credential-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const machineToken = getOrCreateCompanionToken('tui', { daemonHomeDir: resolveGoodVibesDaemonHome(home) }).token;
  const configManager = new ConfigManager({ configDir: join(home, 'config') });
  const thisMachine = `http://127.0.0.1:${String(configManager.get('controlPlane.port' as ConfigKey))}`;
  const otherOnThisHost = 'http://127.0.0.1:4555', otherDaemon = 'http://192.0.2.10:3421', storedDaemon = 'http://192.0.2.20:3421';
  writeConnectedDaemonToken(home, storedDaemon, 'token-issued-by-the-stored-daemon');
  const connectTo = (url: string | null) => {
    const set = configManager.setMany([{ key: 'daemon.connectedHost.url' as ConfigKey, value: url ?? '' }], localOwnerActor());
    if (!set.ok) throw new Error(`the connected host could not be set to ${url}`);
  };
  /** Which token a request to `url` would carry, built by the one header builder, or the refusal code. */
  const sent = (url: string, explicit?: { readonly url: string }) => {
    try {
      const resolution = resolveDaemonTarget({ configManager, homeDirectory: home, ...(explicit ? { explicit } : {}) });
      if (!resolution.ok) return `refused ${resolution.refusal.code}`;
      const authorization = daemonAuthHeaders(resolution.target, `${url}/api/control-plane/status`).Authorization ?? '';
      return authorization === `Bearer ${machineToken}` ? 'this machine\'s token' : authorization.replace(/^Bearer /, '');
    } catch (error) {
      return `refused ${(error as { code?: string }).code}`;
    }
  };
  const rows: Array<readonly [string, () => string, string]> = [
    ['the connected host is another daemon on this host with nothing stored', () => { connectTo(otherOnThisHost); return sent(otherOnThisHost); }, 'refused CREDENTIAL_NOT_FOR_TARGET'],
    ['an address typed for another daemon, no token', () => { connectTo(null); return sent(otherDaemon, { url: otherDaemon }); }, 'refused CREDENTIAL_NOT_FOR_TARGET'],
    ['a stored daemon\'s credential on a request to another daemon', () => { connectTo(storedDaemon); return sent(otherDaemon); }, 'refused CREDENTIAL_NOT_FOR_TARGET'],
    // The controls: each daemon gets the token issued for it.
    ['the connected host with its own stored token', () => { connectTo(storedDaemon); return sent(storedDaemon); }, 'token-issued-by-the-stored-daemon'],
    ['this machine\'s daemon', () => { connectTo(null); return sent(thisMachine); }, 'this machine\'s token'],
  ];
  for (const [name, run, expected] of rows) expect(`${name}: ${run()}`).toBe(`${name}: ${expected}`);
});

test('the Agent and goodvibes-daemon pair give this machine\'s token only to this machine\'s daemon, whatever host is configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'gv-agent-credential-'));
  const saved = { connected: process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemon: process.env.GOODVIBES_DAEMON_TOKEN };
  cleanups.push(() => {
    rmSync(home, { recursive: true, force: true });
    for (const [name, value] of [['GOODVIBES_CONNECTED_HOST_TOKEN', saved.connected], ['GOODVIBES_DAEMON_TOKEN', saved.daemon]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
  // This machine's daemon token, in its file (what the Agent reads) and in the environment.
  const fileToken = getOrCreateCompanionToken('tui', { daemonHomeDir: resolveGoodVibesDaemonHome(home) }).token;
  const configManager = new ConfigManager({ configDir: join(home, 'config') });
  const thisMachine = `http://127.0.0.1:${String(configManager.get('controlPlane.port' as ConfigKey))}`;
  const otherDaemon = 'http://192.0.2.10:3421';
  const named = (token: string | null | undefined) => token === fileToken ? 'the file token' : token === 'environment-daemon-token' ? 'the environment token' : 'no token';
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    if (value === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = value;
    return run();
  };
  const rows: Array<readonly [string, () => string, string]> = [
    ['the Agent dialling another machine, the daemon token in the environment', () => withEnv('environment-daemon-token', () => named(readConnectedHostOperatorToken(home, otherDaemon).token)), 'no token'],
    ['the Agent dialling another machine, the daemon token in its file', () => withEnv(undefined, () => named(readConnectedHostOperatorToken(home, otherDaemon).token)), 'no token'],
    ['the Agent repeating a pairing request to another machine', () => withEnv('environment-daemon-token', () => named(readConnectedHostBootstrapToken(home, otherDaemon).token)), 'no token'],
    ['goodvibes-daemon pair with the connected host set to another machine', () => {
      const set = configManager.setMany([{ key: 'daemon.connectedHost.url' as ConfigKey, value: otherDaemon }], localOwnerActor());
      if (!set.ok) throw new Error('the connected host could not be set');
      const resolved = resolveLocalDaemonTarget({ configManager, daemonHomeDir: resolveGoodVibesDaemonHome(home) });
      return resolved.ok ? `${named(resolved.target.token)} to ${resolved.target.baseUrl === thisMachine ? 'this machine' : resolved.target.baseUrl}` : `refused ${resolved.code}`;
    }, 'the file token to this machine'],
    // The controls: this machine's daemon is given its token.
    ['the Agent dialling this machine, the daemon token in the environment', () => withEnv('environment-daemon-token', () => named(readConnectedHostOperatorToken(home, thisMachine).token)), 'the environment token'],
    ['the Agent dialling this machine, the daemon token in its file', () => withEnv(undefined, () => named(readConnectedHostOperatorToken(home, thisMachine).token)), 'the file token'],
  ];
  for (const [name, run, expected] of rows) expect(`${name}: ${run()}`).toBe(`${name}: ${expected}`);
});
