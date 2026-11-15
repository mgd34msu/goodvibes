import { usePresentationReadings } from '../helpers/presentation-readings.ts';
import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { appendConversationMessages, isNavigableSystemContent, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';

import { BlockActionsMenu } from '../../renderer/block-actions.ts';

describe('ConversationManager.getDiffAtLine', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('returns null when no diff block registered', () => {
    cm.addUserMessage('hello');
    cm.getDisplayBlocks();
    expect(cm.getDiffAtLine(0)).toBeNull();
  });

  test('returns diff metadata for a diff block', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-const x = 1;',
      '+const x = 42;',
    ].join('\n');
    cm.addUserMessage('apply this');
    cm.addToolResults([{ callId: 'c1', success: true, output: diff }]);
    cm.getDisplayBlocks();

    const result = cm.getDiffAtLine(0);
    expect(result).toEqual(expect.objectContaining({
      filePath: 'src/foo.ts',
      original: expect.stringContaining('const x = 1;'),
      updated: expect.stringContaining('const x = 42;'),
    }));
  });
});

describe('tool result rendering', () => {
  test('renders the human-readable tool name instead of only the opaque call id when available', () => {
    const cm = new ConversationManager(() => 80);
    const callId = 'chatcmpl-tool-b697f24c7516250';
    cm.addAssistantMessage('Running web search.', {
      toolCalls: [{ id: callId, name: 'web_search', arguments: { query: 'dllm language model' } }],
    });
    cm.addToolResults([{ callId, success: true, output: '1 line' }]);

    const text = cm.getDisplayBlocks()
      .map((line) => line.map((cell) => cell.char).join(''))
      .join('\n');

    // The human-readable name now lives once, on the CALL row that owns the
    // result, instead of being repeated on the result row underneath it. The
    // guarantee this test exists for is unchanged: the transcript names the
    // tool in words and never falls back to the opaque call id.
    expect(text).toContain('Searching the web');
    expect(text).not.toContain(callId);
    // The result still declares its own size, which is what makes it
    // discoverable as expandable.
    expect(text).toMatch(/\d+ lines?/);
  });
});

describe('BlockActionsMenu', () => {
  test('opens with correct actions for tool block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    expect(menu.active).toBe(true);
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('bookmark');
    expect(ids).toContain('toggle');
    // Re-running a tool is not an Agent action, so the menu never offers it.
    expect(ids).not.toContain('rerun');
    expect(ids).not.toContain('apply');
  });

  test('does not expose edit-apply actions for diff-like blocks in Agent', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'diff', startLine: 0, lineCount: 5, rawContent: 'diff', collapseKey: 'k0' });
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('bookmark');
    expect(ids).toContain('toggle');
    expect(ids).not.toContain('apply');
    expect(ids).not.toContain('rerun');
  });

  test('shows all base actions for code blocks', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'code', startLine: 0, lineCount: 5, rawContent: 'code', collapseKey: 'k0' });
    const ids = menu.actions.map(a => a.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('bookmark');
    expect(ids).toContain('toggle');
    expect(ids).not.toContain('apply');
    expect(ids).not.toContain('rerun');
  });

  test('getActionForKey returns correct action', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    expect(menu.getActionForKey('c')?.id).toBe('copy');
    expect(menu.getActionForKey('b')?.id).toBe('bookmark');
    expect(menu.getActionForKey('r')).toBeNull();
    expect(menu.getActionForKey('x')).toBeNull();
  });

  test('close resets state', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'result', collapseKey: 'k0' });
    menu.close();
    expect(menu.active).toBe(false);
    expect(menu.block).toBeNull();
    expect(menu.actions).toHaveLength(0);
  });

  test('moveUp/moveDown wrap correctly', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 5, rawContent: 'r', collapseKey: 'k0' });
    menu.selectedIndex = 0;
    menu.moveUp(); // should wrap to last
    expect(menu.selectedIndex).toBe(menu.actions.length - 1);
    menu.moveDown(); // should wrap back to 0
    expect(menu.selectedIndex).toBe(0);
  });
});

describe('code block collapse', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('code blocks over threshold are registered and auto-collapsed', () => {
    const codeLines = Array.from({ length: 35 }, (_, i) => `  line${i + 1};`).join('\n');
    cm.addUserMessage('look at this');
    cm.addAssistantMessage('Here:\n```ts\n' + codeLines + '\n```');
    cm.getDisplayBlocks();

    const registry = cm.getBlockRegistry();
    const codeBlock = registry.find(b => b.type === 'code');
    expect(codeBlock).toEqual(expect.objectContaining({ type: 'code' }));
    // Auto-collapsed when over threshold
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(true);
  });

  test('short code blocks are registered but not auto-collapsed', () => {
    cm.addUserMessage('look at this');
    cm.addAssistantMessage('Here:\n```ts\nconst x = 1;\n```');
    cm.getDisplayBlocks();

    const registry = cm.getBlockRegistry();
    const codeBlock = registry.find(b => b.type === 'code');
    expect(codeBlock).toEqual(expect.objectContaining({ type: 'code' }));
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(false);
  });

  test('thinking blocks are registered', () => {
    const bigThinking = Array.from({ length: 35 }, (_, i) => `thought ${i}`).join('\n');
    const cm2 = new ConversationManager(() => 80);
    // Showing thinking is a display setting; the reasoning text rides on the assistant message.
    cm2.setConfigManager({
      get: (k: string) => k === 'display.showThinking'
        ? true
        : (k === 'display.collapseThreshold' ? 30 : false),
    } as unknown as Parameters<typeof cm2.setConfigManager>[0]);
    cm2.addUserMessage('think');
    cm2.addAssistantMessage('done', { reasoningContent: bigThinking });
    cm2.getDisplayBlocks();

    const registry = cm2.getBlockRegistry();
    const thinkingBlock = registry.find(b => b.type === 'thinking');
    expect(thinkingBlock).toEqual(expect.objectContaining({ type: 'thinking' }));
  });

  test('toggleCollapseAtLine works for code blocks', () => {
    const codeLines = Array.from({ length: 35 }, (_, i) => `  line${i + 1};`).join('\n');
    cm.addUserMessage('look at this');
    cm.addAssistantMessage('Here:\n```ts\n' + codeLines + '\n```');
    cm.getDisplayBlocks();

    const registry = cm.getBlockRegistry();
    const codeBlock = registry.find(b => b.type === 'code');
    expect(codeBlock).toEqual(expect.objectContaining({ type: 'code' }));

    // Toggle: collapse → expand
    cm.toggleCollapseAtLine(codeBlock!.startLine);
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(false);

    // Toggle again: expand → collapse
    cm.toggleCollapseAtLine(codeBlock!.startLine);
    expect(cm.isCollapsed(codeBlock!.blockIndex)).toBe(true);
  });
});

describe('ConversationManager.getErrorLines: notices leave the transcript', () => {
  usePresentationReadings([
    ['Error: command not found', 'error'], ['error: lowercase error', 'error'], ['ERROR! uppercase variant', 'error'],
    ['[Error] Connection refused', 'error'], ['[Critical] Multiple errors detected (4 in 10s) ...', 'error'],
    ['No errors found in codebase', 'info'], ['Scanning... recovered from terror', 'info'],
    ['Error: first failure', 'error'], ['[Critical] second failure', 'error'],
  ]);
  // System notices are toasts and notification-history entries (core/notices.ts,
  // ui-live-run-5 item 9), so the main transcript draws no row for them and
  // error navigation has nothing of theirs to land on. The content rule itself
  // still decides navigability where notices are drawn (an agent view).
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('returns empty when no error messages', () => {
    cm.addUserMessage('hello');
    cm.addAssistantMessage('hi');
    cm.getDisplayBlocks();
    expect(cm.getErrorLines()).toHaveLength(0);
  });

  test('a notice of any kind registers no transcript error line', () => {
    cm.addUserMessage('run tool');
    cm.addSystemMessage('Error: command not found');
    cm.addUserMessage('retry');
    cm.addSystemMessage('[Error] Connection refused');
    cm.addSystemMessage('[Critical] Multiple errors detected (4 in 10s) ...');
    cm.getDisplayBlocks();
    expect(cm.getErrorLines()).toHaveLength(0);
  });

  test('a notice its writer stored as an error is navigable; other levels are not', () => {
    expect(isNavigableSystemContent('error')).toBe(true);
    expect(isNavigableSystemContent('warning')).toBe(false);
    expect(isNavigableSystemContent('info')).toBe(false);
    expect(isNavigableSystemContent(undefined)).toBe(false);
  });

  test('where notices are drawn (a context without systemNotices, as an agent view), error notices register error lines', () => {
    const lines: Line[] = [];
    const errorLineRegistry: number[] = [];
    const context: ConversationRenderContext = {
      history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
      blockRegistry: [],
      collapseState: new Map(),
      errorLineRegistry,
      configManager: null,
      splashOptions: {},
    };
    appendConversationMessages(context, [
      { role: 'user', content: 'start' },
      { role: 'system', content: 'Error: first failure', presentation: { severity: 'error' } },
      { role: 'user', content: 'retry' },
      { role: 'system', content: 'No errors found in codebase', presentation: { severity: 'info' } },
      { role: 'system', content: '[Critical] second failure', presentation: { severity: 'error' } },
    ], 80, []);
    expect(errorLineRegistry).toHaveLength(2);
  });
});
