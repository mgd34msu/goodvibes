/**
 * A turn-ended event on a session that is not running (a second end event for
 * one turn, a stray cancel) must not count a turn or republish turn-ended.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices } from '../platform/src/platform/runtime/client-services.ts';
import { SessionLiveTurnControlsHolder } from '../platform/src/platform/control-plane/routes/session-runtime.ts';
import { HostedSessionManager } from '../platform/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore } from '../platform/src/platform/hosted-sessions/store.ts';
import type { HostedWorkspaceFloor } from '../platform/src/platform/hosted-sessions/workspace-floor.ts';
import type { HostedSessionUpdatePayload } from '../platform/src/platform/hosted-sessions/types.ts';
import { emitTurnCancel, emitTurnCompleted, emitTurnError, emitTurnSubmitted } from '../platform/src/platform/runtime/emitters/turn.ts';

let root: string;
let workspace: string;
let published: HostedSessionUpdatePayload[];
let disposals: (() => void)[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-marks-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  published = [];
  disposals = [];
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) { try { dispose(); } catch { /* already disposed */ } }
  rmSync(root, { recursive: true, force: true });
});

async function build() {
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const services = createClientRuntimeServices({ configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot, homeDirectory: root, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
      disposals.push(() => services.dispose());
      return { services, contractRunner: services.contractRunner, dispose: (): void => services.dispose() };
    },
    store: new HostedSessionStore(join(root, 'hosted-sessions'), { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 }),
    settings: { detachPolicy: () => 'kill', maxSessions: () => 8, attachmentTtlMs: () => 600_000 },
    runtimeBus,
    systemPrompt: ({ workspaceRoot }) => `hosted in ${workspaceRoot}`,
    liveTurns: new SessionLiveTurnControlsHolder(),
    isWorkspaceUsable: () => true,
  });
  manager.setEventPublisher({ publishEvent: (_event, payload) => { published.push(payload as HostedSessionUpdatePayload); } });
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace, clientId: 'terminal-1' });
  const ctx = { sessionId: session.id, traceId: 't', source: 'test' } as const;
  return { manager, runtimeBus, session, ctx };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('end events on an idle session are ignored; a real turn counts once even if two end events arrive', async () => {
  const { manager, runtimeBus, session, ctx } = await build();
  const ended = () => published.filter((p) => p.event === 'hosted-session-turn-ended').length;

  emitTurnCompleted(runtimeBus, ctx, { turnId: 'stray', response: '', stopReason: 'completed' });
  emitTurnCancel(runtimeBus, ctx, { turnId: 'stray', stopReason: 'cancelled' });
  await settle();
  expect(manager.get(session.id)!.turnCount).toBe(0);
  expect(manager.get(session.id)!.status).toBe('idle');
  expect(ended()).toBe(0);

  emitTurnSubmitted(runtimeBus, ctx, { turnId: 'real', prompt: 'go' });
  await settle();
  expect(manager.get(session.id)!.status).toBe('running');
  emitTurnError(runtimeBus, ctx, { turnId: 'real', error: 'boom', stopReason: 'provider_error' } as never);
  emitTurnCompleted(runtimeBus, ctx, { turnId: 'real', response: '', stopReason: 'completed' });
  await settle();
  expect(manager.get(session.id)!.turnCount).toBe(1);
  expect(manager.get(session.id)!.status).toBe('idle');
  expect(ended()).toBe(1);
});
