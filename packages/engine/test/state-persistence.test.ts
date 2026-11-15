import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonFileStore, JsonFileStoreParseError } from '../platform/src/platform/state/json-file-store.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { FileStateCache } from '../platform/src/platform/state/file-cache.ts';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { trackDisposables } from './_helpers/disposables.ts';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.ts';
import { AutomationJobStore } from '../platform/src/platform/automation/store/jobs.ts';
import { AutomationRunStore } from '../platform/src/platform/automation/store/runs.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import { AutomationSourceStore } from '../platform/src/platform/automation/store/sources.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { loadSessionBrokerState } from '../platform/src/platform/control-plane/session-broker-state.ts';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.ts';
import { rowToRecord } from '../platform/src/platform/state/memory-store-helpers.ts';
import { loadWatcherSnapshotFromPath } from '../platform/src/platform/watchers/store.ts';
import { createTeamTool } from '../platform/src/platform/tools/team/index.ts';
import { createWorklistTool } from '../platform/src/platform/tools/worklist/index.ts';

const disposables = trackDisposables();

/** A path under the temp directory, removed after the test that asked for it. */
function tempDir(label: string): string {
  const dir = join(tmpdir(), `gv-${label}-${randomUUID()}`);
  disposables.defer(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

describe('state persistence failures', () => {
  test('PersistentStore rejects invalid JSON instead of returning an empty store', async () => {
    const dir = tempDir('persistent-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    writeFileSync(file, '{bad', 'utf-8');

    await expect(new PersistentStore(file).load()).rejects.toThrow('PersistentStore failed to load');
  });

  test('JsonFileStore rejects invalid JSON instead of returning an empty store', async () => {
    const dir = tempDir('json-file-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    writeFileSync(file, '{bad', 'utf-8');

    await expect(new JsonFileStore(file).load()).rejects.toBeInstanceOf(JsonFileStoreParseError);
    expect(readFileSync(file, 'utf8')).toBe('{bad');
  });

  test('PersistentStore concurrent saves do not race on a shared tmp path', async () => {
    const dir = tempDir('persistent-store-concurrent');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const store = new PersistentStore<{ readonly value: string }>(file);

    await Promise.all([
      store.persist({ value: 'first' }),
      store.persist({ value: 'second' }),
      store.persist({ value: 'third' }),
    ]);

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(['first', 'second', 'third']).toContain(loaded!.value);
    expect(readdirSync(dir).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  test('JsonFileStore concurrent saves do not race on a shared tmp path', async () => {
    const dir = tempDir('json-file-store-concurrent');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const store = new JsonFileStore<{ readonly value: string }>(file);

    await Promise.all([
      store.save({ value: 'first' }),
      store.save({ value: 'second' }),
      store.save({ value: 'third' }),
    ]);

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.value).toBe('third');
    expect(readdirSync(dir).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  test('ProjectIndex rejects corrupt on-disk indexes instead of treating them as empty', async () => {
    const root = tempDir('project-index');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'project-index.json'), '{bad', 'utf-8');

    await expect(new ProjectIndex(root).load()).rejects.toThrow('ProjectIndex load failed');
  });

  test('FileStateCache compares the bytes a tool just read with what the session last saw', () => {
    const cache = new FileStateCache();
    const file = '/workspace/tracked.txt';
    expect(cache.compare(file, 'first\nsecond')).toBe('miss');
    cache.update(file, 'first\nsecond');
    expect(cache.compare(file, 'first\nsecond')).toBe('unchanged');
    expect(cache.compare(file, 'FIRST\nsecond')).toBe('modified');
    cache.invalidate(file);
    expect(cache.compare(file, 'FIRST\nsecond')).toBe('miss');
  });

  test('SQLiteStore throws on file-backed save failures', async () => {
    const dir = tempDir('sqlite-store-save');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'state.db');
    const store = new SQLiteStore(dbPath);
    await store.init((db) => {
      db.run('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY)');
    });
    mkdirSync(dbPath);

    await expect(store.save()).rejects.toThrow();
    store.close();
  });

  test('KVState rejects corrupt session files instead of starting a replacement session', async () => {
    const stateDir = tempDir('kv-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'session_1234abcd.json'), '{bad', 'utf-8');

    // load() starts a housekeeping interval before it rejects, so the instance
    // has to be reachable for teardown rather than constructed inline.
    const kv = disposables.add(new KVState({ stateDir, sessionId: '1234abcd' }));
    await expect(kv.load()).rejects.toBeInstanceOf(JsonFileStoreParseError);
    expect(readFileSync(join(stateDir, 'session_1234abcd.json'), 'utf8')).toBe('{bad');
  });

  test('KVState treats a corrupt LEGACY file as absent: the fallback may only recover data, never fail a clean session', async () => {
    // The legacy unscoped state dir is dual-read for one release. Before that
    // dual-read existed, junk sitting there was simply never opened and a new
    // session started clean; a corrupt legacy file must not now turn that
    // clean start into a hard failure.
    const stateDir = tempDir('kv-state-scoped');
    const legacyStateDir = tempDir('kv-state-legacy');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(legacyStateDir, { recursive: true });
    writeFileSync(join(legacyStateDir, 'session_1234abcd.json'), '{bad', 'utf-8');

    const kv = disposables.add(new KVState({ stateDir, legacyStateDir, sessionId: '1234abcd' }));
    await kv.load();
    const all = await kv.list();
    expect(all.id).toBe('1234abcd');
    expect(typeof all.started_at).toBe('string');
  });

  test('KVState still copies a READABLE legacy file forward', async () => {
    const stateDir = tempDir('kv-state-scoped-ok');
    const legacyStateDir = tempDir('kv-state-legacy-ok');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(legacyStateDir, { recursive: true });
    writeFileSync(
      join(legacyStateDir, 'session_1234abcd.json'),
      JSON.stringify({ id: '1234abcd', started_at: 'then', carried: 'forward' }),
      'utf-8',
    );

    const kv = new KVState({ stateDir, legacyStateDir, sessionId: '1234abcd' });
    expect(await kv.get(['carried'])).toEqual({ carried: 'forward' });
    await kv.dispose();
  });

  test('watcher snapshots quarantine malformed persisted state instead of crashing the caller', () => {
    // Watcher snapshots are a special case among this file's stores: a crash
    // parsing this one at daemon boot / on a periodic tick took the whole
    // daemon down twice in production (a host freeze zero-tailed the file).
    // The deliberate fix is the opposite of every other test in this
    // describe block, a corrupt file is quarantined (renamed aside with a
    // `.why` receipt, never deleted, never re-parsed) and treated exactly
    // like "no snapshot yet" so the caller rebuilds from live registrations,
    // instead of throwing and crash-looping the process. See
    // packages/platform/src/platform/watchers/store.ts.
    const dir = tempDir('watcher-store');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'watchers.json');
    writeFileSync(file, '{bad', 'utf-8');

    expect(loadWatcherSnapshotFromPath(file)).toBeNull();
    expect(existsSync(file)).toBe(false);
    const quarantined = readdirSync(dir).filter((name) => name.startsWith('watchers.json.corrupt-') && !name.endsWith('.why'));
    expect(quarantined.length).toBe(1);
    expect(existsSync(join(dir, `${quarantined[0]}.why`))).toBe(true);
  });

  test('worklist tool keeps malformed persisted state aside instead of overwriting it', async () => {
    const dir = tempDir('worklist-store');
    mkdirSync(join(dir, '.goodvibes'), { recursive: true });
    writeFileSync(join(dir, '.goodvibes', 'worklists.json'), '{bad', 'utf-8');

    const result = await createWorklistTool({ workingDirectory: dir }).execute({ mode: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('unreadable');
    const kept = readdirSync(join(dir, '.goodvibes')).filter((name) => name.startsWith('worklists.json.corrupt-') && !name.endsWith('.why'));
    expect(kept.length).toBe(1);
    // The owner's bytes survive untouched in the quarantined copy.
    expect(readFileSync(join(dir, '.goodvibes', kept[0]!), 'utf-8')).toBe('{bad');
  });

  test('team tool keeps malformed persisted state aside instead of overwriting it', async () => {
    const dir = tempDir('team-store');
    mkdirSync(join(dir, '.goodvibes'), { recursive: true });
    writeFileSync(join(dir, '.goodvibes', 'teams.json'), '{bad', 'utf-8');

    const result = await createTeamTool({ workingDirectory: dir }).execute({ mode: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('unreadable');
    const kept = readdirSync(join(dir, '.goodvibes')).filter((name) => name.startsWith('teams.json.corrupt-') && !name.endsWith('.why'));
    expect(kept.length).toBe(1);
    // The owner's bytes survive untouched in the quarantined copy.
    expect(readFileSync(join(dir, '.goodvibes', kept[0]!), 'utf-8')).toBe('{bad');
  });

  test('automation stores reject malformed snapshots instead of resetting collections', async () => {
    const dir = tempDir('automation-store');
    mkdirSync(dir, { recursive: true });

    const jobs = join(dir, 'jobs.json');
    const runs = join(dir, 'runs.json');
    const routes = join(dir, 'routes.json');
    const sources = join(dir, 'sources.json');
    writeFileSync(jobs, JSON.stringify({ version: 1, jobs: {} }), 'utf-8');
    writeFileSync(runs, JSON.stringify({ version: 1, runs: {} }), 'utf-8');
    writeFileSync(routes, JSON.stringify({ version: 1, routes: {} }), 'utf-8');
    writeFileSync(sources, JSON.stringify({ version: 1, sources: {} }), 'utf-8');

    await expect(new AutomationJobStore(jobs).load()).rejects.toThrow('Automation jobs store snapshot is invalid');
    await expect(new AutomationRunStore(runs).load()).rejects.toThrow('Automation runs store snapshot is invalid');
    await expect(new AutomationRouteStore(routes).load()).rejects.toThrow('Automation routes store snapshot is invalid');
    await expect(new AutomationSourceStore(sources).load()).rejects.toThrow('Automation sources store snapshot is invalid');
  });

  test('control-plane, channel, and distributed stores reject malformed records', async () => {
    const dir = tempDir('control-records');
    mkdirSync(dir, { recursive: true });

    const approvals = join(dir, 'approvals.json');
    writeFileSync(approvals, JSON.stringify({ approvals: [{ id: 'approval-1', status: 'pending' }] }), 'utf-8');
    await expect(new ApprovalBroker({ storePath: approvals }).start()).rejects.toThrow('cannot be read');

    expect(() => loadSessionBrokerState({
      sessions: [{ id: 'sess-1' }],
      messages: [],
      inputs: [],
    } as never)).toThrow('Shared session store snapshot is invalid');

    const policies = join(dir, 'policies.json');
    writeFileSync(policies, JSON.stringify({
      policies: [{ surface: 'slack', groupPolicies: [{}] }],
      audit: [],
    }), 'utf-8');
    await expect(new ChannelPolicyManager({ storePath: policies }).start()).rejects.toThrow('Channel policy store snapshot is invalid');

    const distributed = join(dir, 'distributed.json');
    writeFileSync(distributed, JSON.stringify({
      pairRequests: [],
      peers: [{
        id: 'peer-1',
        kind: 'node',
        label: 'Node',
        tokens: [{ id: 'token-1' }],
      }],
      work: [],
      audit: [],
    }), 'utf-8');
    await expect(new DistributedRuntimeManager(distributed).start()).rejects.toThrow('Distributed runtime store snapshot is invalid');
  });

  test('memory row parser rejects corrupt persisted JSON fields instead of clearing them', () => {
    const now = Date.now();
    const columns = [
      'id',
      'scope',
      'cls',
      'summary',
      'detail',
      'tags',
      'provenance',
      'review_state',
      'confidence',
      'reviewed_at',
      'reviewed_by',
      'stale_reason',
      'created_at',
      'updated_at',
    ];
    const values = [
      'mem-bad',
      'project',
      'fact',
      'bad persisted row',
      null,
      '{bad',
      '[]',
      'fresh',
      60,
      null,
      null,
      null,
      now,
      now,
    ];

    expect(() => rowToRecord(columns, values)).toThrow(/tags.*invalid.*JSON/);
  });
});
