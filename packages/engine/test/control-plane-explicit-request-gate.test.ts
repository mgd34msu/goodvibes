/** The untrusted-content window is reset only by a person's call that was actually admitted. */
import { expect, spyOn, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { getProcessUntrustedContentLedger, withUntrustedContentScope } from '../platform/src/platform/security/untrusted-content.ts';

type Kind = 'user' | 'bot' | 'token';
function setup(handler: () => Promise<unknown> = async () => ({ ok: true })) {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register({ id: 'test.write', title: 'test', description: 'test', category: 'test', source: 'builtin', access: 'authenticated', transport: ['ws'], scopes: ['write:test'] },
    async invocation => { seen.push(invocation.context.metadata?.explicitUserRequest); return handler(); });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
  const principal = (kind: Kind, scopes: string[]) => spyOn(helper, 'describeAuthenticatedPrincipal')
    .mockReturnValue({ principalId: `${kind}-1`, principalKind: kind, admin: false, scopes });
  const call = (kind: Kind, methodId = 'test.write') => helper.invokeGatewayMethodCall({ authToken: 't', methodId, body: {},
    context: { principalId: `${kind}-1`, principalKind: kind, scopes: ['write:test'], explicitUserRequest: true } });
  return { helper, principal, call };
}
const seen: unknown[] = [];
const exposure = () => {
  const ledger = getProcessUntrustedContentLedger();
  ledger.record({ surface: 'web' as never, origin: 'https://stranger.example', at: new Date().toISOString(), content: 'stranger text' });
  return ledger;
};

test('an unknown method, a refused scope and a bot do not clear what strangers left in the window', async () => {
  const ledger = exposure();
  const before = ledger.ingestedThisTurn().length;
  expect(before).toBeGreaterThan(0);
  const { principal, call } = setup();
  principal('user', ['read:test']);
  expect((await call('user', 'does.not.exist')).status).toBe(404);
  expect((await call('user')).status).toBe(403);
  principal('bot', ['write:test']);
  expect((await call('bot')).status).toBe(200);
  expect(ledger.ingestedThisTurn()).toHaveLength(before);
  expect(seen.at(-1)).toBeUndefined();
});

test('an admitted call from a person starts a new window and carries the claim to the handler', async () => {
  const ledger = exposure();
  const { principal, call } = setup();
  principal('user', ['write:test']);
  expect((await call('user')).status).toBe(200);
  expect(withUntrustedContentScope('principal:user-1', () => ledger.ingestedThisTurn())).toHaveLength(0);
  // The window that ended is that person's; another principal's session still has what it read.
  expect(withUntrustedContentScope('principal:user-2', () => ledger.ingestedThisTurn()).length).toBeGreaterThan(0);
  expect(seen.at(-1)).toBe(true);
});

test('a handler error body does not carry a credential from the error message', async () => {
  const { principal, call } = setup(async () => { throw new Error('upstream refused https://api.example/v1?api_key=sk-ant-api03-SECRETSECRETSECRET with Bearer abcdef0123456789abcdef0123456789'); });
  principal('user', ['write:test']);
  const result = await call('user');
  expect(result.status).toBe(500);
  const text = JSON.stringify(result.body);
  expect(text).not.toContain('SECRETSECRETSECRET');
  expect(text).not.toContain('abcdef0123456789abcdef0123456789');
});

test('a call over the shared operator token cannot claim a person asked, a paired device can', async () => {
  const ledger = exposure();
  const before = ledger.ingestedThisTurn().length;
  const { helper, call } = setup();
  const as = (principalId: string) => spyOn(helper, 'describeAuthenticatedPrincipal').mockReturnValue({ principalId, principalKind: 'token', admin: true, scopes: ['write:test'] });
  as('shared-token');
  const shared = await helper.invokeGatewayMethodCall({ authToken: 't', methodId: 'test.write', body: {}, context: { principalId: 'shared-token', principalKind: 'token', scopes: ['write:test'], explicitUserRequest: true } });
  expect(shared.status).toBe(200);
  expect(seen.at(-1)).toBeUndefined();
  expect(ledger.ingestedThisTurn()).toHaveLength(before);
  as('pairing:device-1');
  await helper.invokeGatewayMethodCall({ authToken: 't', methodId: 'test.write', body: {}, context: { principalId: 'pairing:device-1', principalKind: 'token', scopes: ['write:test'], explicitUserRequest: true } });
  expect(seen.at(-1)).toBe(true);
  void call;
});

test("one connection's fresh request does not end what another connection of the same principal read", async () => {
  const ledger = getProcessUntrustedContentLedger();
  let reading = true;
  const { principal, helper } = setup(async () => {
    if (reading) ledger.record({ surface: 'web' as never, origin: 'https://only-a.example', at: new Date().toISOString(), content: 'page read in session A' });
    return { ok: true };
  });
  principal('user', ['write:test']);
  const as = (connectionId: string, explicitUserRequest: boolean) => helper.invokeGatewayMethodCall({ authToken: 't', methodId: 'test.write', body: {},
    context: { principalId: 'user-1', principalKind: 'user', scopes: ['write:test'], explicitUserRequest, connectionId } });
  // Connection A reads a page through a real call, so it is recorded under the scope the daemon assigns.
  expect((await as('conn-a', false)).status).toBe(200);
  reading = false;
  expect((await as('conn-b', true)).status).toBe(200);
  const origins = async (connectionId: string) => {
    let seenOrigins: readonly string[] = [];
    const quiet = setup(async () => { seenOrigins = ledger.originsThisTurn(); return { ok: true }; });
    spyOn(quiet.helper, 'describeAuthenticatedPrincipal').mockReturnValue({ principalId: 'user-1', principalKind: 'user', admin: false, scopes: ['write:test'] });
    await quiet.helper.invokeGatewayMethodCall({ authToken: 't', methodId: 'test.write', body: {},
      context: { principalId: 'user-1', principalKind: 'user', scopes: ['write:test'], explicitUserRequest: false, connectionId } });
    return seenOrigins;
  };
  expect(await origins('conn-a')).toContain('https://only-a.example');
  expect(await origins('conn-b')).not.toContain('https://only-a.example');
});

test("what a principal read over a call with no connection stays visible to its connections", async () => {
  const ledger = getProcessUntrustedContentLedger();
  withUntrustedContentScope('principal:user-9', () => ledger.record({ surface: 'web' as never, origin: 'https://over-http.example', at: new Date().toISOString(), content: 'page read over http' }));
  expect(withUntrustedContentScope('principal:user-9:connection:c1', () => ledger.originsThisTurn())).toContain('https://over-http.example');
  expect(withUntrustedContentScope('principal:user-90:connection:c1', () => ledger.originsThisTurn())).not.toContain('https://over-http.example');
});

test('a handler error keeps its plain message in the 500 body', async () => {
  const { principal, call } = setup(async () => { throw new Error('database file is locked'); });
  principal('user', ['write:test']);
  const result = await call('user');
  expect(result.status).toBe(500);
  expect(JSON.stringify(result.body)).toContain('database file is locked');
});
