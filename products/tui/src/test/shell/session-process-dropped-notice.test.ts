import { describe, expect, test } from 'bun:test';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { SessionViews } from '../../shell/session-views.ts';

const text = (lines: readonly Line[]) => lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');

describe('process view scrolling', () => {
  test('scrolling to the top of a log that dropped lines shows the "no longer kept" notice', () => {
    const record = {
      id: 'p1', pid: 7, cmd: 'serve', startTime: 0, stdout: [`${Array.from({ length: 5100 }, (_, i) => `line ${i}`).join('\n')}\n`], stderr: [],
      done: false, exitCode: null, killDeadline: null,
    };
    const views = new SessionViews({
      conversation: { laneColorOf: () => 1, getWorkTreeSources: () => ({}), getTreeGlyphSet: () => 'rounded' },
      agentManager: { list: () => [], getStatus: () => null, getConversationSnapshot: () => [] },
      processManager: { list: () => [{ id: 'p1', pid: 7, cmd: 'serve', done: false, status: 'running' }], getStatus: () => record, stop: () => false },
      fleetNodes: () => [], steer: () => ({ queued: true, messageId: 'unused' }), killAgent: () => [], mainBusy: () => false, mainModel: () => '', promptText: () => '', requestRender: () => {}, pollMs: 0,
    } as unknown as ConstructorParameters<typeof SessionViews>[0]);
    try {
      views.open({ kind: 'process', id: 'p1' });
      views.poll();
      expect(views.log.dropped('p1')).toBeGreaterThan(0);
      views.frame(100)!.body(20);
      views.scroll(1_000_000);
      expect(text(views.frame(100)!.body(20))).toContain('no longer kept');
    } finally {
      views.dispose();
    }
  });
});
