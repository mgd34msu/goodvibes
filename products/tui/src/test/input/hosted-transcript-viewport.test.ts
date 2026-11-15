import { describe, expect, test } from 'bun:test';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import { HostedTranscriptViewport } from '../../input/hosted-transcript-viewport.ts';
import { HostedSessionFeed } from '../../views/hosted-session-feed.ts';

const record: HostedSessionRecord = {
  id: 'hosted-a', workspaceRoot: '/owned/project', title: 'Session', status: 'running', detachPolicy: 'survive', effectiveDetachPolicy: 'survive',
  attachedClients: ['owned-tui'], createdAt: 1, updatedAt: 2, turnCount: 1, messageCount: 2, restoredFromDisk: false, contractIds: [],
};

function feedWith(count: number): HostedSessionFeed {
  const feed = new HostedSessionFeed();
  feed.attach(record, Array.from({ length: count }, (_, index) => ({ role: 'assistant' as const, content: `entry-${String(index).padStart(3, '0')}` })));
  return feed;
}

const text = (lines: ReturnType<HostedTranscriptViewport['render']>): string => lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');

describe('HostedTranscriptViewport', () => {
  test('follows the newest rows until moved, then keeps its place when rows are appended', () => {
    const feed = feedWith(40);
    const viewport = new HostedTranscriptViewport();
    const generation = feed.getGeneration();

    expect(text(viewport.render(feed.getState(), generation, 60, 10))).toContain('entry-039');
    expect(viewport.following).toBe(true);

    viewport.oldest();
    const reading = text(viewport.render(feed.getState(), generation, 60, 10));
    expect(reading).toContain('entry-000');
    expect(viewport.following).toBe(false);
    expect(viewport.position.above).toBe(0);

    feed.note('appended-while-reading');
    expect(text(viewport.render(feed.getState(), generation, 60, 10))).toBe(reading);
    expect(viewport.position.below).toBeGreaterThan(0);

    viewport.latest();
    expect(text(viewport.render(feed.getState(), generation, 60, 10))).toContain('appended-while-reading');
    expect(viewport.following).toBe(true);
  });

  test('a new attachment generation starts again from the tail', () => {
    const feed = feedWith(40);
    const viewport = new HostedTranscriptViewport();
    viewport.render(feed.getState(), 1, 60, 10);
    viewport.oldest();
    expect(viewport.following).toBe(false);

    viewport.render(feed.getState(), 2, 60, 10);

    expect(viewport.following).toBe(true);
  });
});
