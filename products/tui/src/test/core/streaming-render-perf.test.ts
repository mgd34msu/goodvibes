// ---------------------------------------------------------------------------
// streaming-render-perf.test.ts
//
// 1. Byte-identical output: streamed-then-finalized == single-shot render.
// 2. Throttle effectiveness: renderMarkdown is NOT called on every delta when
//    deltas arrive faster than 16ms.
// 3. First delta always renders (no silent drop on the very first token).
// ---------------------------------------------------------------------------

import { describe, test, expect, mock } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { createTestConfigManager } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// Byte-identical output: streamed vs single-shot
// ---------------------------------------------------------------------------

/**
 * lineToString, extract plain text from a Line (Cell[]).
 * Used to compare render output without importing test setup.
 */
function lineToString(line: { char: string }[]): string {
  return line.map(c => c.char).join('');
}

describe('streaming render: byte-identical final output', () => {
  test('streamed-then-finalized getDisplayBlocks matches single-shot addAssistantMessage', () => {
    const WIDTH = 80;
    const CONTENT = 'Hello **world**! This is a streaming test.';

    // --- Streamed path ---
    const cmStreamed = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStreamed.suppressSplash = true;
    cmStreamed.addUserMessage('q');
    cmStreamed.startStreamingBlock();
    // Simulate accumulating deltas
    const parts = ['H', 'Hello ', 'Hello **world', 'Hello **world**! This is a streaming test.'];
    for (const part of parts) {
      cmStreamed.updateStreamingBlock(part);
    }
    cmStreamed.finalizeStreamingBlock();
    // The orchestrator then adds the final message (identical to last accumulated)
    cmStreamed.addAssistantMessage(CONTENT);
    const streamedLines = cmStreamed.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    // --- Single-shot path ---
    const cmStatic = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStatic.suppressSplash = true;
    cmStatic.addUserMessage('q');
    cmStatic.addAssistantMessage(CONTENT);
    const staticLines = cmStatic.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    // Final output must be byte-identical: same number of lines, same text per line.
    expect(streamedLines.length).toBe(staticLines.length);
    for (let i = 0; i < staticLines.length; i++) {
      expect(streamedLines[i]).toBe(staticLines[i]);
    }
  });

  test('multiline markdown streamed-then-finalized matches single-shot', () => {
    const WIDTH = 80;
    const CONTENT = '# Header\n\nParagraph one.\n\n```ts\nconst x = 1;\n```\n\nEnd.';

    const cmStreamed = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStreamed.suppressSplash = true;
    cmStreamed.addUserMessage('q');
    cmStreamed.startStreamingBlock();
    // Stream in chunks
    for (let i = 1; i <= CONTENT.length; i += 10) {
      cmStreamed.updateStreamingBlock(CONTENT.slice(0, i));
    }
    cmStreamed.finalizeStreamingBlock();
    cmStreamed.addAssistantMessage(CONTENT);
    const streamedLines = cmStreamed.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    const cmStatic = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStatic.suppressSplash = true;
    cmStatic.addUserMessage('q');
    cmStatic.addAssistantMessage(CONTENT);
    const staticLines = cmStatic.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    expect(streamedLines.length).toBe(staticLines.length);
    for (let i = 0; i < staticLines.length; i++) {
      expect(streamedLines[i]).toBe(staticLines[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// Throttle effectiveness: renderMarkdown not called on every sub-16ms delta
// ---------------------------------------------------------------------------

describe('streaming render: 16ms throttle gate', () => {

  test('burst of deltas within 16ms does not re-render every token', () => {
    // Date.now is the throttle's only clock, so a fixed value makes the window exact.
    let mockNow = 1000;
    const origDateNow = Date.now;
    Date.now = () => mockNow;

    try {
      const cm = new ConversationManager(() => 80, createTestConfigManager());
      cm.suppressSplash = true;
      cm.addUserMessage('q');
      cm.startStreamingBlock();

      // Each delta carries one more paragraph, so what the display shows says which delta was rendered last.
      const upTo = (n: number) => Array.from({ length: n + 1 }, (_, i) => `para${i}marker`).join('\n\n');
      const shown = () => cm.getDisplayBlocks().map(l => lineToString(l as { char: string }[])).join('\n');

      // The first delta always renders.
      cm.updateStreamingBlock(upTo(0));
      expect(shown()).toContain('para0marker');

      // Deltas inside the 16ms window are throttled: none of their text is rendered.
      mockNow = 1005;
      for (let i = 1; i <= 10; i++) cm.updateStreamingBlock(upTo(i));
      const throttled = shown();
      expect(throttled).toContain('para0marker');
      expect(throttled).not.toContain('para1marker');
      expect(throttled).not.toContain('para10marker');

      // Past the window the next delta renders everything accumulated so far.
      mockNow = 1017;
      cm.updateStreamingBlock(upTo(11));
      const rendered = shown();
      expect(rendered).toContain('para1marker');
      expect(rendered).toContain('para11marker');
    } finally {
      Date.now = origDateNow;
    }
  });

  test('finalizeStreamingBlock resets throttle and triggers full rebuild', () => {
    const cm = new ConversationManager(() => 80, createTestConfigManager());
    cm.suppressSplash = true;
    cm.addUserMessage('q');
    cm.startStreamingBlock();
    cm.updateStreamingBlock('partial content');
    cm.finalizeStreamingBlock();
    // After finalize, addAssistantMessage marks dirty; getDisplayBlocks rebuilds.
    cm.addAssistantMessage('final content');
    const lines = cm.getDisplayBlocks();
    const text = lines.map(l => lineToString(l as { char: string }[])).join(' ');
    expect(text).toContain('final');
  });

  test('multiple streaming cycles each reset the throttle independently', () => {
    const cm = new ConversationManager(() => 80, createTestConfigManager());
    cm.suppressSplash = true;
    cm.addUserMessage('q1');
    // First streaming cycle
    cm.startStreamingBlock();
    cm.updateStreamingBlock('first streaming response');
    cm.finalizeStreamingBlock();
    cm.addAssistantMessage('first streaming response');
    // Second streaming cycle, throttle must be reset by startStreamingBlock
    cm.addUserMessage('q2');
    cm.startStreamingBlock();
    cm.updateStreamingBlock('second streaming response');
    cm.finalizeStreamingBlock();
    cm.addAssistantMessage('second streaming response');
    const lines = cm.getDisplayBlocks();
    const text = lines.map(l => lineToString(l as { char: string }[])).join(' ');
    expect(text).toContain('second');
  });
});
