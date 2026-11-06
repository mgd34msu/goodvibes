import { createTerminalPolishBlocks, type TerminalPolishPresentation } from './polish-blocks.js';
import { createTerminalPolishWorkspace } from './polish-workspace.js';
export type { TerminalPolishPresentation } from './polish-blocks.js';
export type * from './polish-workspace.js';
export function createTerminalPolish(presentation: TerminalPolishPresentation) {
  const blocks = createTerminalPolishBlocks(presentation);
  return { ...blocks, ...createTerminalPolishWorkspace(presentation, blocks) };
}
