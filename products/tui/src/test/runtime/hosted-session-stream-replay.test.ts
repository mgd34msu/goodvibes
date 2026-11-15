/**
 * The daemon replays its newest buffered frames to every new event stream, so
 * frames of history the attach already backfilled arrive a second time. A
 * subscription told how far the backfill reaches drops them.
 */
import { describe, expect, test } from 'bun:test';
import { newestHistoryTime, watchHostedSession, type HostedSessionStreamEvent } from '../../runtime/client/hosted-session-stream.ts';

type Frame = { type: string; ts: number; sessionId?: string };

/**
 * Serves the frames as one SSE body, ending with a lifecycle notice for the same
 * session. Frames are read in order, so that notice arriving means every frame
 * before it has been delivered or dropped.
 */
async function collect(options: { notBefore?: number }, frames: Frame[]): Promise<string[]> {
  const body = frames
    .map((frame) => `event: turn\ndata: ${JSON.stringify({ type: frame.type, sessionId: frame.sessionId ?? 'hosted-1', ts: frame.ts, payload: {} })}\n\n`)
    .join('')
    + `event: hosted-session-update\ndata: ${JSON.stringify({ event: 'hosted-session-updated', session: { id: 'hosted-1' } })}\n\n`;
  let requests = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (++requests === 1) return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as unknown as typeof fetch;
  const seen: HostedSessionStreamEvent[] = [];
  let allRead!: () => void;
  const finished = new Promise<void>((resolve) => { allRead = resolve; });
  const subscription = await watchHostedSession({
    baseUrl: 'http://127.0.0.1:3421',
    sessionId: 'hosted-1',
    fetchImpl,
    onEvent: (event) => { seen.push(event); },
    onLifecycle: () => allRead(),
    ...options,
  });
  await finished;
  subscription?.close();
  return seen.map((event) => `${event.type}@${event.at}`);
}

describe('a hosted session stream opened after a backfill', () => {
  const FRAMES = [
    { type: 'TURN_SUBMITTED', ts: 100 },
    { type: 'STREAM_DELTA', ts: 150 },
    { type: 'TURN_COMPLETED', ts: 200 },
    { type: 'TURN_SUBMITTED', ts: 300 },
  ];

  test('drops replayed frames the backfill already shows, and keeps newer ones', async () => {
    expect(await collect({ notBefore: 200 }, FRAMES)).toEqual(['TURN_SUBMITTED@300']);
  });

  test('keeps every frame when the history carried no timestamps (notBefore 0 or unset)', async () => {
    expect(await collect({ notBefore: 0 }, FRAMES)).toHaveLength(4);
    expect(await collect({}, FRAMES)).toHaveLength(4);
  });
});

describe('the notBefore an attach hands its stream', () => {
  test('is the newest backfilled message time, so replayed frames of that history are dropped', async () => {
    const history = [{ at: 120 }, { at: 200 }, {}, { at: 150 }];
    const notBefore = newestHistoryTime(history);
    expect(notBefore).toBe(200);
    expect(await collect({ notBefore }, [
      { type: 'TURN_SUBMITTED', ts: 100 },
      { type: 'TURN_COMPLETED', ts: 200 },
      { type: 'TURN_SUBMITTED', ts: 250 },
    ])).toEqual(['TURN_SUBMITTED@250']);
  });

  test('is 0 when no message carries a time, which keeps every frame', () => {
    expect(newestHistoryTime([{}, { at: undefined }])).toBe(0);
    expect(newestHistoryTime([])).toBe(0);
  });
});
