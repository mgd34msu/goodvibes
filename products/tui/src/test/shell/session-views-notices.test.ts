import { afterEach, describe, expect, test } from 'bun:test';
import type { ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { SessionViews } from '../../shell/session-views.ts';

const views: SessionViews[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); });

type Record = NonNullable<ReturnType<ProcessManager['getStatus']>>;
function setup(stdout: string[], options: { stop?: boolean; copy?: (text: string) => boolean | void } = {}) {
  let record: Record | undefined = { id: 'p1', pid: 42, cmd: 'serve', startTime: 0, stdout, stderr: [], done: false, exitCode: null, killDeadline: null };
  const copied: string[] = [];
  const view = new SessionViews({
    conversation: { laneColorOf: () => 1, getWorkTreeSources: () => ({}), getTreeGlyphSet: () => 'rounded' },
    agentManager: { list: () => [], getStatus: () => null, getConversationSnapshot: () => [] },
    processManager: { list: () => record ? [{ id: record.id, pid: record.pid, cmd: record.cmd, done: record.done, status: 'running' }] : [], getStatus: () => record, stop: () => options.stop ?? false },
    fleetNodes: () => [], steer: () => ({ queued: true, messageId: 'unused' }), killAgent: () => [], mainBusy: () => false, mainModel: () => '', promptText: () => '', requestRender: () => {}, pollMs: 0,
    copy: options.copy ?? ((text) => { copied.push(text); }),
  });
  views.push(view);
  view.open({ kind: 'process', id: 'p1' });
  view.poll();
  const notice = () => view.frame(100)?.footer.notice;
  return { view, copied, notice, remove() { record = undefined; }, restore() { record = { id: 'p1', pid: 42, cmd: 'serve', startTime: 0, stdout, stderr: [], done: false, exitCode: null, killDeadline: null }; } };
}

describe('process view notices', () => {
  test('copying output that does not exist says there is nothing to copy', () => {
    const s = setup([]);
    s.view.copyOutput();
    expect(s.notice()?.text).toContain('Nothing to copy');
    expect(s.copied).toEqual([]);
  });
  test('copying real output says it was sent to the terminal, not that it was copied', () => {
    const s = setup(['one\ntwo\n']);
    s.view.copyOutput();
    expect(s.copied).toEqual(['one\ntwo']);
    expect(s.notice()?.text).toContain('Sent 2 lines');
    expect(s.notice()?.text).toContain('OSC 52');
  });
  test('a copy that reports failure is an error notice', () => {
    const s = setup(['one\n'], { copy: () => false });
    s.view.copyOutput();
    expect(s.notice()).toMatchObject({ tone: 'error' });
    expect(s.notice()?.text).toContain('could not be sent');
  });
  test('a process that cannot be stopped is reported as an error', () => {
    const s = setup(['one\n'], { stop: false });
    s.view.pressStop();
    s.view.pressStop();
    expect(s.notice()).toMatchObject({ tone: 'error' });
    expect(s.notice()?.text).toContain('could not be stopped');
  });
  test('scroll positions of a process that is gone are dropped', () => {
    const s = setup(Array.from({ length: 200 }, (_, i) => `line ${i}\n`));
    s.view.frame(100)?.body(10);
    s.view.scroll(5);
    expect(s.view.scrolledBack()).toBe(true);
    s.remove();
    s.view.noteEnded();
    s.restore();
    expect(s.view.scrolledBack()).toBe(false);
  });
});
