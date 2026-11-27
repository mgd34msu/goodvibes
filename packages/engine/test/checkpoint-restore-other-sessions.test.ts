// Proves: Putting a project's files back to a checkpoint silently takes back another session's or agent's change, and that session is never told.
// Red when: A restore that would undo another session's change runs without asking, the question opens on the choice that restores, the other session is not told in its conversation where its change is kept, or a checkpoint stops recording the session that made it.
// Proves: A caller of the daemon's checkpoints.restore (the web UI, an outside agent) takes back another session's change it was never shown.
// Red when: The daemon restores on confirm:true without takeBack naming every other session whose change goes back, or on a preview token minted before another session's later change, or its preview stops listing those sessions and files.

/**
 * One project's checkpoint store is shared by every session working in it. The
 * real checkpoint manager on a temp project and the terminal programs' one
 * restore step (`restoreCheckpointFiles`, recovery-commands.ts), with the person's
 * answer given to the question it asks. Session A restores a checkpoint made
 * before session B changed a file: A is asked first, naming B and the file, and
 * the question opens on keeping B's change; "no" changes nothing; "yes" restores
 * and B is told, at its next turn, that its change was taken back and which
 * checkpoint keeps it. A restore that takes back only A's own change runs at once.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { emitTurnSubmitted } from '../platform/src/platform/runtime/emitters/turn.ts';
import { restoreCheckpointFiles } from '../terminal-shell/src/recovery-commands.ts';
import { ConfirmDialog, type ConfirmOptions } from '../terminal-shell/src/confirm-dialog.ts';
import { createCheckpointsRestoreHandler, createCheckpointsRestorePreviewHandler } from '../platform/src/platform/control-plane/routes/checkpoints.ts';
import { ReviewTokenStore } from '../platform/src/platform/control-plane/review-tokens.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-restore-others-')));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('a restore that would take back another session\'s change asks first, opening on keeping it; yes tells that session; one\'s own change is restored at once', async () => {
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  let tick = 0;
  const bus = new RuntimeEventBus();
  const manager = new WorkspaceCheckpointManager({
    workspaceRoot: project, checkpointDir: join(root, 'checkpoints'), homeDir: home, runtimeBus: bus,
    preferGitRoot: false, now: () => (tick += 1000),
  });
  const put = (name: string, text: string): void => { writeFileSync(join(project, name), `${text}\n`); };
  const read = (name: string): string => readFileSync(join(project, name), 'utf8').trim();
  put('a.txt', 'a0');
  put('b.txt', 'b0');
  await manager.init();
  // Each session's turn ends with a checkpoint recording the session and turn that made it.
  put('a.txt', 'a1');
  const beforeB = await manager.create({ kind: 'turn', sessionId: 'session-a', turnId: 'a-1', label: 'turn completed' });
  put('b.txt', 'b1');
  await manager.create({ kind: 'turn', sessionId: 'session-b', turnId: 'b-1', label: 'turn completed' });
  put('a.txt', 'a2');
  const aLast = await manager.create({ kind: 'turn', sessionId: 'session-a', turnId: 'a-2', label: 'turn completed' });

  const asked: ConfirmOptions[] = [];
  let answer = false;
  const printed: string[] = [];
  const context = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    confirm: async (options: ConfirmOptions) => { asked.push(options); return answer; },
  };
  const restore = (checkpointId: string) => restoreCheckpointFiles(context, manager, { ...beforeB!, id: checkpointId }, { yes: false, record: (text) => { printed.push(text); }, sessionId: 'session-a' });
  const rows: string[] = [];

  // Only A's own change after its last checkpoint: restored at once, nobody asked.
  put('a.txt', 'a3');
  await restore(aLast!.id);
  rows.push(`own change: asked ${asked.length}, a=${read('a.txt')} b=${read('b.txt')}`);

  // Back to before B's change: asked first, naming B and its file, opening on keeping it; "no" changes nothing.
  await restore(beforeB!.id);
  const question = asked[0];
  rows.push(`others' change, no: asked ${asked.length}, a=${read('a.txt')} b=${read('b.txt')}`);
  rows.push(`question names: ${/session session-b: b\.txt/.test(question?.body ?? '') ? 'session-b b.txt' : question?.body}`);
  rows.push(`opens on: ${question ? (new ConfirmDialog(question, () => {}).chosen === 0 ? question.cancelLabel : question.confirmLabel) : 'none'}`);

  // "Yes": restored, and B is told at its next turn where its change is kept.
  answer = true;
  const told: string[] = [];
  manager.followTakenBack(() => 'session-b', (text) => { told.push(text); }, (id) => id);
  await restore(beforeB!.id);
  rows.push(`others' change, yes: asked ${asked.length}, a=${read('a.txt')} b=${read('b.txt')}`);
  emitTurnSubmitted(bus, { sessionId: 'session-b', traceId: 'session-b:b-2', source: 'test' }, { turnId: 'b-2', prompt: 'next' });
  // The notice is read under the store's lock; draining the store waits for that read (no clock).
  const keptIn = await manager.list();
  await manager.drain();
  const line = told.join('\n');
  const keptAs = /kept as checkpoint (\S+);/.exec(line)?.[1];
  const kept = keptAs && keptIn.some((checkpoint) => checkpoint.id === keptAs) ? await manager.diff(beforeB!.id, keptAs) : undefined;
  rows.push(`session-b told: ${/Your change to b\.txt was taken back: session session-a/.test(line) ? 'taken back by session-a' : line}, kept: ${kept?.files.includes('b.txt') ? 'b.txt' : 'nothing'}`);

  expect(rows).toEqual([
    'own change: asked 0, a=a2 b=b1',
    'others\' change, no: asked 1, a=a2 b=b1',
    'question names: session-b b.txt',
    'opens on: Keep them',
    'others\' change, yes: asked 2, a=a1 b=b0',
    'session-b told: taken back by session-a, kept: b.txt',
  ]);
});

test('the daemon\'s restore takes back another session\'s change only when its caller was shown it: the preview lists it, confirm:true must name it, an older token is refused', async () => {
  const project = join(root, 'remote');
  const home = join(root, 'remote-home');
  mkdirSync(project);
  mkdirSync(home);
  let tick = 0;
  const manager = new WorkspaceCheckpointManager({
    workspaceRoot: project, checkpointDir: join(root, 'remote-checkpoints'), homeDir: home, runtimeBus: new RuntimeEventBus(),
    preferGitRoot: false, now: () => (tick += 1000),
  });
  const put = (name: string, text: string): void => { writeFileSync(join(project, name), `${text}\n`); };
  const read = (name: string): string => readFileSync(join(project, name), 'utf8').trim();
  put('b.txt', 'b0');
  await manager.init();
  put('a.txt', 'a0');
  const before = await manager.create({ kind: 'manual', label: 'before' });
  put('b.txt', 'b1');
  await manager.create({ kind: 'turn', sessionId: 'session-b', turnId: 'b-1', label: 'turn completed' });

  // The daemon's own handlers over the real manager; the caller is a web page (no session of its own).
  const tokens = new ReviewTokenStore();
  const preview = createCheckpointsRestorePreviewHandler(manager, tokens);
  const restore = createCheckpointsRestoreHandler(manager, tokens);
  const web = { body: {}, context: { principalId: 'owner', principalKind: 'user', admin: true, scopes: ['*'], metadata: {} } } as const;
  const call = async (handler: typeof restore, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { return await handler({ ...web, body }) as Record<string, unknown>; } catch (error) { return { threw: (error as { code?: string }).code ?? String(error) }; }
  };
  const rows: string[] = [];

  const shown = await call(preview, { id: before!.id });
  const listed = (shown['preview'] as { otherSessions?: { sessionId: string; files: string[] }[] }).otherSessions ?? [];
  rows.push(`preview lists: ${listed.map((other) => `${other.sessionId} ${other.files.join(',')}`).join('; ')}`);

  const blind = await call(restore, { id: before!.id, confirm: true });
  const named = ((blind['refusal'] as { otherSessions?: { sessionId: string }[] } | null)?.otherSessions ?? []).map((other) => other.sessionId);
  rows.push(`confirm alone: refused ${String(blind['refused'])}, names ${named.join(',')}, b=${read('b.txt')}`);

  // Session B changes the file again after the preview: the preview's token no longer confirms what would go back.
  put('b.txt', 'b2');
  await manager.create({ kind: 'turn', sessionId: 'session-b', turnId: 'b-2', label: 'turn completed' });
  const stale = await call(restore, { id: before!.id, confirmToken: shown['token'] });
  rows.push(`older token: ${String(stale['threw'] ?? stale['refused'])}, b=${read('b.txt')}`);

  const seen = await call(restore, { id: before!.id, confirm: true, takeBack: ['session-b'] });
  rows.push(`named: refused ${String(seen['refused'])}, b=${read('b.txt')}`);

  expect(rows).toEqual([
    'preview lists: session-b b.txt',
    'confirm alone: refused true, names session-b, b=b1',
    'older token: TARGET_CHANGED, b=b2',
    'named: refused false, b=b0',
  ]);
});
