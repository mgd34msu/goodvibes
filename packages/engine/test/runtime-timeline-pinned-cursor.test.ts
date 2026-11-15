import { describe, expect, test } from 'bun:test';
import { TimelineBuffer } from './_helpers/runtime-seam.ts';

const event = (n: number) => ({ capturedAt: n, domain: 'session', transitionId: n, snapshot: { n } });

describe('TimelineBuffer cursor pinned while the ring is full', () => {
  test('keeps showing the same event as older ones are evicted', () => {
    const buffer = new TimelineBuffer(5);
    for (let i = 1; i <= 5; i++) buffer.append(event(i));
    buffer.seekTo(3);
    const pinned = buffer.getCurrentEvent()!.seq;

    buffer.append(event(6));
    expect(buffer.getCurrentEvent()!.seq).toBe(pinned);
    expect(buffer.isLive).toBe(false);
  });

  test('falls to the oldest retained event once the pinned one itself is evicted', () => {
    const buffer = new TimelineBuffer(3);
    for (let i = 1; i <= 3; i++) buffer.append(event(i));
    buffer.seekTo(0);

    buffer.append(event(4));
    expect(buffer.getCurrentEvent()!.seq).toBe(buffer.getAt(0)!.seq);
    expect(buffer.isLive).toBe(false);
  });

  test('a live cursor stays live as the ring evicts', () => {
    const buffer = new TimelineBuffer(3);
    for (let i = 1; i <= 6; i++) buffer.append(event(i));
    expect(buffer.isLive).toBe(true);
  });
});
