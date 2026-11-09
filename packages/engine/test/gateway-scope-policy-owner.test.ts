import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { GatewayMethodCatalog, grantedGatewayScopes, type GatewayMethodDescriptor } from '../sdk/src/platform/control-plane/method-catalog.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const method = (id = 'synthetic.write', scopes = ['write:synthetic']): GatewayMethodDescriptor => ({
  id, title: 'Synthetic method', description: 'Synthetic scope fixture', category: 'fixture', source: 'plugin', pluginId: 'synthetic-plugin',
  access: 'admin', transport: ['http'], scopes, http: { method: 'POST', path: '/synthetic' },
});
const handler = () => ({ ok: true });

test('scope-only membership reads remain owned, immutable and current across registration changes', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false }); catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(() => {}), original = owner.grantedScopes();
  expect(original).toContain('write:synthetic'); expect(owner.grantedScopes()).toBe(original);
  expect(() => (original as string[]).push('write:forged')).toThrow();
  catalog.register(method('synthetic.second', ['write:second']), handler);
  expect(owner.grantedScopes()).toContain('write:second'); expect(owner.grantedScopes()).not.toBe(original);
  catalog.unregister('synthetic.write'); expect(owner.grantedScopes()).not.toContain('write:synthetic');
  owner.close(); expect(() => owner.grantedScopes()).toThrow('unavailable');
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-catalog-owner-')); dirs.push(dir);
  const options = { configDir: dir, surfaceRoot: 'daemon' };
  const config = new ConfigManager(options); const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  const remove = catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(() => config.invalidateExternalPolicy());
  const revision = () => JSON.stringify([config.getDurableConfigurationIncarnation(), owner.current().revision]);
  const capture = () => { config.captureDurableConfigurationIncarnation(); return revision(); };
  return { dir, options, config, catalog, owner, remove, capture, revision };
}

test('initial catalog construction and unchanged restart preserve durable scope ownership', () => {
  const f = fixture(); const before = f.capture(); const disk = readFileSync(`${f.config.getConfigPath()}.policy-epoch.json`, 'utf8');
  const nextConfig = new ConfigManager(f.options); const nextCatalog = new GatewayMethodCatalog({ includeBuiltins: false });
  nextCatalog.register(method(), handler);
  const nextOwner = nextCatalog.attachScopePolicyOwner(() => nextConfig.invalidateExternalPolicy());
  const after = JSON.stringify([nextConfig.getDurableConfigurationIncarnation(), nextOwner.current().revision]);
  expect(after).toBe(before);
  expect(readFileSync(`${f.config.getConfigPath()}.policy-epoch.json`, 'utf8')).toBe(disk);
});

test('unchanged guards reuse one immutable scope snapshot and actual replacement invalidates it even with identical scope bytes', () => {
  const f = fixture(); f.capture();
  const first = f.owner.current(), previousPolicy = f.config.getDurableConfigurationIncarnation();
  const reads = spyOn(f.catalog, 'getAllScopes');
  try {
    for (let i = 0; i < 500; i++) expect(f.owner.current()).toBe(first);
    expect(reads).not.toHaveBeenCalled();
    expect(() => (first.scopes as string[]).push('write:forged')).toThrow();
    f.catalog.register(method(), () => ({ replacement: true }), { replace: true });
    const next = f.owner.current();
    expect(next).not.toBe(first); expect(next.revision).toBe(first.revision); expect(next.scopes).toEqual(first.scopes);
    expect(f.config.getDurableConfigurationIncarnation()).not.toBe(previousPolicy);
    expect(reads).toHaveBeenCalledTimes(1); expect(f.owner.current()).toBe(next);
    f.remove(); expect(f.owner.current()).toBe(next);
  } finally { reads.mockRestore(); }
});

test('method/event registration and removal refresh snapshots while rejected and absent mutations retain the current state', () => {
  const f = fixture(); const first = f.owner.current();
  expect(f.catalog.unregister('absent')).toBe(false); expect(f.catalog.unregisterEvent('absent')).toBe(false);
  f.catalog.clearPluginMethods('absent'); expect(f.owner.current()).toBe(first);
  expect(() => f.catalog.register(method(), handler)).toThrow(); expect(f.owner.current()).toBe(first);
  const remove = f.catalog.registerEvent({ id: 'synthetic.event', title: 'Fixture', description: 'Fixture', category: 'fixture', source: 'plugin',
    pluginId: 'synthetic-plugin', transport: ['ws'], scopes: ['read:synthetic-event'] });
  const event = f.owner.current(); expect(event).not.toBe(first); expect(event.scopes).toContain('read:synthetic-event');
  remove(); const removed = f.owner.current(); expect(removed).not.toBe(event); expect(removed.revision).toBe(first.revision);
  expect(removed.scopes).not.toContain('read:synthetic-event');
  f.catalog.clearPluginMethods('synthetic-plugin'); const cleared = f.owner.current();
  expect(cleared).not.toBe(removed); expect(cleared.scopes).not.toContain('write:synthetic');
  expect(f.owner.current()).toBe(cleared);
});

test('cached snapshots never bypass mutation-in-progress or retirement checks', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false }); catalog.register(method(), handler);
  let duringMutation: (() => void) | undefined;
  const owner = catalog.attachScopePolicyOwner(() => duringMutation?.()), first = owner.current();
  duringMutation = () => { expect(() => owner.current()).toThrow('unavailable'); };
  catalog.register(method('synthetic.second'), handler); expect(owner.current()).not.toBe(first);
  duringMutation = () => { throw new Error('Mutation refused'); };
  const current = owner.current(); expect(() => catalog.unregister('synthetic.second')).toThrow('Mutation refused');
  expect(owner.current()).toBe(current); expect(catalog.get('synthetic.second')).not.toBeNull();
  owner.close(); expect(() => owner.current()).toThrow('unavailable');
  expect(() => catalog.attachScopePolicyOwner(() => {})).toThrow('retired');
});

test('a read that reenters registration cannot publish a mixed old/new catalog snapshot', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false }); catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(() => {}), read = catalog.getAllScopes.bind(catalog);
  const reentrant = spyOn(catalog, 'getAllScopes').mockImplementationOnce(options => {
    catalog.register(method('synthetic.added', ['write:added']), handler);
    return read(options);
  });
  try { expect(() => owner.current()).toThrow('changed while reading'); }
  finally { reentrant.mockRestore(); }
  const after = owner.current(); expect(after.scopes).toContain('write:added'); expect(owner.current()).toBe(after);
});

test('removal and re-addition cannot revive a durable grant across restart', () => {
  const f = fixture(); const before = f.capture(); const catalogBefore = f.owner.current().revision;
  f.catalog.unregister('synthetic.write'); f.catalog.register(method(), handler);
  expect(f.owner.current().revision).toBe(catalogBefore); expect(f.revision()).not.toBe(before);
  const restarted = new ConfigManager(f.options);
  expect(restarted.getDurableConfigurationIncarnation()).toBe(f.config.getDurableConfigurationIncarnation());
  expect(JSON.stringify([restarted.getDurableConfigurationIncarnation(), catalogBefore])).not.toBe(before);
});

test('same-name source replacement revokes even when its scope union is unchanged', () => {
  const f = fixture(); const before = f.capture(); const scopes = f.owner.current().scopes;
  f.catalog.register({ ...method(), pluginId: 'replacement-plugin' }, handler, { replace: true });
  expect(f.owner.current().scopes).toEqual(scopes); expect(f.revision()).not.toBe(before);
});

test('old registration teardown cannot remove or invalidate a successor with the same source metadata', () => {
  const f = fixture(); f.capture(); const removeSuccessor = f.catalog.register(method(), handler, { replace: true });
  const current = f.revision(); f.remove();
  expect(f.catalog.get('synthetic.write')).not.toBeNull(); expect(f.revision()).toBe(current);
  removeSuccessor(); expect(f.catalog.get('synthetic.write')).toBeNull(); expect(f.revision()).not.toBe(current);
});

test('plugin cleanup owns method and event scope removal in one pre-effect transition', () => {
  const f = fixture();
  f.catalog.registerEvent({ id: 'synthetic.event', title: 'Fixture', description: 'Fixture', category: 'fixture', source: 'plugin',
    pluginId: 'synthetic-plugin', transport: ['ws'], scopes: ['read:synthetic-event'] });
  f.capture(); const before = f.config.getConfigurationIncarnation();
  f.catalog.clearPluginMethods('synthetic-plugin');
  expect(f.config.getConfigurationIncarnation()).toBe(before + 1);
  expect(f.catalog.get('synthetic.write')).toBeNull(); expect(f.catalog.getEvent('synthetic.event')).toBeNull();
  expect(f.owner.current().scopes).not.toContain('write:synthetic'); expect(f.owner.current().scopes).not.toContain('read:synthetic-event');
});

test('returned descriptors and borrowed input arrays cannot bypass scope mutation ownership', () => {
  const f = fixture(); const scopes = ['write:one']; const input = method('synthetic.mutable', scopes);
  f.catalog.register(input, handler); const before = f.capture(); scopes.push('write:unrequested');
  expect(() => (f.catalog.get(input.id)!.scopes as string[]).push('write:forged')).toThrow();
  expect(() => { (f.catalog.get(input.id)! as { access: string }).access = 'public'; }).toThrow();
  expect(() => { (f.catalog.get(input.id)!.http! as { path: string }).path = '/unowned'; }).toThrow();
  expect(f.revision()).toBe(before); expect(f.owner.current().scopes).not.toContain('write:unrequested');
});

test('clean retirement preserves durable history and older graph teardown cannot invalidate a successor graph', () => {
  const f = fixture(); f.capture(); const before = f.config.getDurableConfigurationIncarnation();
  const successorCatalog = new GatewayMethodCatalog({ includeBuiltins: false }); successorCatalog.register(method(), handler);
  const successor = successorCatalog.attachScopePolicyOwner(() => f.config.invalidateExternalPolicy());
  f.owner.close(); f.remove(); f.owner.close();
  expect(() => f.owner.current()).toThrow(); expect(f.config.getDurableConfigurationIncarnation()).toBe(before);
  expect(() => f.catalog.attachScopePolicyOwner(() => f.config.invalidateExternalPolicy())).toThrow('retired');
  expect(successor.current().scopes).toContain('write:synthetic');
  expect(new ConfigManager(f.options).getDurableConfigurationIncarnation()).toBe(before);
});

test('failed durable scope mutation never changes the registered source or allows stale live ownership', () => {
  const f = fixture(); f.capture();
  const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic scope persistence failure'); });
  try { expect(() => f.catalog.unregister('synthetic.write')).toThrow(); } finally { write.mockRestore(); }
  expect(f.catalog.get('synthetic.write')).not.toBeNull(); expect(() => f.config.getDurableConfigurationIncarnation()).toThrow();
});

test('ambiguous owner lock prevents scope mutation before effects', () => {
  const f = fixture(); f.capture(); mkdirSync(`${f.config.getConfigPath()}.policy-epoch.json.owner-lock`);
  expect(() => f.catalog.register(method('synthetic.other'), handler)).toThrow();
  expect(f.catalog.get('synthetic.other')).toBeNull();
});

test('async and reentrant mutation preconditions cannot change scope state', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(() => { catalog.unregister('synthetic.write'); });
  expect(() => catalog.register(method('synthetic.other'), handler)).toThrow('reentrant');
  expect(catalog.get('synthetic.write')).not.toBeNull(); expect(catalog.get('synthetic.other')).toBeNull();
  expect(() => owner.current()).not.toThrow();
  const asyncCatalog = new GatewayMethodCatalog({ includeBuiltins: false });
  asyncCatalog.attachScopePolicyOwner((async () => {}) as () => void);
  expect(() => asyncCatalog.register(method(), handler)).toThrow('synchronous'); expect(asyncCatalog.get('synthetic.write')).toBeNull();
});

test('ordinary catalog behavior needs no durable configuration and granted-scope utility preserves transport ceiling', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false }); catalog.register(method(), handler);
  expect(grantedGatewayScopes(catalog, false)).toEqual(['read:control-plane', 'read:events', 'read:telemetry']);
  expect(grantedGatewayScopes(catalog, true)).toEqual(['read:control-plane', 'read:events', 'read:telemetry', 'read:telemetry-sensitive', 'write:control-plane', 'write:synthetic']);
  expect(catalog.unregister('synthetic.write')).toBe(true);
});

// Regression source: execution is deferred until the coding phase is complete.
test('rejected asynchronous scope preconditions are drained without changing the registered catalog', async () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(async () => { throw new Error('synthetic failed scope precondition'); });
  const original = owner.current(), unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', observe);
  try {
    expect(() => catalog.unregister('synthetic.write')).toThrow('synchronous');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(catalog.get('synthetic.write')).not.toBeNull();
    expect(owner.current()).toBe(original);
  } finally { process.off('unhandledRejection', observe); owner.close(); }
});
