import type { BlockMeta } from './work-tree-types.js';
export function describeBlockForReceipt(block: BlockMeta, detailed = true): string {
  const lineText = `${block.lineCount} line${block.lineCount === 1 ? '' : 's'}`;
  if (block.title !== undefined) return `${block.title} (${lineText})`;
  // The short form names the block in plain words, without the tool or file it carries.
  if (!detailed && block.type === 'assistant_turn') return `answer (${lineText})`;
  if (!detailed && block.type === 'diff') return `change (${lineText})`;
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
