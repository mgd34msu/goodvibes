/**
 * On-disk stores publish through the shared atomic writer, whose staging file
 * is unique per call. A store that stages at a fixed `<file>.tmp` or
 * `<file>.<pid>.tmp` lets two writers (two instances, or the TUI, agent and
 * daemon on one home) rename each other's half-written file. Occupying those
 * old fixed names with directories makes such a store fail; a store using
 * the shared writer never touches them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.ts';
import { HookWorkbench } from '../platform/src/platform/hooks/workbench.ts';
import { persistProviders, loadPersistedProviders } from '../platform/src/platform/discovery/scanner.ts';
import { TailscaleServeReceiptStore } from '../platform/src/platform/remote-access/tailscale.ts';
import { foldLegacySpineStore } from '../platform/src/platform/runtime/session-spine/index.ts';
import { createSessionSurface } from '../platform/src/platform/runtime/session-surface.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { MemoryUsageStatsStore } from '../platform/src/platform/state/index.js';
import { WorkProposalStore } from '../platform/src/platform/agents/work-proposal-store.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-fixed-staging-'));
  roots.push(root);
  return root;
}

function occupyFixedStagingNames(file: string): void {
  mkdirSync(`${file}.tmp`);
  mkdirSync(`${file}.${process.pid}.tmp`);
}

describe('stores do not stage at a fixed name', () => {
  test('memory usage counters are saved and readable while the old fixed staging names are occupied', () => {
    const file = join(newRoot(), 'usage.json');
    occupyFixedStagingNames(file);
    new MemoryUsageStatsStore(file).recordInjected(['m1'], 5);
    expect(new MemoryUsageStatsStore(file).get('m1')).toMatchObject({ injectedCount: 1 });
    expect(statSync(`${file}.tmp`).isDirectory()).toBe(true);
    expect(readdirSync(join(file, '..')).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('work proposals are persisted while the old fixed staging name is occupied', async () => {
    const file = join(newRoot(), 'work-proposals.json');
    occupyFixedStagingNames(file);
    const store = new WorkProposalStore({ storePath: file });
    const record = store.create({ surfaceKind: 'ntfy', task: 'fix the login bug', summary: 'fix the login bug', ttlMs: 60_000 });
    await store.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { proposals: { id: string }[] };
    expect(saved.proposals.map((proposal) => proposal.id)).toEqual([record.id]);
    expect(readdirSync(join(file, '..')).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('the project index is saved while the old fixed staging names are occupied', async () => {
    const root = newRoot();
    const file = join(root, '.goodvibes', 'project-index.json');
    mkdirSync(dirname(file), { recursive: true });
    occupyFixedStagingNames(file);
    const index = new ProjectIndex(root);
    index.upsertFile('src/a.ts', 3);
    await index.forceFlush();
    await index.dispose();
    const reloaded = new ProjectIndex(root);
    await reloaded.load();
    expect(reloaded.getFiles().map((entry) => entry.path)).toEqual(['src/a.ts']);
    await reloaded.dispose();
  });

  test('two hook saves in one process both land while the old fixed staging name is occupied', async () => {
    const root = newRoot();
    const file = join(root, 'hooks.json');
    mkdirSync(`${file}.${process.pid}.tmp`);
    const workbench = new HookWorkbench(new HookDispatcher(), () => file);
    await Promise.all([workbench.saveManagedConfig(file), workbench.saveManagedConfig(file)]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toBeTruthy();
    expect(readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('the discovery cache is saved while the old fixed staging name is occupied', () => {
    const home = newRoot();
    const file = join(home, '.goodvibes', 'gv-fixed', 'discovered-providers.json');
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(`${file}.${process.pid}.tmp`);
    const roots = { homeDirectory: home, surfaceRoot: 'gv-fixed' };
    persistProviders(roots, [{ name: 'Local', host: '10.0.0.7', port: 1234, baseURL: 'http://10.0.0.7:1234/v1', models: ['m'], serverType: 'unknown' }]);
    expect(loadPersistedProviders(roots).map((entry) => entry.host)).toEqual(['10.0.0.7']);
  });

  test('the tailscale receipt log is saved while the old fixed staging name is occupied', () => {
    const file = join(newRoot(), 'receipts.json');
    mkdirSync(`${file}.tmp-${process.pid}`);
    const store = new TailscaleServeReceiptStore(file);
    store.append({ at: 1, command: 'tailscale serve --bg 1', ok: true, detail: 'one' });
    expect(store.list()).toHaveLength(1);
  });

  test('the session spine fold marker is written while the old fixed staging name is occupied', () => {
    const dir = newRoot();
    const storePath = join(dir, 'sessions.json');
    writeFileSync(storePath, JSON.stringify({ sessions: { s1: { id: 's1', title: 't', status: 'active' } } }));
    const markerPath = join(dir, '.spine-folded');
    mkdirSync(`${markerPath}.${process.pid}.tmp`);
    const log = { debug: () => {}, info: () => {}, warn: () => {} };
    const client = { foldLegacyRecords: (): void => {} };
    foldLegacySpineStore(client, { storePath, markerPath, project: '/p', now: () => 1, log });
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ completed: true });
  });

  test('the session migration marker is written while the old fixed staging name is occupied', () => {
    const wd = newRoot();
    const marker = join(wd, '.goodvibes', 'tui', '.migrated-v1');
    mkdirSync(dirname(marker), { recursive: true });
    mkdirSync(`${marker}.tmp`);
    mkdirSync(`${marker}.${process.pid}.tmp`);
    createSessionSurface({ surfaceRoot: 'tui', workingDirectory: wd, homeDirectory: wd });
    expect(existsSync(marker) && statSync(marker).isFile()).toBe(true);
  });

  test('the user store and bootstrap credential are written while the old fixed staging names are occupied', () => {
    const root = newRoot();
    const store = join(root, 'users.json');
    const credential = join(root, 'bootstrap.txt');
    occupyFixedStagingNames(store);
    occupyFixedStagingNames(credential);
    new UserAuthManager({ bootstrapFilePath: store, bootstrapCredentialPath: credential });
    expect((JSON.parse(readFileSync(store, 'utf8')) as { users: unknown[] }).users.length).toBeGreaterThan(0);
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
