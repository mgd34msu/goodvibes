import { describe, expect, test } from 'bun:test';
import { ExportQueue } from '../platform/src/platform/runtime/telemetry/exporters/queue.ts';
import type { ReadableSpan } from '../platform/src/platform/runtime/telemetry/types.ts';

describe('ExportQueue drain', () => {
  test('drain waits for a batch that is still exporting', async () => {
    let exported = 0;
    const queue = new ExportQueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      exported += 1;
    }, { drainTimeoutMs: 2_000 });
    queue.enqueue([{ name: 'span' } as unknown as ReadableSpan]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await queue.shutdown();
    expect(exported).toBe(1);
  });
});
