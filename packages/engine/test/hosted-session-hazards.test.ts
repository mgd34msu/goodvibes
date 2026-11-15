/**
 * Hosted sessions that end, restart, or are named by a stray detach: what the
 * engine keeps, what it forgets, and what it refuses to end.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitFor } from './_helpers/test-timeout.js';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices } from '../platform/src/platform/runtime/client-services.ts';
import { SessionLiveTurnControlsHolder } from '../platform/src/platform/control-plane/routes/session-runtime.ts';
import { HostedSessionManager } from '../platform/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore } from '../platform/src/platform/hosted-sessions/store.ts';
import type { HostedWorkspaceFloor } from '../platform/src/platform/hosted-sessions/workspace-floor.ts';
import type { HostedSessionUpdatePayload } from '../platform/src/platform/hosted-sessions/types.ts';

let root: string;
let workspace: string;
let stateDir: string;
let published: HostedSessionUpdatePayload[];
let liveTurns: SessionLiveTurnControlsHolder;
let disposals: (() => void)[];

const RETENTION_MS = 60_000;

function buildManager(options?: {
  readonly now?: (() => number) | undefined;
  readonly isClientConnected?: ((clientId: string) => boolean) | undefined;
  readonly listClients?: (() => readonly { readonly id: string }[]) | undefined;
  readonly onFloor?: ((floor: HostedWorkspaceFloor) => HostedWorkspaceFloor | Promise<HostedWorkspaceFloor>) | undefined;
}): HostedSessionManager {
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor | Promise<HostedWorkspaceFloor> => {
      const services = createClientRuntimeServices({
        configManager,
        runtimeBus,
        runtimeStore: createRuntimeStore(),
        surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot,
        homeDirectory: root,
        requestApproval: async () => ({ approved: false }),
        modelDiscovery: 'skip',
      });
      disposals.push(() => services.dispose());
      const floor = { services, contractRunner: services.contractRunner, dispose: (): void => services.dispose() };
      return options?.onFloor?.(floor) ?? floor;
    },
    store: new HostedSessionStore(stateDir, { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: RETENTION_MS }),
    settings: { detachPolicy: () => 'kill', maxSessions: () => 8, attachmentTtlMs: () => 10 * 60_000 },
    runtimeBus,
    systemPrompt: ({ workspaceRoot }) => `hosted in ${workspaceRoot}`,
    liveTurns,
    isWorkspaceUsable: () => true,
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  manager.setEventPublisher({
    publishEvent: (_event, payload) => { published.push(payload as HostedSessionUpdatePayload); },
    ...(options?.isClientConnected === undefined ? {} : { isClientConnected: options.isClientConnected }),
    ...(options?.listClients === undefined ? {} : { listClients: options.listClients }),
  });
  return manager;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-hazards-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  stateDir = join(root, 'hosted-sessions');
  published = [];
  liveTurns = new SessionLiveTurnControlsHolder();
  disposals = [];
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    try { dispose(); } catch { /* a floor already disposed by the manager */ }
  }
  rmSync(root, { recursive: true, force: true });
});

test('detaching a client that was never attached leaves the session alone', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const after = await manager.detach(session.id, 'someone-else');
  expect(after.status).toBe('idle');
  expect(manager.hosts(session.id)).toBe(true);
  await manager.dispose();
});

test('a lapsed attachment still ends a kill-policy session', async () => {
  let clock = 1_000_000;
  const manager = buildManager({ now: () => clock });
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace, clientId: 'gone' });
  clock += 11 * 60_000;
  await manager.reapAttachments();
  expect(manager.get(session.id)?.status).toBe('terminated');
  await manager.dispose();
});

test('a client that disconnected but is still listed does not keep its session alive', async () => {
  let clock = 1_000_000;
  const manager = buildManager({ now: () => clock, listClients: () => [{ id: 'gone' }], isClientConnected: () => false });
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace, clientId: 'gone' });
  clock += 11 * 60_000;
  await manager.reapAttachments();
  expect(manager.get(session.id)?.status).toBe('terminated');
  await manager.dispose();
});

test('a client whose connection is open keeps its session alive past the lease', async () => {
  let clock = 1_000_000;
  const manager = buildManager({ now: () => clock, isClientConnected: (id) => id === 'here' });
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace, clientId: 'here' });
  clock += 11 * 60_000;
  await manager.reapAttachments();
  expect(manager.get(session.id)?.status).toBe('idle');
  await manager.dispose();
});

test('a terminated session past its retention is forgotten: record, file and transcript', async () => {
  let clock = 1_000_000;
  const manager = buildManager({ now: () => clock });
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  await manager.kill(session.id);
  expect(manager.list({ includeTerminated: true }).map((s) => s.id)).toEqual([session.id]);
  expect(readdirSync(stateDir).length).toBeGreaterThan(0);

  await manager.reapAttachments();
  expect(manager.get(session.id)?.status).toBe('terminated');

  clock += RETENTION_MS + 1;
  await manager.reapAttachments();
  expect(manager.get(session.id)).toBeNull();
  expect(manager.list({ includeTerminated: true })).toHaveLength(0);
  expect(readdirSync(stateDir).filter((name) => name.includes(session.id))).toHaveLength(0);
  await manager.dispose();
});

test('the contract surface can tell a hosted session that is gone from one never hosted', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const runners = manager.contractRunners();
  expect(runners.knows?.(session.id)).toBe(true);
  await manager.kill(session.id);
  expect(runners.knows?.(session.id)).toBe(true);
  expect(await runners.forSession(session.id)).toBeNull();
  expect(runners.knows?.('never-hosted')).toBe(false);
  await manager.dispose();
});

test('stopping a session releases its workspace and records it terminated even when its loop fails to stop', async () => {
  const unbind = liveTurns.unbindSession.bind(liveTurns);
  liveTurns.unbindSession = () => { throw new Error('unbind failed'); };
  let cleaned = 0;
  const manager = buildManager({ onFloor: (floor) => ({ ...floor, dispose() { cleaned += 1; return floor.dispose(); } }) });
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace });
  const killed = await manager.kill(session.id);
  liveTurns.unbindSession = unbind;
  expect(killed.status).toBe('terminated');
  expect(cleaned).toBe(1);
  const notice = published.find((payload) => payload.event === 'hosted-session-terminated');
  expect(notice?.detail).toContain('unbind failed');
  await manager.dispose();
});

test('a restored session whose workspace could not be acquired once is not terminated for it', async () => {
  const first = buildManager();
  await first.init();
  const session = await first.create({ workspaceRoot: workspace, clientId: 'a', detachPolicy: 'survive' });
  await first.dispose();

  let attempts = 0;
  const second = buildManager({ onFloor: (floor) => {
    attempts += 1;
    if (attempts === 1) throw new Error('provider registry is not ready');
    return floor;
  } });
  await second.init();
  await expect(second.attach(session.id, 'b')).rejects.toThrow('not ready');
  expect(second.get(session.id)?.status).toBe('idle');
  const attached = await second.attach(session.id, 'b');
  expect(attached.session.attachedClients).toEqual(['b']);
  await second.dispose();
});

test('a first prompt that cannot be delivered is published, not dropped', async () => {
  const manager = buildManager();
  await manager.init();
  (manager as { deliver: HostedSessionManager['deliver'] }).deliver = async () => { throw new Error('its loop could not be composed'); };
  await manager.create({ workspaceRoot: workspace, initialPrompt: 'hello' });
  await waitFor(() => published.some((payload) => payload.detail?.includes('first prompt was not delivered') === true));
  await manager.dispose();
});
