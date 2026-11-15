/**
 * session-resume-liveness-confirm.test.ts, /session resume's multi-instance
 * liveness confirm gate (item 6b).
 *
 * A session with a LIVE pid liveness marker (see runtime/session-liveness-marker.ts)
 * means another still-running process is actively refreshing it, resuming it
 * here would fork its live state out from under that other instance. /session
 * resume (also reachable via /resume and /sessions resume, same code path)
 * warns and requires an explicit `--force` to proceed. A missing/stale marker,
 * or a marker that happens to be THIS process's own pid, never blocks anything.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { handleSessionWorkflowCommand } from '../../input/commands/session-workflow.ts';
import { writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { clearTurnAnchors, getTurnAnchors, recordTurnAnchor, restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import { loadWorkTreeTurnOutcomes } from '../../core/work-tree-fold-store.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-resume-liveness-confirm');
});

afterEach(() => {
  while (children.length > 0) children.pop()!.kill();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** A real second process that stays alive until the test ends, so its pid is "another live process" on any host. */
function startOtherLiveProcess(): number {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1 << 30)'], { stdio: ['ignore', 'ignore', 'ignore'] });
  children.push(child);
  return child.pid;
}

/** The pid of a process that has already exited and been reaped. */
async function exitedProcessPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
  await child.exited;
  return child.pid;
}

function makeCtx(sm: SessionManager, printed: string[]): CommandContext {
  const conversation = new ConversationManager(() => 80);
  return {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    session: {
      conversationManager: conversation,
      runtime: { sessionId: 'current-session', model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium' },
      sessionManager: sm,
    },
    workspace: {
      shellPaths: { workingDirectory: tmpDir, homeDirectory: tmpDir },
      surface: makeTestSurface(tmpDir),
    },
    platform: { configManager: { get: () => 'off', getCategory: () => ({}) } },
    clients: { providerApi: { selectModel: async (model: string) => ({ registryKey: model, providerId: 'p' }) } },
  } as unknown as CommandContext;
}

describe('/session resume: multi-instance liveness confirm', () => {
  test('no liveness marker at all: resumes normally, no warning', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-a', [{ role: 'user', content: 'hi' }], { title: 'A', model: 'm', provider: 'p', timestamp: Date.now() });
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-a'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-a');
    expect(printed.join('\n')).not.toContain('appears open in another terminal');
  });

  test('a live marker from a DIFFERENT pid warns and refuses without --force', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-b', [{ role: 'user', content: 'hi' }], { title: 'B', model: 'm', provider: 'p', timestamp: Date.now() });
    const otherPid = startOtherLiveProcess();
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-b', otherPid);
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-b'], ctx);

    expect(handled).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain('appears open in another terminal');
    expect(output).toContain(`pid ${otherPid}`);
    expect(output).toContain('--force');
    // Never actually resumed, no "Resumed session" receipt.
    expect(output).not.toContain('Resumed session: sess-b');
  });

  test('the same live marker WITH --force proceeds to resume', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-c', [{ role: 'user', content: 'hi' }], { title: 'C', model: 'm', provider: 'p', timestamp: Date.now() });
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-c', startOtherLiveProcess());
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-c', '--force'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-c');
  });

  test('a marker whose pid IS this process\'s own pid never warns (resuming the session already active here)', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-self', [{ role: 'user', content: 'hi' }], { title: 'Self', model: 'm', provider: 'p', timestamp: Date.now() });
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-self', process.pid);
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-self'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-self');
    expect(printed.join('\n')).not.toContain('appears open in another terminal');
  });

  test('a stale marker (pid no longer running) never blocks; best-effort, never a hard lock', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-stale', [{ role: 'user', content: 'hi' }], { title: 'Stale', model: 'm', provider: 'p', timestamp: Date.now() });
    writeLivenessMarker(makeTestSurface(tmpDir), 'sess-stale', await exitedProcessPid());
    const printed: string[] = [];
    const ctx = makeCtx(sm, printed);

    const handled = await handleSessionWorkflowCommand(['resume', 'sess-stale'], ctx);

    expect(handled).toBe(true);
    expect(printed.join('\n')).toContain('Resumed session: sess-stale');
  });
});


test.each(['resume', 'save', 'fork'])('%s leaves identity and transcript alone during active work', async sub => {
  const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
  sm.save('target', [{ role: 'user', content: 'target' }], { title: 'target', timestamp: 1, model: '', provider: '' });
  const printed: string[] = [];
  const ctx = makeCtx(sm, printed);
  ctx.session.conversationManager.addUserMessage('active turn');
  ctx.isGenerating = () => true;
  await handleSessionWorkflowCommand([sub, 'target'], ctx);
  expect(ctx.session.runtime.sessionId).toBe('current-session');
  expect(ctx.session.conversationManager.getLastUserMessage()).toBe('active turn');
  expect(sm.load('target').messages[0]).toMatchObject({ content: 'target' });
  expect(printed.join(' ')).toContain('still running');
});

test.each(['save', 'fork'])('%s preserves rewind anchors and failed-turn sidecars across reload', async sub => {
  const surface = makeTestSurface(tmpDir);
  const sm = new SessionManager(tmpDir, { surface });
  const ctx = makeCtx(sm, []);
  ctx.session.conversationManager.addUserMessage('source');
  ctx.session.conversationManager.workTree.recordTurnOutcome({ index: 0, fingerprint: '1:x', outcome: 'failed' });
  recordTurnAnchor('current-session', { turnId: 'copied-turn', label: 'source', messageCount: 1, at: 1 });
  await handleSessionWorkflowCommand([sub, 'copied'], ctx);
  const destination = ctx.session.runtime.sessionId;
  expect(destination).not.toBe('current-session');
  expect(getTurnAnchors(destination)[0]?.turnId).toBe('copied-turn');
  clearTurnAnchors(destination);
  expect(restoreTurnAnchors(destination, surface)).toBe(1);
  expect(loadWorkTreeTurnOutcomes(surface.sessionsDir, destination)[0]?.outcome).toBe('failed');
  clearTurnAnchors(destination); clearTurnAnchors('current-session');
});

test('a turn starting during model lookup prevents a resume commit', async () => {
  const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
  sm.save('target', [{ role: 'user', content: 'target' }], { title: 'target', timestamp: 1, model: 'm', provider: '' });
  const ctx = makeCtx(sm, []);
  ctx.session.conversationManager.addUserMessage('active source');
  let busy = false;
  ctx.isGenerating = () => busy;
  ctx.clients!.providerApi!.selectModel = async () => { busy = true; return { registryKey: 'm', providerId: 'p' } as never; };
  await handleSessionWorkflowCommand(['resume', 'target'], ctx);
  expect(ctx.session.runtime.sessionId).toBe('current-session');
  expect(ctx.session.conversationManager.getLastUserMessage()).toBe('active source');
});
