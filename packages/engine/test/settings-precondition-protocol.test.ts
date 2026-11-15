/** Source-only synthetic HTTP protocol tests: no socket, model or real credential. */
import { expect, test } from 'bun:test';
import { createDaemonSystemRouteHandlers } from '../daemon-api/src/system-routes.js';
import { createSettingsPreconditionHandler } from '../daemon-api/src/settings-precondition.js';
import { captureRemoteSettingsPrecondition, applyRemoteSettingsPrecondition } from '../platform/src/platform/config/settings-precondition-client.js';

const envelope = (body: Record<string, unknown>) => ({ settingsPrecondition: { version: 1, ...body } });
function fixture() {
  let lifetime: object | null = {};
  let generation = 0;
  let admin = true;
  let authority = {};
  let value: unknown = 1;
  let effects = 0;
  let legacyEffects = 0;
  let beginHook = () => {};
  let parseHook = async () => {};
  const owner = {
    prepare(request: { operation: 'set' | 'reset-default'; key: string; value?: unknown }) {
      if (request.key !== 'controlPlane.port') throw new Error('Invalid key');
      return { generation, value: request.operation === 'reset-default' ? 3421 : Number(request.value), operation: request.operation, key: request.key };
    },
    inspect(handle: { generation: number; value: number; operation: 'set' | 'reset-default'; key: string }) {
      return { operation: handle.operation, key: handle.key, value: handle.value,
        destinations: [{ path: '/synthetic/settings.json', operation: 'set' as const, tier: 'daemon' }], incarnation: handle.generation };
    },
    assert(handle: { generation: number }) { if (handle.generation !== generation) throw new Error('stale owner'); },
    begin(handle: { generation: number }) { owner.assert(handle); generation++; const transition = { generation }; beginHook(); return transition; },
    assertTransition(_handle: unknown, transition: { generation: number }) { if (transition.generation !== generation) throw new Error('stale transition'); },
    finish(handle: { value: number }, transition: { generation: number }) {
      owner.assertTransition(handle, transition); value = handle.value; effects++;
      return { status: 'committed' as const, completedPaths: ['/synthetic/settings.json'], verifiedInOwningStore: true };
    },
  };
  // Like the daemon's settings authority: the credential and the serving lifetime it was taken under.
  const service = createSettingsPreconditionHandler({ owner, lifetime: () => lifetime,
    captureAuthority: () => admin && lifetime ? { authority, lifetime } : null,
    withAuthority: (_req, captured, callback) => {
      const check = () => { if (!admin || authority !== captured.authority || lifetime !== captured.lifetime) throw new Error('stale auth'); };
      check(); return callback(check);
    },
  });
  const handlers = createDaemonSystemRouteHandlers({ settingsPrecondition: service,
    requireAdmin: () => admin ? null : Response.json({ error: 'admin' }, { status: 403 }),
    parseJsonBody: async (req: Request) => { const body = await req.json(); await parseHook(); return body; },
    isValidConfigKey: (key: string) => key === 'controlPlane.port',
    configManager: { get: () => value, setDynamic: (_key: string, next: unknown) => { value = next; legacyEffects++; }, getAll: () => ({}) },
  } as never);
  const post = (body: unknown) => handlers.postConfig(new Request('http://synthetic.invalid/config', { method: 'POST', body: JSON.stringify(body) }));
  const write = (fields: Record<string, unknown> = {}) => post(envelope({ action: 'write', operation: 'set', key: 'controlPlane.port', value: '42', ...fields }));
  return { post, write, effects: () => effects, legacyEffects: () => legacyEffects, value: () => value, incarnation: () => generation,
    rotate: () => { lifetime = {}; }, stop: () => { lifetime = null; }, revoke: () => { admin = false; },
    replaceAuth: () => { authority = {}; }, mutate: () => { generation++; },
    onBegin: (callback: () => void) => { beginHook = callback; }, onParse: (callback: () => Promise<void>) => { parseHook = callback; } };
}

test('a capture writes nothing; one write with the read revision writes the owner value once and answers facts and receipt', async () => {
  const f = fixture();
  const captured = await (await f.post(envelope({ action: 'capture', operation: 'set', key: 'controlPlane.port', value: '42' }))).json();
  expect(captured.settingsPrecondition.facts).toMatchObject({ value: 42, incarnation: 0 }); expect(f.effects()).toBe(0);
  const written = await f.write({ ifIncarnation: captured.settingsPrecondition.facts.incarnation });
  expect(written.status).toBe(200);
  expect((await written.json()).settingsPrecondition).toMatchObject({ action: 'written', facts: { value: 42 }, receipt: { status: 'committed' } });
  expect(f.value()).toBe(42); expect(f.effects()).toBe(1);
});

test('a write whose revision moved is refused before any effect and names the current revision', async () => {
  const f = fixture(); f.mutate();
  const refused = await f.write({ ifIncarnation: 0 });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'SETTINGS_PRECONDITION_STALE', reason: 'stale', currentIncarnation: 1 });
  expect(f.effects()).toBe(0);
});

test('the same request id sent twice writes once and answers the first result', async () => {
  const f = fixture();
  const first = await (await f.write({ ifIncarnation: 0, requestId: 'r-1' })).json();
  const again = await (await f.write({ ifIncarnation: 0, requestId: 'r-1' })).json();
  expect(again).toEqual(first); expect(f.effects()).toBe(1);
  expect((await f.write({ operation: 'reset-default', value: undefined, requestId: 'r-1' })).status).toBe(400);
  expect(f.effects()).toBe(1);
});

test.each(['rotate', 'stop', 'revoke', 'replaceAuth', 'mutate'] as const)('%s during owner begin refuses before effect', async change => {
  const f = fixture(); f.onBegin(f[change]); expect((await f.write()).status).toBe(409); expect(f.effects()).toBe(0);
});
test.each(['rotate', 'stop', 'revoke'] as const)('%s during the body await refuses before effect', async change => {
  const f = fixture(); f.onParse(async () => { f[change](); }); expect((await f.write()).status).toBe(409); expect(f.effects()).toBe(0);
});

test('the plain key/value write stays accepted; a mixed envelope never falls back to it', async () => {
  const f = fixture(); expect((await f.post({ key: 'controlPlane.port', value: 7 })).status).toBe(200);
  for (const malformed of [null, {}, { version: 2, action: 'capture' }, { version: 1, action: 'write', key: 'controlPlane.port' }]) {
    expect((await f.post({ key: 'controlPlane.port', value: 9, settingsPrecondition: malformed })).status).toBe(400);
  }
  expect(f.legacyEffects()).toBe(1); expect(f.value()).toBe(7);
});

test('client: a lost answer is asked for again with the same request id and the change is written once', async () => {
  const f = fixture(); let calls = 0;
  const handle = await captureRemoteSettingsPrecondition({ baseUrl: 'http://synthetic.invalid', source: 'test' }, { operation: 'set', key: 'controlPlane.port', value: 42 }, {
    fetchImpl: (async (_url, init) => {
      calls++; const response = await f.post(JSON.parse(String(init?.body)));
      if (calls === 2) throw Object.assign(new Error('answer lost'), { name: 'TimeoutError' });
      return response;
    }) as typeof fetch,
  });
  expect(await applyRemoteSettingsPrecondition(handle)).toMatchObject({ status: 'committed', verifiedInOwningStore: true });
  expect(calls).toBe(3); expect(f.effects()).toBe(1);
  await expect(applyRemoteSettingsPrecondition(handle)).rejects.toThrow();
});

test('client: a write refused before any effect is reported as refused', async () => {
  const f = fixture();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => f.post(JSON.parse(String(init?.body)))) as typeof fetch;
  const stale = await captureRemoteSettingsPrecondition({ baseUrl: 'http://synthetic.invalid', source: 'test' }, { operation: 'set', key: 'controlPlane.port', value: 42 }, { fetchImpl });
  f.mutate();
  expect(await applyRemoteSettingsPrecondition(stale)).toMatchObject({ status: 'unknown', completedPaths: [], refused: true, refusalReason: 'stale' });
  expect(f.effects()).toBe(0);
});
