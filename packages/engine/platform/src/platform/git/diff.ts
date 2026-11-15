/**
 * The browser-safe entry of the unified-diff reader: the web UI imports this
 * subpath, which pulls in no Node module (the `git` entry also carries GitService).
 */
export { parseUnifiedDiff, parseUnifiedHunks, reconstructUnifiedDiff } from './structured-diff.js';
export type { StructuredDiff, StructuredDiffFile, StructuredDiffHunk, StructuredDiffLine } from './structured-diff.js';
