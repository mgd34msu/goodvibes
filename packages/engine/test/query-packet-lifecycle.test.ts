import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueryTool } from '../platform/src/platform/tools/query/index.ts';
import { createPacketTool } from '../platform/src/platform/tools/packet/index.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'lifecycle-'));
type Tool = { execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> };

describe('query tool lifecycle', () => {
  test('answer and close follow open -> answered -> closed; closed is final', async () => {
    const tool = createQueryTool(dir()) as unknown as Tool;
    await tool.execute({ mode: 'ask', queryId: 'q1', prompt: 'why?' });
    expect((await tool.execute({ mode: 'answer', queryId: 'q1', answer: 'because' })).success).toBe(true);
    expect((await tool.execute({ mode: 'close', queryId: 'q1', resolution: 'done' })).success).toBe(true);

    const reopen = await tool.execute({ mode: 'answer', queryId: 'q1', answer: 'again' });
    expect(reopen.success).toBe(false);
    expect(reopen.error).toContain('closed');
    expect(reopen.error).toContain('final');
    const again = await tool.execute({ mode: 'close', queryId: 'q1' });
    expect(again.success).toBe(false);
    const shown = JSON.parse((await tool.execute({ mode: 'show', queryId: 'q1' })).output!);
    expect(shown.status).toBe('closed');
    expect(shown.hasAnswer).toBe(true);
  });

  test('an open query can be closed directly, and an answer can be revised until it is closed', async () => {
    const tool = createQueryTool(dir()) as unknown as Tool;
    await tool.execute({ mode: 'ask', queryId: 'q2', prompt: 'p' });
    expect((await tool.execute({ mode: 'close', queryId: 'q2' })).success).toBe(true);
    await tool.execute({ mode: 'ask', queryId: 'q3', prompt: 'p' });
    await tool.execute({ mode: 'answer', queryId: 'q3', answer: 'a' });
    // An answer can still be revised while the query is not closed.
    expect((await tool.execute({ mode: 'answer', queryId: 'q3', answer: 'b' })).success).toBe(true);
    await tool.execute({ mode: 'close', queryId: 'q3' });
    const refused = await tool.execute({ mode: 'close', queryId: 'q3' });
    expect(refused.success).toBe(false);
    expect(refused.error).toBe('query is closed, which is final; it cannot become closed');
  });
});

describe('packet tool lifecycle', () => {
  test('a repeated publish does not re-stamp publishedAt', async () => {
    const tool = createPacketTool(dir()) as unknown as Tool;
    await tool.execute({ mode: 'create', packetId: 'p1', title: 't', summary: 's' });
    const first = JSON.parse((await tool.execute({ mode: 'publish', packetId: 'p1' })).output!);
    await new Promise(r => setTimeout(r, 5));
    const second = await tool.execute({ mode: 'publish', packetId: 'p1' });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already published');
    const shown = JSON.parse((await tool.execute({ mode: 'show', packetId: 'p1' })).output!);
    expect(shown.publishedAt).toBe(first.publishedAt);
  });
});
