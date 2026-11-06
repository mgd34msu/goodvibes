import type { BlockMeta } from './work-tree-types.js';
export function describeBlockForReceipt(block: BlockMeta, detailed = true): string {
  const lineText = `${block.lineCount} line${block.lineCount === 1 ? '' : 's'}`;
  if (!detailed && block.type !== 'tool' && block.type !== 'code' && block.type !== 'thinking') return `${block.type} (${lineText})`;
  switch (block.type) {
    case 'tool':
      return block.toolName ? `tool result: ${block.toolName} (${lineText})` : `tool result (${lineText})`;
    case 'assistant_turn':
      return block.toolName
        ? `assistant turn: ${block.toolName} (${lineText})`
        : `assistant turn (${lineText})`;
    case 'diff':
      return block.filePath ? `diff: ${block.filePath} (${lineText})` : `diff (${lineText})`;
    case 'code':
      return `code block (${lineText})`;
    case 'thinking':
      return `thinking (${lineText})`;
    default:
      return `${block.type} (${lineText})`;
  }
}
