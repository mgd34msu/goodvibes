/**
 * Rewind and restore keep a way back, restore exactly what they say, and
 * never act on a plan, anchor or index that is no longer current.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.js';
import { CheckpointRestoreError } from '../platform/src/platform/workspace/checkpoint/types.js';
import {
  UnifiedRewindService,
  RewindTokenError,
  clearTurnAnchors,
  getTurnAnchors,
  recordTurnAnchor,
  type RewindCheckpointView,
  type RewindConversationPort,
  type RewindWorkspacePort,
} from '../platform/src/platform/rewind/index.js';
import {
  GatewayMethodCatalog,
  createConversationRewindHostBroker,
  registerRewindConversationHostGatewayMethods,
} from '../platform/src/platform/control-plane/index.ts';
import { createConversationRewindHost } from '../platform/src/platform/runtime/client/conversation-rewind-host.ts';
import type { DaemonVerbCaller } from '../platform/src/platform/runtime/client/daemon-verbs.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-undo-'));
  dirs.push(dir);
  return dir;
}

describe('workspace checkpoint restore', () => {
  test('restoring from a clean tree still reports an undo point: the most recent checkpoint', async () => {
    const root = workspace();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'a.txt'), '1');
    const first = await manager.create({ kind: 'turn', turnId: 't1' });
    writeFileSync(join(root, 'a.txt'), '2');
    const second = await manager.create({ kind: 'turn', turnId: 't2' });

    const result = await manager.restore(first!.id);
    expect(result.safetyCheckpointId).toBe(second!.id);
  });

  test('two managers sharing one store keep each other\'s checkpoints in the index', async () => {
    const root = workspace();
    const a = new WorkspaceCheckpointManager({ workspaceRoot: root });
    const b = new WorkspaceCheckpointManager({ workspaceRoot: root });
    await a.init();
    await b.init();
    writeFileSync(join(root, 'a.txt'), '1');
    const fromA = await a.create({ kind: 'manual', label: 'from a' });
    writeFileSync(join(root, 'a.txt'), '2');
    const fromB = await b.create({ kind: 'manual', label: 'from b' });

    const reopened = new WorkspaceCheckpointManager({ workspaceRoot: root });
    const ids = (await reopened.list()).map((c) => c.id);
    expect(ids).toContain(fromA!.id);
    expect(ids).toContain(fromB!.id);
  });

  test('a file with a non-ASCII name created after the checkpoint is removed by restore', async () => {
    const root = workspace();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'a.txt'), '1');
    const checkpoint = await manager.create({ kind: 'manual', label: 'before' });
    writeFileSync(join(root, '設計.md'), 'later');

    const result = await manager.restore(checkpoint!.id);
    expect(result.removedFiles).toEqual(['設計.md']);
    expect(existsSync(join(root, '設計.md'))).toBe(false);
  });

  test('a restore that fails after saving the pre-restore state names that state', async () => {
    const root = workspace();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    writeFileSync(join(root, 'a.txt'), '1');
    const checkpoint = await manager.create({ kind: 'manual', label: 'before' });
    writeFileSync(join(root, 'a.txt'), '2');
    await manager.init();
    const sideGit = (manager as unknown as { sideGit: { checkoutIndexAll(): Promise<void> } }).sideGit;
    sideGit.checkoutIndexAll = async () => { throw new Error('disk full'); };

    const error = await manager.restore(checkpoint!.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckpointRestoreError);
    const safetyId = (error as CheckpointRestoreError).safetyCheckpointId;
    expect((await manager.list()).map((c) => c.id)).toContain(safetyId);
    expect((error as Error).message).toContain(`restore that checkpoint to return to it`);
  });
});

/** Every checkpoint here belongs to session `s1`; the list honours the session filter like the real manager. */
function fakeWorkspace(checkpoints: RewindCheckpointView[], restored: string[]): RewindWorkspacePort {
  return {
    list: async (filter) => (filter?.sessionId === undefined || filter.sessionId === 's1' ? checkpoints : []),
    diff: async () => ({ files: ['a.ts'] }),
    restore: async (id) => {
      restored.push(id);
      return { checkpointId: id, safetyCheckpointId: 'wcp_safety', restoredFiles: [], removedFiles: [] };
    },
  };
}

function trackingConversation(rewound: string[]): RewindConversationPort {
  return {
    preview: async () => ({ messagesToDrop: 4, messagesRemaining: 2 }),
    rewind: async (anchor) => {
      rewound.push(anchor.turnId ?? '');
      return { droppedMessages: 4, undoSnapshotId: 'undo' };
    },
  };
}

describe('rewind service', () => {
  test('a confirm token does not authorize a checkpoint the plan never previewed', async () => {
    const checkpoints: RewindCheckpointView[] = [{ id: 'wcp_old', createdAt: 100, label: 'old' }];
    const restored: string[] = [];
    const service = new UnifiedRewindService({ workspace: fakeWorkspace(checkpoints, restored) });
    const plan = await service.plan({ sessionId: 's1' }, 'files');
    expect(plan.files?.checkpointId).toBe('wcp_old');
    checkpoints.push({ id: 'wcp_new', createdAt: 200, label: 'new' });

    await expect(service.apply({ sessionId: 's1' }, 'files', { confirmToken: plan.token })).rejects.toBeInstanceOf(RewindTokenError);
    expect(restored).toEqual([]);
  });

  test('rewinding both to a turn with no checkpoint of its own is refused before anything changes', async () => {
    const restored: string[] = [];
    const rewound: string[] = [];
    const service = new UnifiedRewindService({
      workspace: fakeWorkspace([{ id: 'wcp_t1', turnId: 't1', createdAt: 100, label: 't1' }, { id: 'wcp_t3', turnId: 't3', createdAt: 300, label: 't3' }], restored),
      conversation: trackingConversation(rewound),
    });

    const plan = await service.plan({ sessionId: 's1', turnId: 't2' }, 'both');
    expect(plan.warnings.join('\n')).toContain('Turn t2 has no workspace checkpoint of its own');
    const result = await service.apply({ sessionId: 's1', turnId: 't2' }, 'both', { confirm: true });

    expect(result.refused).toBe(true);
    expect(result.refusal?.reason).toContain('scope "conversation"');
    expect(restored).toEqual([]);
    expect(rewound).toEqual([]);
    // Conversation-only stays available for the same turn.
    expect((await service.apply({ sessionId: 's1', turnId: 't2' }, 'conversation', { confirm: true })).refused).toBe(false);
  });

  test('a conversation rewind drops the anchors of the turns it removed', async () => {
    const session = 'anchors-after-rewind';
    clearTurnAnchors(session);
    for (const [turnId, messageCount] of [['t1', 2], ['t2', 4], ['t3', 6]] as const) {
      recordTurnAnchor(session, { turnId, label: turnId, messageCount, at: messageCount });
    }
    const service = new UnifiedRewindService({ conversation: trackingConversation([]) });
    await service.apply({ sessionId: session, turnId: 't1' }, 'conversation', { confirm: true });
    expect(getTurnAnchors(session).map((a) => a.turnId)).toEqual(['t1']);
    clearTurnAnchors(session);
  });
});

describe('turn anchors', () => {
  test('a turn that ends below earlier anchors retires them', () => {
    const session = 'anchors-cut-back';
    clearTurnAnchors(session);
    recordTurnAnchor(session, { turnId: 't1', label: 't1', messageCount: 2, at: 1 });
    recordTurnAnchor(session, { turnId: 't2', label: 't2', messageCount: 8, at: 2 });
    recordTurnAnchor(session, { turnId: 't3', label: 't3', messageCount: 4, at: 3 });
    expect(getTurnAnchors(session).map((a) => a.turnId)).toEqual(['t1', 't3']);
    clearTurnAnchors(session);
  });
});

describe('conversation rewind host', () => {
  test('a port that cannot rewind to the anchor is answered unavailable, not as zero dropped', async () => {
    const broker = createConversationRewindHostBroker();
    const catalog = new GatewayMethodCatalog();
    registerRewindConversationHostGatewayMethods(catalog, broker);
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(methodId: string, input?: unknown): Promise<T> =>
        await catalog.invoke(methodId as never, { context: { admin: true }, body: input ?? {} } as never) as T,
    };
    const host = createConversationRewindHost({
      verbs,
      port: {
        preview: async () => ({ messagesToDrop: 0, messagesRemaining: 0, available: false, unavailableReason: 'turn t9 was not recorded' }),
        rewind: async () => ({ droppedMessages: 0, undoSnapshotId: '', available: false, unavailableReason: 'turn t9 was not recorded' }),
      },
      hosts: () => true,
      waitMs: 0,
    });
    host.offer('s1');
    await host.pump();
    const applied = broker.rewind({ sessionId: 's1', turnId: 't9' } as never);
    await host.pump();
    const answer = await applied as unknown as Record<string, unknown>;
    expect(answer['available']).toBe(false);
    expect(answer['unavailableReason']).toBe('turn t9 was not recorded');
    await host.stop();
  });
});
