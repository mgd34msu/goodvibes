import { describe, expect, test } from 'bun:test';
import {
  MAX_REFUSED_BODY_DRAIN_BYTES,
  readTextBodyWithinLimit,
} from '../platform/src/platform/utils/request-body.js';

function endlessBody(chunkBytes: number, state: { pulled: number; cancelled: boolean }): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(chunkBytes);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  });
}

describe('readTextBodyWithinLimit', () => {
  test('refuses an endless oversized body after a bounded drain and cancels the sender', async () => {
    const state = { pulled: 0, cancelled: false };
    const req = new Request('http://localhost/x', { method: 'POST', body: endlessBody(1_000_000, state), duplex: 'half' } as RequestInit);
    const result = await readTextBodyWithinLimit(req, 1000);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(MAX_REFUSED_BODY_DRAIN_BYTES + 4_000_000);
  });

  test('still reads a body within the limit', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: 'hello' });
    expect(await readTextBodyWithinLimit(req, 1000)).toBe('hello');
  });
});
