import { describe, expect, test } from 'bun:test';
import { WorkflowManager } from '../platform/src/platform/tools/workflow/index.ts';

describe('WorkflowManager.cancel', () => {
  test('refuses a finished workflow and leaves it untouched', () => {
    const wm = new WorkflowManager();
    const wf = wm.start('review_only', 't');
    expect(wm.transition(wf.id, 'complete').success).toBe(true);
    const completedAt = wf.completedAt;
    expect(wm.cancelRefusal(wf.id)).toContain('already finished');
    expect(wm.cancel(wf.id)).toBe(false);
    expect(wf.cancelled).toBeUndefined();
    expect(wf.completedAt).toBe(completedAt);
  });

  test('cancels a running workflow once; a second cancel is refused', () => {
    const wm = new WorkflowManager();
    const wf = wm.start('fix_loop', 't');
    expect(wm.cancel(wf.id)).toBe(true);
    const completedAt = wf.completedAt;
    expect(wm.cancelRefusal(wf.id)).toContain('already cancelled');
    expect(wm.cancel(wf.id)).toBe(false);
    expect(wf.completedAt).toBe(completedAt);
  });
});
