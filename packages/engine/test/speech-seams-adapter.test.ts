/**
 * The speech-seam adapter settles only when every boundary is decided.
 */
import { describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createSpeechSeamsAdapter } from '../platform/src/platform/judgment-browser/batteries/speech-seams.js';

const adapter = createSpeechSeamsAdapter((async () => { throw new Error('unused'); }) as never);
const raw = { paragraph: 'Go. Go.', candidates: [3, 7], nextCursor: null };

async function project(probabilityFor: (seam: string) => number) {
  const port = fakePort(name => noulAnswer(probabilityFor(name)));
  const signal = new AbortController().signal;
  const state = await adapter.run(port.port, raw, { signal } as never);
  return adapter.project(state as never);
}

describe('speech seam adapter projection', () => {
  test('boundaries that all read yes settle with their offsets', async () => {
    const projected = await project(() => 0.99) as { status: string; value?: { endOffsets: number[] } };
    expect(projected.status).toBe('settled');
    expect(projected.value?.endOffsets).toEqual([3, 7]);
  });

  test('one undecided boundary holds the whole paragraph, with no offsets', async () => {
    const projected = await project((seam) => (seam.includes('seam_1') ? 0.5 : 0.99)) as { status: string; value?: unknown };
    expect(projected.status).toBe('held');
    expect(projected.value).toBeUndefined();
  });
});
