/**
 * /rewind, /undo rewind and /redo rewind replace or truncate the live
 * conversation, so they must not run under a streaming turn, and a half-done
 * reversal must be reported as half.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/platform/platform/workspace';
import { recordTurnAnchor, clearTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerRewindRuntimeCommands, undoLastRewind, redoLastRewind, resetRewindState } from '../../input/commands/rewind-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SESSION = 's-rewind-guards';
const dirs: string[] = [];
beforeEach(() => {
  resetRewindState(SESSION);
  clearTurnAnchors(SESSION);
});
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeConversation(count: number) {
  let messages: Array<{ role: string; content: string }> = Array.from({ length: count }, (_, i) => ({ role: 'user', content: `m${i}` }));
  return {
    conv: {
      getMessageCount: () => messages.length,
      getLastUserMessage: () => 'task',
      toJSON: () => ({ messages: messages.map((m) => ({ ...m })) }),
      fromJSON: (data: { messages: unknown[] }) => { messages = data.messages.map((m) => ({ ...(m as { role: string; content: string }) })); },
      removeMessagesAfter: (n: number) => { messages = messages.slice(0, n); },
      rebuildHistory: () => {},
      addTypedSystemMessage: () => {},
    },
    messages: () => messages,
    grow: (n: number) => { for (let i = 0; i < n; i++) messages.push({ role: 'user', content: `new${messages.length}` }); },
    truncate: (n: number) => { messages = messages.slice(0, n); },
  };
}

function context(conv: unknown, options: { generating?: () => boolean; confirm?: boolean } = {}) {
  const printed: string[] = [];
  const dir = makeProjectTempDir('gv-rewind-guards');
  dirs.push(dir);
  const ctx = {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    previewChanges: async () => options.confirm ?? true,
    isGenerating: options.generating,
    session: { conversationManager: conv, runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: SESSION } },
    workspace: { workspaceCheckpointManager: new WorkspaceCheckpointManager({ workspaceRoot: dir }) },
    provider: {}, platform: {}, ops: {}, extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, dir };
}

describe('rewind while a turn is running', () => {
  test('/rewind is refused and leaves the conversation as it was', async () => {
    const fake = fakeConversation(5);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'task', messageCount: 3, at: 1 });
    const { ctx, printed } = context(fake.conv, { generating: () => true });
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);
    await registry.execute('rewind', ['1', 'conversation'], ctx);
    expect(fake.messages()).toHaveLength(5);
    expect(printed.join('\n')).toContain('turn is still running');
  });

  test('/undo rewind is refused while a turn is running and the rewind stays undoable', async () => {
    const fake = fakeConversation(5);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'task', messageCount: 3, at: 1 });
    let generating = false;
    const { ctx } = context(fake.conv, { generating: () => generating });
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);
    await registry.execute('rewind', ['1', 'conversation'], ctx);
    expect(fake.messages()).toHaveLength(3);

    generating = true;
    const refused = await undoLastRewind(ctx);
    expect(refused.message).toContain('turn is still running');
    expect(fake.messages()).toHaveLength(3);

    generating = false;
    expect((await undoLastRewind(ctx)).message).toMatch(/Rewind undone/);
    expect(fake.messages()).toHaveLength(5);
  });
});

describe('/undo rewind when the conversation snapshot is gone', () => {
  test('reports the conversation as not restored and keeps the rewind on the undo list', async () => {
    const fake = fakeConversation(5);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'task', messageCount: 3, at: 1 });
    const { ctx } = context(fake.conv);
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);

    // Only the 32 most recent conversation snapshots are kept, so rewind 33 times
    // and the first one's snapshot is gone.
    for (let i = 0; i < 33; i++) {
      fake.grow(5 - fake.messages().length);
      await registry.execute('rewind', ['1', 'conversation'], ctx);
      expect(fake.messages()).toHaveLength(3);
    }
    let message = '';
    for (let i = 0; i < 33; i++) {
      fake.truncate(3);
      message = (await undoLastRewind(ctx)).message;
      if (/only partly undone/.test(message)) break;
    }
    expect(message).toMatch(/only partly undone/);
    expect(message).toContain('conversation could not be restored');
    // Still on the undo list: asking again reports the same, it is not silently dropped.
    fake.truncate(3);
    expect((await undoLastRewind(ctx)).message).toMatch(/only partly undone/);
  });
});

describe('/undo rewind when the file restore only partly applies', () => {
  test('names the failed paths, does not claim the files were restored, and keeps the rewind undoable', async () => {
    const fake = fakeConversation(5);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'task', messageCount: 3, at: 1 });
    const { ctx, dir } = context(fake.conv);
    const mgr = ctx.workspace.workspaceCheckpointManager!;
    writeFileSync(join(dir, 'a.txt'), 'v1');
    await mgr.create({ kind: 'turn', turnId: 't1', label: 'turn t1', retentionClass: 'standard' });
    writeFileSync(join(dir, 'a.txt'), 'v2');
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);
    await registry.execute('rewind', ['1', 'files'], ctx);

    const realRestore = mgr.restore.bind(mgr);
    mgr.restore = (async (id: string, opts?: { safetyCheckpoint?: boolean }) => ({
      ...(await realRestore(id, opts)),
      failedPaths: [{ path: 'locked.txt', reason: 'EBUSY' }],
    })) as typeof mgr.restore;

    const result = await undoLastRewind(ctx);
    expect(result.message).toContain('only partly undone');
    expect(result.message).toContain('locked.txt: EBUSY');
    expect(result.message).not.toContain('files restored to pre-rewind state');
    expect((await undoLastRewind(ctx)).message).toContain('only partly undone');
  });
});

describe('/undo and /redo rewind with scope both and a partial file restore', () => {
  async function setup() {
    const fake = fakeConversation(5);
    recordTurnAnchor(SESSION, { turnId: 't1', label: 'task', messageCount: 3, at: 1 });
    const { ctx, dir } = context(fake.conv);
    const mgr = ctx.workspace.workspaceCheckpointManager!;
    writeFileSync(join(dir, 'a.txt'), 'v1');
    await mgr.create({ kind: 'turn', turnId: 't1', label: 'turn t1', retentionClass: 'standard' });
    writeFileSync(join(dir, 'a.txt'), 'v2');
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);
    await registry.execute('rewind', ['1', 'both'], ctx);
    expect(fake.messages()).toHaveLength(3);
    const realRestore = mgr.restore.bind(mgr);
    let fail = true;
    mgr.restore = (async (id: string, opts?: { safetyCheckpoint?: boolean }) => {
      const result = await realRestore(id, opts);
      return fail ? { ...result, failedPaths: [{ path: 'locked.txt', reason: 'EBUSY' }] } : result;
    }) as typeof mgr.restore;
    return { fake, ctx, setFail: (v: boolean) => { fail = v; } };
  }

  test('a retry after a partial undo is not refused by the newer-messages guard and then completes', async () => {
    const { fake, ctx, setFail } = await setup();
    const partial = await undoLastRewind(ctx);
    expect(partial.message).toContain('only partly undone');
    expect(fake.messages()).toHaveLength(5);

    setFail(false);
    const retry = await undoLastRewind(ctx);
    expect(retry.message).not.toContain('refused');
    expect(retry.message).toMatch(/Rewind undone/);
    expect(fake.messages()).toHaveLength(5);
  });

  test('a partial redo names the failed paths and keeps the rewind reversible', async () => {
    const { fake, ctx, setFail } = await setup();
    setFail(false);
    expect((await undoLastRewind(ctx)).message).toMatch(/Rewind undone/);
    setFail(true);
    const redone = await redoLastRewind(ctx);
    expect(redone.message).toContain('only partly re-applied');
    expect(redone.message).toContain('locked.txt: EBUSY');
    expect(redone.message).not.toContain('Rewind re-applied');
    expect(fake.messages()).toHaveLength(3);
    setFail(false);
    expect((await undoLastRewind(ctx)).message).toMatch(/Rewind undone/);
  });
});

describe('checkpoint-only /rewind with a partial file restore', () => {
  test('names the failed paths and does not record a success message', async () => {
    const fake = fakeConversation(2);
    const added: string[] = [];
    (fake.conv as { addTypedSystemMessage: (t: string) => void }).addTypedSystemMessage = (t) => { added.push(t); };
    const { ctx, printed, dir } = context(fake.conv);
    const mgr = ctx.workspace.workspaceCheckpointManager!;
    writeFileSync(join(dir, 'a.txt'), 'v1');
    await mgr.create({ kind: 'turn', turnId: 'x', label: 'cp', retentionClass: 'standard' });
    writeFileSync(join(dir, 'a.txt'), 'v2');
    const realRestore = mgr.restore.bind(mgr);
    mgr.restore = (async (id: string, opts?: { safetyCheckpoint?: boolean }) => ({
      ...(await realRestore(id, opts)),
      failedPaths: [{ path: 'locked.txt', reason: 'EBUSY' }],
    })) as typeof mgr.restore;
    const registry = new CommandRegistry();
    registerRewindRuntimeCommands(registry);
    await registry.execute('rewind', ['1'], ctx);
    expect(printed.join('\n')).toContain('only partly restored');
    expect(printed.join('\n')).toContain('locked.txt: EBUSY');
    expect(added).toHaveLength(0);
  });
});
