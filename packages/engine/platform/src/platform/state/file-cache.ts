import { createHash } from 'node:crypto';

export type CacheStatus = 'miss' | 'unchanged' | 'modified';

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * FileStateCache: "is this file still what this session last saw?"
 *
 * One SHA-256 per path (64 bytes), recorded when a tool reads or writes the
 * file. A read or edit compares the bytes it has just read itself with the
 * recorded hash, so the comparison and the operation see the same instant and
 * the file is read once per call. Nothing is evicted, so the protection does
 * not lapse for files read long ago; memory grows by one hash per file read.
 *
 * - miss: this session has not seen the file
 * - unchanged: the bytes are the ones last seen
 * - modified: the file changed since this session last saw it
 */
export class FileStateCache {
  private readonly hashes = new Map<string, string>();

  /** Compare content the caller just read with what this session last saw. Records nothing. */
  compare(filePath: string, content: string): CacheStatus {
    const seen = this.hashes.get(filePath);
    if (seen === undefined) return 'miss';
    return seen === digest(content) ? 'unchanged' : 'modified';
  }

  /** Record the content a tool read or wrote as what this session has seen. */
  update(filePath: string, content: string, _metadata?: { tool?: string; agent?: string }): void {
    this.hashes.set(filePath, digest(content));
  }

  /** Forget a file (it was changed by something that did not read it, such as an undo). */
  invalidate(filePath: string): void {
    this.hashes.delete(filePath);
  }

  /** Forget every file. */
  clear(): void {
    this.hashes.clear();
  }
}

/**
 * Generate a simple unified diff between two strings.
 * Uses line-by-line LCS diff, not the Myers algorithm.
 */
export function unifiedDiff(oldContent: string, newContent: string, label: string, contextLines = 3): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunks = computeHunks(oldLines, newLines, contextLines);
  if (hunks.length === 0) return '';

  const header = `--- ${label}\n+++ ${label}\n`;
  return header + hunks.join('');
}

interface HunkLine {
  type: 'context' | 'removed' | 'added';
  text: string;
}

function computeHunks(oldLines: string[], newLines: string[], CONTEXT = 3): string[] {
  // Simple O(n*m) LCS-based diff, practical for reasonable file sizes
  const edits = computeEdits(oldLines, newLines);
  if (edits.length === 0) return [];

  // Group edits into hunks with context
  const result: string[] = [];
  let i = 0;
  while (i < edits.length) {
    // Find next non-context edit
    while (i < edits.length && edits[i]?.type === 'context') i++;
    if (i >= edits.length) break;

    // Collect hunk starting CONTEXT lines before
    const hunkStart = Math.max(0, i - CONTEXT);
    let hunkEnd = i;
    // Extend to next gap
    while (hunkEnd < edits.length) {
      if (edits[hunkEnd]?.type !== 'context') {
        hunkEnd++;
      } else {
        // Check if there's another non-context within CONTEXT distance
        let next = hunkEnd + 1;
        while (next < edits.length && edits[next]?.type === 'context') next++;
        if (next < edits.length && next - hunkEnd <= CONTEXT * 2) {
          hunkEnd = next;
        } else {
          break;
        }
      }
    }
    const hunkRealEnd = Math.min(edits.length, hunkEnd + CONTEXT);

    const hunkLines = edits.slice(hunkStart, hunkRealEnd);
    let oldStart = 1, oldCount = 0, newStart = 1, newCount = 0;
    // Compute line numbers
    let oldLine = 1;
    let newLine = 1;
    for (let j = 0; j < hunkStart; j++) {
      if (edits[j]?.type !== 'added') oldLine++;
      if (edits[j]?.type !== 'removed') newLine++;
    }
    oldStart = oldLine;
    newStart = newLine;
    for (const hl of hunkLines) {
      if (hl.type !== 'added') oldCount++;
      if (hl.type !== 'removed') newCount++;
    }

    let hunk = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (const hl of hunkLines) {
      const prefix = hl.type === 'context' ? ' ' : hl.type === 'removed' ? '-' : '+';
      hunk += prefix + hl.text + '\n';
    }
    result.push(hunk);
    i = hunkRealEnd;
  }
  return result;
}

function computeEdits(allOld: string[], allNew: string[]): HunkLine[] {
  // Unchanged leading and trailing lines never need the LCS table, so a small
  // change in a large file is diffed on the changed middle only.
  let prefix = 0;
  const maxPrefix = Math.min(allOld.length, allNew.length);
  while (prefix < maxPrefix && allOld[prefix] === allNew[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && allOld[allOld.length - 1 - suffix] === allNew[allNew.length - 1 - suffix]) suffix++;
  if (prefix > 0 || suffix > 0) {
    const middle = computeEdits(
      allOld.slice(prefix, allOld.length - suffix),
      allNew.slice(prefix, allNew.length - suffix),
    );
    return [
      ...allOld.slice(0, prefix).map((text): HunkLine => ({ type: 'context', text })),
      ...middle,
      ...allOld.slice(allOld.length - suffix).map((text): HunkLine => ({ type: 'context', text })),
    ];
  }
  const oldLines = allOld;
  const newLines = allNew;
  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  // For large files, fall back to simple append diff to avoid O(mn) memory
  if (m * n > 1_000_000) {
    const edits: HunkLine[] = [];
    for (const l of oldLines) edits.push({ type: 'removed', text: l });
    for (const l of newLines) edits.push({ type: 'added', text: l });
    return edits;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j]! = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j]! = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Reconstruct diff
  const edits: HunkLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      edits.push({ type: 'context', text: oldLines[i]! });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      edits.push({ type: 'added', text: newLines[j]! });
      j++;
    } else {
      edits.push({ type: 'removed', text: oldLines[i]! });
      i++;
    }
  }
  return edits;
}
