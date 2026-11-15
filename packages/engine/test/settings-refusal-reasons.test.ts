/**
 * A settings owner's refusal names a value-free reason (stale, spent, managed,
 * read-only, owner-fault) so a caller can choose between recapturing and stopping.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsPreconditionHandler, settingsRefusalReason } from '../daemon-api/src/settings-precondition.js';
import { applyRemoteSettingsPrecondition, captureRemoteSettingsPrecondition } from '../platform/src/platform/config/settings-precondition-client.js';
import { SettingsRefusalError } from '../platform/src/platform/config/settings-refusal.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { preparedMutationLifecycle } from '../platform/src/platform/config/prepared-mutation.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const withReason = (reason: string) => Object.assign(new Error('owner refused'), { refusalReason: reason });

function service(hooks: { prepare?: () => void; assert?: () => void } = {}) {
  const lifetime = {};
  const owner = {
    prepare: (request: { key: string; value?: unknown }) => { hooks.prepare?.(); return { key: request.key, value: Number(request.value) }; },
    inspect: (handle: { key: string; value: number }) => ({ operation: 'set' as const, key: handle.key, value: handle.value,
      destinations: [{ path: '/synthetic/settings.json', operation: 'set' as const, tier: 'daemon' }], incarnation: 0 }),
    assert: () => { hooks.assert?.(); },
    begin: () => ({}), assertTransition: () => {},
    finish: () => ({ status: 'committed' as const, completedPaths: ['/synthetic/settings.json'], verifiedInOwningStore: true }),
  };
  const handler = createSettingsPreconditionHandler({ owner, lifetime: () => lifetime, captureAuthority: () => ({}),
    withAuthority: (_req, _authority, callback) => callback(() => {}) });
  const post = async (body: unknown) => handler.handle(new Request('http://synthetic.invalid/config', { method: 'POST' }), body as Record<string, unknown>, lifetime);
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => post(JSON.parse(String(init?.body)))) as typeof fetch;
  return { post, fetchImpl, endpoint: { baseUrl: 'http://synthetic.invalid', source: 'test' } };
}
const capture = (f: ReturnType<typeof service>) => captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 42 }, { fetchImpl: f.fetchImpl });

describe('wire reasons', () => {
  test('a write sent with a revision the settings moved past is refused as stale', async () => {
    const f = service();
    const write = (ifIncarnation: number) => f.post({ settingsPrecondition: { version: 1, action: 'write', operation: 'set', key: 'controlPlane.port', value: 42, ifIncarnation } });
    expect((await write(0)).status).toBe(200);
    expect(await (await write(7)).json()).toMatchObject({ code: 'SETTINGS_PRECONDITION_STALE', reason: 'stale', currentIncarnation: 0 });
  });

  test('a capture refused by a managed owner tells the caller to stop, not recapture', async () => {
    const f = service({ prepare: () => { throw withReason('managed'); } });
    const failure = await capture(f).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SettingsRefusalError);
    expect((failure as SettingsRefusalError).reason).toBe('managed');
    expect((failure as Error).message).toContain('Do not retry');
  });

  test('an apply refused before any effect reports its reason on the receipt', async () => {
    let refuse = false;
    const f = service({ assert: () => { if (refuse) throw withReason('read-only'); } });
    const handle = await capture(f);
    refuse = true;
    expect(await applyRemoteSettingsPrecondition(handle)).toMatchObject({ status: 'unknown', completedPaths: [], refused: true, refusalReason: 'read-only' });
  });

  test('only the known reasons are carried; anything else is unclassified', () => {
    expect(settingsRefusalReason(withReason('owner-fault'))).toBe('owner-fault');
    expect(settingsRefusalReason(withReason('surprising'))).toBeUndefined();
    expect(settingsRefusalReason(new Error('plain'))).toBeUndefined();
    expect(settingsRefusalReason(Object.assign(new Error('faulted'), { code: 'PAIRING_STORE_FAULTED' }))).toBe('owner-fault');
  });
});

describe('real configuration owner reasons', () => {
  const open = (readOnly = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-refusal-reasons-')); dirs.push(dir);
    return new ConfigManager({ configDir: join(dir, 'config'), surfaceRoot: 'daemon', ...(readOnly ? { readOnly } : {}) });
  };
  const request = { operation: 'set', key: 'controlPlane.port', value: 4567 } as const;

  test('a read-only owner refuses as read-only', () => {
    expect(settingsRefusalReason(captureFailure(() => open(true).prepareSettingMutation(request)))).toBe('read-only');
  });

  test('a prepared change that changed under it is stale, and a used one is spent with the legal moves named', () => {
    const manager = open();
    const prepared = manager.prepareSettingMutation(request);
    manager.set('controlPlane.port', 4568);
    const stale = captureFailure(() => manager.assertPreparedMutation(prepared));
    expect(settingsRefusalReason(stale)).toBe('stale');

    const fresh = manager.prepareSettingMutation(request);
    const transition = manager.beginPreparedMutation(fresh);
    manager.finishPreparedMutation(fresh, transition);
    const spent = captureFailure(() => manager.beginPreparedMutation(fresh));
    expect(settingsRefusalReason(spent)).toBe('spent');
  });

  test('the lifecycle refuses a re-entered finish naming the phase and what it can become', () => {
    const check = preparedMutationLifecycle.check('committing', 'committing');
    expect(check.ok).toBe(false);
    if (!check.ok) { expect(check.reason).toContain('committing'); expect(check.allowed).toEqual(['spent']); }
    expect(preparedMutationLifecycle.can('prepared', 'begun')).toBe(true); // a compound plan's step
    expect(preparedMutationLifecycle.isTerminal('spent')).toBe(true);
  });
});

function captureFailure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a refusal');
}
