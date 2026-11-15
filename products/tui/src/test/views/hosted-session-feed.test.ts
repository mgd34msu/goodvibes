import { describe, test, expect } from 'bun:test';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import { HostedSessionFeed } from '../../views/hosted-session-feed.ts';
import type { HostedSessionStreamEvent } from '../../runtime/client/hosted-session-stream.ts';

const RECORD: HostedSessionRecord = {
  id: 'hosted-1', workspaceRoot: '/tmp/w', title: 't', status: 'running', detachPolicy: null,
  effectiveDetachPolicy: 'kill', attachedClients: [], createdAt: 1, updatedAt: 2, turnCount: 1,
  messageCount: 1, restoredFromDisk: false, contractIds: [],
};

function event(domain: 'turn' | 'tools', type: string, payload: Record<string, unknown> = {}): HostedSessionStreamEvent {
  return { domain, type, sessionId: 'hosted-1', at: 10, payload };
}

function feedWithRunningTool(): HostedSessionFeed {
  const feed = new HostedSessionFeed();
  feed.attach(RECORD, []);
  feed.apply(event('tools', 'TOOL_EXECUTING', { callId: 'c1', tool: 'bash' }));
  expect(feed.getState().runningToolCalls.map((c) => c.callId)).toEqual(['c1']);
  expect(feed.getState().rows.some((r) => r.streaming)).toBe(true);
  return feed;
}

function expectSettled(feed: HostedSessionFeed): void {
  const state = feed.getState();
  expect(state.runningToolCalls).toEqual([]);
  expect(state.rows.some((r) => r.streaming)).toBe(false);
  expect(state.rows.find((r) => r.callId === 'c1')!.text).toContain('bash: ended without a result');
}

describe('hosted session feed does not leave a tool running that nothing will finish', () => {
  test('a cancelled turn', () => {
    const feed = feedWithRunningTool();
    feed.apply(event('turn', 'TURN_CANCEL', { reason: 'user' }));
    expectSettled(feed);
  });

  test('a turn error', () => {
    const feed = feedWithRunningTool();
    feed.apply(event('turn', 'TURN_ERROR', { error: 'boom' }));
    expectSettled(feed);
  });

  test('a dropped stream', () => {
    const feed = feedWithRunningTool();
    feed.setStreaming(false, 'the stream dropped');
    expectSettled(feed);
  });

  test('a terminated session', () => {
    const feed = feedWithRunningTool();
    feed.applyLifecycle({ event: 'hosted-session-terminated', session: { ...RECORD, status: 'terminated', terminatedReason: 'killed' } });
    expectSettled(feed);
  });

  test('a tool that reports its own result is unaffected', () => {
    const feed = feedWithRunningTool();
    feed.apply(event('tools', 'TOOL_SUCCEEDED', { callId: 'c1', tool: 'bash' }));
    feed.apply(event('turn', 'TURN_CANCEL'));
    expect(feed.getState().rows.find((r) => r.callId === 'c1')!.text).toBe('bash: done');
  });
});
