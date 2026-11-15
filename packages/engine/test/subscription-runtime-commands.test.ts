import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSubscriptionRuntimeCommands } from '../terminal-shell/src/subscription-runtime-commands.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

type Handler = (args: string[], ctx: Ctx) => Promise<void>;
interface Ctx { print(message: string): void }
const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function fixture(options: { confirmMutations: boolean; dir: string; port?: number; manager?: Record<string, unknown> }) {
  const printed: string[] = [];
  const exchanged: string[] = [];
  const service = options.port === undefined ? undefined : {
    name: 'acme', authType: 'oauth', tokenKey: 'ACME_API_KEY',
    oauth: { authUrl: 'https://acme.invalid/auth', tokenUrl: 'https://acme.invalid/token', clientId: 'c', redirectUri: 'http://127.0.0.1/cb',
      localCallback: { host: '127.0.0.1', port: options.port, path: '/cb' } },
  };
  const manager = {
    list: () => [{ provider: 'acme', authMode: 'oauth', accessToken: 'live-access-token', refreshToken: 'live-refresh-token', tokenType: 'Bearer' }],
    get: () => undefined,
    getPending: () => ({ state: 'expected-state', verifier: 'v' }),
    completeOAuthLogin: async (_p: string, _c: unknown, code: string) => { exchanged.push(code); return { tokenType: 'Bearer', overrideAmbientApiKeys: false }; },
    ...options.manager,
  };
  let handler: Handler | undefined;
  const { registerSubscriptionRuntimeCommands } = createSubscriptionRuntimeCommands<Ctx>({
    requireSubscriptionManager: () => manager as never,
    requireServiceRegistry: () => ({ getAll: () => ({}), get: () => service }) as never,
    requireSecretsManager: () => ({}) as never,
    requireShellPaths: () => ({ resolveWorkspacePath: (path: string) => join(options.dir, path) }) as never,
  }, {
    hidden: false, confirmMutations: options.confirmMutations, eagerPaths: false, openModalOnEmpty: false, manualOnly: false,
    catchErrors: false, surfaceRoot: 'tui', formatSource: (s) => s, error: String, present: (m) => m,
  });
  registerSubscriptionRuntimeCommands({ register: (command: { handler: Handler }) => { handler = command.handler; } } as never);
  const run = (...args: string[]) => handler!(args, { print: (m) => printed.push(m) });
  return { run, printed, exchanged };
}

describe('subscription bundle export', () => {
  for (const confirmMutations of [true, false]) {
    const label = confirmMutations ? 'confirming policy' : 'non-confirming policy';
    test(`${label}: refuses without --yes and writes nothing`, async () => {
      const dir = makeProjectTempDir('subscription-export');
      const f = fixture({ confirmMutations, dir });
      await f.run('bundle', 'export', 'tokens.json');
      expect(existsSync(join(dir, 'tokens.json'))).toBe(false);
      expect(f.printed.join('\n')).toContain('--yes');
    });
    test(`${label}: with --yes the file is owner-only and the token warning is printed`, async () => {
      const dir = makeProjectTempDir('subscription-export');
      const f = fixture({ confirmMutations, dir });
      await f.run('bundle', 'export', 'tokens.json', '--yes');
      const path = join(dir, 'tokens.json');
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(JSON.parse(readFileSync(path, 'utf-8')).subscriptions).toHaveLength(1);
      expect(f.printed.join('\n')).toContain('active sign-in tokens');
    });
  }
});

describe('subscription bundle inspect', () => {
  test('a JSON file that is not a subscription bundle gets a clear message, not a TypeError', async () => {
    const dir = makeProjectTempDir('subscription-inspect');
    writeFileSync(join(dir, 'other.json'), '{}');
    const f = fixture({ confirmMutations: false, dir });
    await f.run('bundle', 'inspect', 'other.json');
    expect(f.printed.join('\n')).toContain('is not a subscription bundle');
  });
});

describe('OAuth local listener', () => {
  test('is closed when starting the login throws', async () => {
    const dir = makeProjectTempDir('subscription-listener');
    const port = await freePort();
    const f = fixture({ confirmMutations: false, dir, port, manager: { beginOAuthLogin: async () => { throw new Error('begin failed'); } } });
    await expect(f.run('login', 'acme', 'start', '--no-browser', '--yes')).rejects.toThrow('begin failed');
    expect(await canBind(port)).toBe(true);
  });

  test('a port that cannot be bound says why automatic completion is unavailable', async () => {
    const dir = makeProjectTempDir('subscription-listener');
    const port = await freePort();
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    const f = fixture({ confirmMutations: false, dir, port, manager: {
      beginOAuthLogin: async () => ({ pending: { state: 's' }, authorizationUrl: 'https://acme.invalid/auth?x=1' }),
    } });
    await f.run('login', 'acme', 'start', '--no-browser', '--yes');
    const out = f.printed.join('\n');
    expect(out).toContain('automatic completion unavailable');
    expect(out).toContain('finish <code-or-url>');
  });
});

describe('login finish with a pasted address', () => {
  const port = 0;
  test('a provider error redirect is reported and no exchange happens', async () => {
    const f = fixture({ confirmMutations: false, dir: makeProjectTempDir('subscription-finish'), port });
    await f.run('login', 'acme', 'finish', 'http://127.0.0.1/cb?error=access_denied&state=expected-state', '--yes');
    expect(f.printed.join('\n')).toContain('access_denied');
    expect(f.exchanged).toEqual([]);
  });
  test('a redirect from a different login attempt is rejected', async () => {
    const f = fixture({ confirmMutations: false, dir: makeProjectTempDir('subscription-finish'), port });
    await f.run('login', 'acme', 'finish', 'http://127.0.0.1/cb?code=abc&state=other', '--yes');
    expect(f.printed.join('\n')).toContain('state mismatch');
    expect(f.exchanged).toEqual([]);
  });
  test('a matching redirect and a bare code both exchange the code', async () => {
    const f = fixture({ confirmMutations: false, dir: makeProjectTempDir('subscription-finish'), port });
    await f.run('login', 'acme', 'finish', 'http://127.0.0.1/cb?code=from-url&state=expected-state', '--yes');
    await f.run('login', 'acme', 'finish', 'bare-code', '--yes');
    expect(f.exchanged).toEqual(['from-url', 'bare-code']);
  });
});
