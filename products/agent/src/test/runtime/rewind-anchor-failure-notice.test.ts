/**
 * A rewind point that could not be saved is said once per session, not only
 * logged at debug, so a later /rewind that finds no anchor has a stated cause.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';
import { recordCompletedTurnAnchor } from '../../runtime/rewind-anchor-wiring.ts';

function conversation(notices: string[]) {
  return {
    getLastUserMessage: () => 'rewrite the parser',
    getMessageCount: (): number => { throw new Error('conversation unavailable'); },
    addNotice: (message: string) => { notices.push(message); },
  };
}

describe('rewind anchor recording failures', () => {
  test('a failing anchor capture tells the person once per session and never throws', () => {
    const notices: string[] = [];
    const surface = {} as SessionSurface;

    for (const turnId of ['t1', 't2']) {
      recordCompletedTurnAnchor({ sessionId: 'sess-notice-1', turnId, conversation: conversation(notices), surface });
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('rewind point');

    recordCompletedTurnAnchor({ sessionId: 'sess-notice-2', turnId: 't1', conversation: conversation(notices), surface });
    expect(notices).toHaveLength(2);
  });

  test('a sidecar that cannot be written tells the person once, and the turn is not broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchor-notice-'));
    try {
      // A file where the sessions directory should be makes the write fail.
      const blocker = join(dir, 'not-a-directory');
      writeFileSync(blocker, '');
      const surface = { sessionsDir: join(blocker, 'sessions') } as SessionSurface;
      const notices: string[] = [];
      const view = { getLastUserMessage: () => 'fix the build', getMessageCount: () => 4, addNotice: (m: string) => { notices.push(m); } };

      recordCompletedTurnAnchor({ sessionId: 'sess-unwritable', turnId: 't1', conversation: view, surface });
      recordCompletedTurnAnchor({ sessionId: 'sess-unwritable', turnId: 't2', conversation: view, surface });

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('sidecar could not be written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
