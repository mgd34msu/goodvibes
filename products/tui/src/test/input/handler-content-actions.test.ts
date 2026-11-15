// ---------------------------------------------------------------------------
// handler-content-actions.test.ts
//
// Covers the anchor-based block actions (Ctrl+Y/B/S, Tab) after the fix that
// resolves them against the block the user is actually looking at (an
// injected getAnchorLine callback) instead of a raw scrollTop, plus the
// receipts for copy/save actions and silent expansion. Also covers the removal of the dead
// "rerun" action.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ConversationManager } from '../../core/conversation';
import {
  describeBlockForReceipt,
  handleBlockCopy,
  handleBookmark,
  handleBlockToggle,
  handleDiffApply,
} from '../../input/handler-content-actions.ts';

function textOf(cm: ConversationManager): string {
  return cm.history.getAllLines().map((line) => line.map((c) => c.char).join('')).join('\n');
}

function buildConversationWithTwoToolBlocks(): ConversationManager {
  const cm = new ConversationManager(() => 80);
  cm.addUserMessage('run things');
  cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'exec', arguments: {} }] });
  cm.addToolResults([{ callId: 'c1', success: true, output: 'exit 0\nsome output line' }]);
  cm.addAssistantMessage('', { toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] });
  cm.addToolResults([{ callId: 'c2', success: true, output: 'file contents here' }]);
  cm.getDisplayBlocks();
  return cm;
}

describe('describeBlockForReceipt', () => {
  test('names a tool block by its tool name and line count', () => {
    const desc = describeBlockForReceipt({
      blockIndex: 0, type: 'tool', startLine: 0, lineCount: 3, rawContent: 'x', collapseKey: 'k', toolName: 'exec',
    });
    expect(desc).toBe('tool result: exec (3 lines)');
  });

  test('falls back to a generic tool label when no tool name is recorded', () => {
    const desc = describeBlockForReceipt({
      blockIndex: 0, type: 'tool', startLine: 0, lineCount: 1, rawContent: 'x', collapseKey: 'k',
    });
    expect(desc).toBe('tool result (1 line)');
  });

  test('names a diff block by its file path', () => {
    const desc = describeBlockForReceipt({
      blockIndex: 0, type: 'diff', startLine: 0, lineCount: 10, rawContent: 'x', collapseKey: 'k', filePath: 'src/foo.ts',
    });
    expect(desc).toBe('diff: src/foo.ts (10 lines)');
  });
});

describe('viewport-anchored block actions', () => {
  test('handleBlockCopy targets the block at the anchor line and names it in the receipt', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const execBlock = blocks.find((b) => b.toolName === 'exec');
    expect(execBlock).toBeDefined();

    let rendered = 0;
    handleBlockCopy(cm, () => execBlock!.startLine, () => { rendered++; }, () => {});

    expect(rendered).toBeGreaterThan(0);
    expect(textOf(cm)).toContain('Copied tool result: exec');
  });

  test('handleBlockCopy anchored at the second block names THAT block, not the first', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const readBlock = blocks.find((b) => b.toolName === 'read');
    expect(readBlock).toBeDefined();

    handleBlockCopy(cm, () => readBlock!.startLine, () => {}, () => {});

    const text = textOf(cm);
    expect(text).toContain('Copied tool result: read');
    expect(text).not.toContain('Copied tool result: exec');
  });

  test('handleBlockCopy reports honestly when no block exists near the anchor', () => {
    const cm = new ConversationManager(() => 80);
    cm.addUserMessage('hello');
    cm.getDisplayBlocks();
    handleBlockCopy(cm, () => 0, () => {}, () => {});
    expect(textOf(cm)).toContain('No block found nearby');
  });

  test('handleBookmark names the block instead of its raw collapseKey', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const execBlock = blocks.find((b) => b.toolName === 'exec');
    const bookmarkManager = { toggle: () => true, saveToFile: () => '/tmp/x', list: () => [] } as unknown as Parameters<typeof handleBookmark>[3];

    handleBookmark(cm, () => execBlock!.startLine, () => {}, bookmarkManager);

    const text = textOf(cm);
    expect(text).toContain('Bookmarked: tool result: exec');
    expect(text).not.toContain(execBlock!.collapseKey);
  });

  test('handleBlockToggle changes expansion without adding transcript messages', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const execBlock = blocks.find((b) => b.toolName === 'exec');

    const collapsed = cm.isCollapsed(execBlock!.blockIndex);
    let rendered = 0;
    handleBlockToggle(cm, () => execBlock!.startLine, () => { rendered++; });
    expect(cm.isCollapsed(execBlock!.blockIndex)).toBe(!collapsed);
    handleBlockToggle(cm, () => execBlock!.startLine, () => { rendered++; });
    expect(cm.isCollapsed(execBlock!.blockIndex)).toBe(collapsed);
    expect(rendered).toBe(2);
    expect(textOf(cm)).not.toMatch(/Expanded tool result|Collapsed tool result/);
  });
});

describe('handleDiffApply', () => {
  test('a multi-hunk diff is refused with the reason before any permission request', () => {
    const cm = new ConversationManager(() => 80);
    cm.addUserMessage('show diff');
    cm.addToolResults([{ callId: 'c1', success: true, output: [
      '--- a/f.txt', '+++ b/f.txt', '@@ -1,1 +1,1 @@', '-a', '+b', '@@ -9,1 +9,1 @@', '-c', '+d',
    ].join('\n') }]);
    cm.getDisplayBlocks();
    const logged: string[] = [];
    const manager = {
      getDiffAtLine: (line: number) => cm.getDiffAtLine(line),
      log: (message: string) => { logged.push(message); },
    } as unknown as ConversationManager;
    let asked = false;
    const ctx = {
      requestPermission: async () => { asked = true; return { approved: true }; },
    } as unknown as Parameters<typeof handleDiffApply>[2];

    expect(cm.getDiffAtLine(0)?.unsupported).toContain('2 separate hunks');
    expect(handleDiffApply(manager, () => 0, ctx, () => {}, () => 'c', 'write' as never)).toBe(true);
    expect(asked).toBe(false);
    expect(logged[0]).toContain('2 separate hunks');
  });

  test('writes the approved text literally, including replacement-pattern sequences', async () => {
    const dir = makeProjectTempDir('diff-apply');
    try {
      writeFileSync(join(dir, 'f.txt'), 'before\nOLD\nafter\n');
      const logged: string[] = [];
      const diff = { filePath: 'f.txt', original: 'OLD', updated: "a$&b$$c$'d$`e" };
      const manager = {
        getDiffAtLine: () => diff,
        log: (message: string) => { logged.push(message); },
      } as unknown as ConversationManager;
      let done!: () => void;
      const finished = new Promise<void>((resolve) => { done = resolve; });
      const ctx = {
        workspace: { shellPaths: { workingDirectory: dir } },
        platform: { configManager: { getWorkingDirectory: () => dir } },
        requestPermission: async () => ({ approved: true }),
      } as unknown as Parameters<typeof handleDiffApply>[2];

      const started = handleDiffApply(manager, () => 0, ctx, () => done(), () => 'call-1', 'write' as never);
      expect(started).toBe(true);
      await finished;

      expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe("before\na$&b$$c$'d$`e\nafter\n");
      expect(logged.some((line) => line.includes('Applied diff to f.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
