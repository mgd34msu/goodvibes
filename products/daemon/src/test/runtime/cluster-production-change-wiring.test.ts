/** UNRUN: actual daemon composition, ConfigManager and encrypted SecretsManager. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { FakeClusterClock, MemoryClusterBus, replicatedSecretKeyFor, type ClusterTransport } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { SecretsManager } from '../../config/secrets.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { createClusterGroupComposition, type ClusterGroupComposition } from '../../runtime/cluster-group-composition.js';
import type { ShellPathService } from '../../runtime/index.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const compositions: ClusterGroupComposition[] = [];
afterEach(async () => { for (const composition of compositions.splice(0).reverse()) await composition.stop(); });
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  do { if (await check()) return; await new Promise<void>(done => setImmediate(done)); } while (performance.now() < deadline);
  throw Error('Actual daemon replication did not reach the expected state');
}
function barrier() { return Promise.withResolvers<void>(); }
class ControlledSecrets extends SecretsManager {
  pauseRead: ((key: string) => Promise<void>) | undefined;
  override async get(key: string) { const value = await super.get(key); await this.pauseRead?.(key); return value; }
}
function fixture() { return { root: makeOwnedTempDir('cluster-production-changes'), bus: new MemoryClusterBus(), clock: new FakeClusterClock() }; }
function node(f: ReturnType<typeof fixture>, name: string, master: boolean, injected?: (transport: ClusterTransport) => ClusterTransport) {
  const root = join(f.root, name), work = join(root, 'work'), home = join(root, 'home'); mkdirSync(work, { recursive: true }); mkdirSync(home);
  const config = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT }); config.set('cluster.enabled', true);
  const secrets = new ControlledSecrets({ projectRoot: work, globalHome: home, daemonHome: home });
  const transport = f.bus.createTransport(name);
  const composition = createClusterGroupComposition({ configManager: config, secretsManager: secrets, isMaster: () => master,
    shellPaths: { resolveProjectPath: (...parts: string[]) => join(root, ...parts) } as ShellPathService,
    transport: injected?.(transport) ?? transport, clock: f.clock }); compositions.push(composition);
  return { root, config, secrets, composition, transport };
}
async function pair(f: ReturnType<typeof fixture>, beforeCreate?: (master: ReturnType<typeof node>) => Promise<void>) {
  const master = node(f, 'master', true), standby = node(f, 'standby', false);
  await beforeCreate?.(master); await master.composition.start(); await standby.composition.start();
  const created = await master.composition.verbs.create({ name: 'synthetic fixture group' }); if (!created.ok) throw Error(created.error);
  const joined = await standby.composition.verbs.join({ groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw Error(joined.error);
  return { master, standby };
}
const credentialPath = 'surfaces.telegram.botToken', credentialKey = replicatedSecretKeyFor(credentialPath);
function configTraffic(f: ReturnType<typeof fixture>) { return f.bus.sent.filter(row => String((JSON.parse(row.raw) as { type?: string }).type).startsWith('CONFIG_')); }
test('actual config UI writes and resets replicate without calling announcement helpers; user/node values remain local', async () => {
  const f = fixture(), { master, standby } = await pair(f);
  standby.config.set('automation.enabled', false); await waitFor(() => master.config.get('automation.enabled') === false);
  standby.config.reset('automation.enabled'); await waitFor(() => master.config.get('automation.enabled') === true);
  const localPort = master.config.get('controlPlane.port'); standby.config.set('controlPlane.port', localPort + 17); standby.config.set('display.showTokenSpeed', true);
  await new Promise<void>(done => setImmediate(done)); expect(master.config.get('controlPlane.port')).toBe(localPort); expect(master.config.get('display.showTokenSpeed')).toBe(false);
});
test('actual existing stored credential is seeded once, and later secret set/delete events follow the real daemon composition', async () => {
  const f = fixture(), { master, standby } = await pair(f, async owner => { await owner.secrets.set(credentialKey, 'synthetic-initial-group-credential'); });
  await waitFor(async () => await standby.secrets.get(credentialKey) === 'synthetic-initial-group-credential');
  await standby.secrets.set(credentialKey, 'synthetic-standby-credential'); await waitFor(async () => await master.secrets.get(credentialKey) === 'synthetic-standby-credential');
  await standby.secrets.delete(credentialKey); await waitFor(async () => await master.secrets.get(credentialKey) === null);
  expect(master.composition.runtime.replicaDocument()?.tombstones.some(entry => entry.path === credentialPath && entry.secret)).toBe(true);
  await master.secrets.set('OPENAI_API_KEY', 'synthetic-node-local-provider-credential'); await new Promise<void>(done => setImmediate(done)); expect(await standby.secrets.get('OPENAI_API_KEY')).toBeNull();
  const wire = f.bus.sent.map(row => row.raw).join('\n'); expect(wire).not.toContain('synthetic-initial-group-credential'); expect(wire).not.toContain('synthetic-standby-credential'); expect(wire).not.toContain('synthetic-node-local-provider-credential');
  const replica = readFileSync(join(master.root, GOODVIBES_DAEMON_SURFACE_ROOT, 'cluster', 'group-config.json'), 'utf8'); expect(replica).not.toContain('synthetic-initial-group-credential');
});
test('remote applies do not echo/revise forever and ordinary housekeeping does not re-read seeded credentials', async () => {
  const f = fixture(), { master, standby } = await pair(f); await master.secrets.set(credentialKey, 'synthetic-one-event'); await waitFor(async () => await standby.secrets.get(credentialKey) === 'synthetic-one-event');
  // Wait behind a final explicit config event, so earlier serial seed work has drained.
  master.config.set('automation.enabled', false); await waitFor(() => standby.config.get('automation.enabled') === false);
  await master.composition.runtime.runHousekeeping(); await waitFor(() => master.composition.runtime.replicationStatus()?.revision === standby.composition.runtime.replicationStatus()?.revision);
  const revision = master.composition.runtime.replicationStatus()?.revision, read = spyOn(master.secrets, 'get');
  try {
    await master.composition.runtime.runHousekeeping(); await standby.composition.runtime.runHousekeeping();
    await new Promise<void>(done => setImmediate(done)); await new Promise<void>(done => setImmediate(done));
    expect(read.mock.calls.filter(call => call[0] === credentialKey)).toHaveLength(0); expect(master.composition.runtime.replicationStatus()?.revision).toBe(revision);
  } finally { read.mockRestore(); }
});
test('standby explicit config re-add clears a prior group tombstone through the actual subscription', async () => {
  const f = fixture(), { master, standby } = await pair(f);
  await master.composition.runtime.announceConfigDelete('automation.enabled'); await waitFor(() => standby.composition.runtime.replicaDocument()?.tombstones.some(entry => entry.path === 'automation.enabled') ?? false);
  standby.config.set('automation.enabled', false); await waitFor(() => master.config.get('automation.enabled') === false);
  expect(master.composition.runtime.replicaDocument()?.tombstones.some(entry => entry.path === 'automation.enabled')).toBe(false);
});
test('stop unsubscribes immediately and drains an original paused secret read before any later publication', async () => {
  const f = fixture(), { master, standby } = await pair(f), entered = barrier(), release = barrier();
  await master.secrets.set(credentialKey, 'synthetic-prior'); await waitFor(async () => await standby.secrets.get(credentialKey) === 'synthetic-prior');
  master.secrets.pauseRead = async key => { if (key === credentialKey) { entered.resolve(); await release.promise; } };
  try {
    await master.secrets.set(credentialKey, 'synthetic-not-yet-admitted'); await entered.promise;
    let stopped = false; const stopping = master.composition.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    const at = configTraffic(f).length; master.config.set('automation.enabled', false);
    release.resolve(); await stopping; expect(configTraffic(f)).toHaveLength(at); expect(await standby.secrets.get(credentialKey)).toBe('synthetic-prior');
  } finally { master.secrets.pauseRead = undefined; release.resolve(); }
});
test('failed actual transport keeps a bounded original change for housekeeping retry', async () => {
  const f = fixture(); let fail = false;
  const master = node(f, 'master', true, inner => ({ start: callback => inner.start(callback), stop: () => inner.stop(), describe: () => inner.describe(), async send(raw) {
    if (fail && (JSON.parse(raw) as { type?: string }).type === 'CONFIG_DELTA') throw Error('synthetic transport unavailable'); await inner.send(raw);
  } })), standby = node(f, 'standby', false);
  await master.composition.start(); await standby.composition.start(); const created = await master.composition.verbs.create({}); if (!created.ok) throw Error(created.error);
  const joined = await standby.composition.verbs.join({ groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw Error(joined.error);
  fail = true; master.config.set('automation.enabled', false); await new Promise<void>(done => setImmediate(done));
  expect(standby.config.get('automation.enabled')).toBe(true); fail = false; await master.composition.runtime.runHousekeeping(); await waitFor(() => standby.config.get('automation.enabled') === false);
});
test('a literal credential in actual config is sealed, never public replica/log content, and still reaches a later cold peer', async () => {
  const f = fixture(), { master, standby } = await pair(f), literal = 'synthetic-literal-credential-must-never-be-public';
  const warned = spyOn(logger, 'warn'), informed = spyOn(logger, 'info');
  try {
  master.config.set(credentialPath, literal); await waitFor(async () => await standby.secrets.get(credentialKey) === literal);
  await master.composition.runtime.runHousekeeping();
  expect(master.composition.runtime.replicaDocument()?.entries.find(entry => entry.path === credentialPath)?.secret).toBe(true);
  const cold = node(f, 'cold', false); await cold.composition.start(); const key = master.composition.verbs.key(); if (!key.ok) throw Error(key.error);
  const joined = await cold.composition.verbs.join({ groupId: master.composition.runtime.groupState!.groupId, joinKey: key.data.joinKey }); if (!joined.ok) throw Error(joined.error);
  await waitFor(async () => await cold.secrets.get(credentialKey) === literal);
  expect(f.bus.sent.map(row => row.raw).join('\n')).not.toContain(literal);
  for (const selected of [master, standby, cold]) expect(readFileSync(join(selected.root, GOODVIBES_DAEMON_SURFACE_ROOT, 'cluster', 'group-config.json'), 'utf8')).not.toContain(literal);
  expect(standby.config.get(credentialPath)).toBe(`goodvibes://secrets/goodvibes/${encodeURIComponent(credentialKey)}`);
  expect(JSON.stringify(warned.mock.calls)).not.toContain(literal); expect(JSON.stringify(informed.mock.calls)).not.toContain(literal);
  } finally { warned.mockRestore(); informed.mockRestore(); }
});
test('an unrelated delta cannot repeat an unchanged historical delete over a genuine local credential re-add awaiting publication', async () => {
  const f = fixture(), { master, standby } = await pair(f), entered = barrier(), release = barrier();
  await master.secrets.set(credentialKey, 'synthetic-before-delete'); await waitFor(async () => await standby.secrets.get(credentialKey) === 'synthetic-before-delete');
  await standby.secrets.delete(credentialKey); await waitFor(async () => await master.secrets.get(credentialKey) === null);
  standby.secrets.pauseRead = async key => { if (key === credentialKey) { entered.resolve(); await release.promise; } };
  const deletion = spyOn(standby.secrets, 'delete');
  try {
    await standby.secrets.set(credentialKey, 'synthetic-local-readd'); await entered.promise;
    master.config.set('automation.enabled', false); await waitFor(() => standby.config.get('automation.enabled') === false);
    expect(deletion).not.toHaveBeenCalled(); release.resolve(); standby.secrets.pauseRead = undefined;
    await waitFor(async () => await master.secrets.get(credentialKey) === 'synthetic-local-readd');
  } finally { release.resolve(); standby.secrets.pauseRead = undefined; deletion.mockRestore(); }
});
