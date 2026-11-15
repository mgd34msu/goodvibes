/**
 * unified-diff.ts, the web UI's view of a git unified diff (the daemon's
 * `checkpoints.diff` and `sessions.changes.get` text), plus the helpers that
 * turn one selected hunk into a structured, human-readable steer context block.
 *
 * The parsing itself is the engine's one reader (`@goodvibes-jev/engine/platform/
 * platform/git/diff`), which the TUI and the daemon's hunk revert use too, so a
 * hunk is numbered and cut here exactly as the daemon reads it back when it is
 * reverted. This module only shapes that result for the views: a display path,
 * a binary flag, stable hunk ids and per-hunk counts.
 */
import { parseUnifiedDiff as parseStructuredDiff, type StructuredDiffFile } from '@goodvibes-jev/engine/platform/platform/git/diff';

export type DiffLineType = 'context' | 'add' | 'del' | 'meta';

export interface DiffLine {
  readonly type: DiffLineType;
  /** The line WITHOUT its leading +/-/space marker (meta lines keep their text verbatim). */
  readonly text: string;
  /** 1-based line number in the OLD file (context + del lines); null for add/meta. */
  readonly oldLine: number | null;
  /** 1-based line number in the NEW file (context + add lines); null for del/meta. */
  readonly newLine: number | null;
}

export interface DiffHunk {
  /** Stable within a file: `${fileIndex}:${hunkIndex}`, safe as a React key / selection id. */
  readonly id: string;
  /** The verbatim `@@ -a,b +c,d @@ section` header. */
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
  readonly addCount: number;
  readonly delCount: number;
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** The path shown to the user, the new path unless the file was deleted. */
  readonly path: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
}

/** A binary file keeps the status its mode lines gave it; the engine folds that into 'binary'. */
function viewStatus(file: StructuredDiffFile): DiffFileStatus {
  if (file.status !== 'binary') return file.status;
  if (file.oldPath === null) return 'added';
  if (file.newPath === null) return 'deleted';
  return file.oldPath !== file.newPath ? 'renamed' : 'modified';
}

/**
 * Parse a git unified-diff string into files and hunks for the views. Returns []
 * for an empty/whitespace-only diff (the honest "no file differences" case the
 * caller renders as such).
 */
export const parseUnifiedDiff = (unifiedDiff: string): DiffFile[] =>
  parseStructuredDiff(unifiedDiff).files.map((file, fileIndex) => {
    const oldPath = file.oldPath ?? '';
    const newPath = file.newPath ?? '';
    const status = viewStatus(file);
    return {
      path: status === 'deleted' ? (oldPath || newPath || 'unknown') : (newPath || oldPath || 'unknown'),
      oldPath,
      newPath,
      status,
      binary: file.status === 'binary',
      hunks: file.hunks.map((hunk, hunkIndex) => ({
        id: `${fileIndex}:${hunkIndex}`,
        header: hunk.header,
        oldStart: hunk.oldStart,
        oldCount: hunk.oldLines,
        newStart: hunk.newStart,
        newCount: hunk.newLines,
        lines: hunk.lines.map((line) => ({ type: line.kind, text: line.text, oldLine: line.oldLine, newLine: line.newLine })),
        addCount: hunk.lines.filter((line) => line.kind === 'add').length,
        delCount: hunk.lines.filter((line) => line.kind === 'del').length,
      })),
    };
  });

/** The old-file line span a hunk touches, as an inclusive {from,to} (0/0 when the hunk adds only). */
export function hunkOldRange(hunk: Pick<DiffHunk, 'oldStart' | 'oldCount'>): { from: number; to: number } {
  if (hunk.oldCount <= 0) return { from: hunk.oldStart, to: hunk.oldStart };
  return { from: hunk.oldStart, to: hunk.oldStart + hunk.oldCount - 1 };
}

/** The new-file line span a hunk touches, as an inclusive {from,to} (0/0 when the hunk deletes only). */
export function hunkNewRange(hunk: Pick<DiffHunk, 'newStart' | 'newCount'>): { from: number; to: number } {
  if (hunk.newCount <= 0) return { from: hunk.newStart, to: hunk.newStart };
  return { from: hunk.newStart, to: hunk.newStart + hunk.newCount - 1 };
}

/** A short human range label like "42–48" (or "42" for a single line). */
export function formatRange(range: { from: number; to: number }): string {
  return range.from === range.to ? String(range.from) : `${range.from}–${range.to}`;
}

/** The hunk's body lines with their verbatim +/-/space markers (meta lines kept as-is). */
function hunkBodyLines(hunk: DiffHunk): string[] {
  return hunk.lines.map((line) => {
    if (line.type === 'add') return `+${line.text}`;
    if (line.type === 'del') return `-${line.text}`;
    if (line.type === 'meta') return line.text;
    return ` ${line.text}`;
  });
}

/**
 * Reconstruct the hunk's diff text (the `@@` header plus its +/-/space lines),
 * capped to `maxLines` body lines so a huge hunk does not bloat the steer message.
 * When capped, an honest "… N more lines" marker is appended.
 */
export function hunkExcerpt(hunk: DiffHunk, maxLines = 40): string {
  const body = hunkBodyLines(hunk);
  const shown = body.slice(0, maxLines);
  const remainder = body.length - shown.length;
  const tail = remainder > 0 ? [`… ${remainder} more line${remainder === 1 ? '' : 's'} in this hunk (truncated)`] : [];
  return [hunk.header, ...shown, ...tail].join('\n');
}

/**
 * The COMPLETE, exact unified-diff text of one hunk, its `@@` header followed by
 * every body line with its verbatim +/-/space/meta marker, UNCAPPED. This is the
 * string checkpoints.revertHunkPreview / checkpoints.revertHunk consume: the daemon
 * parses exactly one `@@ … @@` block and reverse-applies it against the live file, so
 * unlike hunkExcerpt this never truncates or appends a "… N more" marker, a capped or
 * annotated patch would fail to apply cleanly (an honest conflict, not the revert).
 */
export function hunkToPatch(hunk: DiffHunk): string {
  return [hunk.header, ...hunkBodyLines(hunk)].join('\n');
}

export interface HunkCommentContextInput {
  readonly filePath: string;
  readonly hunk: DiffHunk;
  /** How the diff was captured, for the trust-in-labels line (e.g. the checkpoint label + when). */
  readonly capturedLabel: string;
  readonly comment: string;
  /** Cap the embedded excerpt (defaults to 40 body lines). */
  readonly maxExcerptLines?: number;
}

/**
 * Build the structured, human-readable context block that PREFIXES the steer message,
 * so the model knows exactly which change the comment is about: the file, the old/new
 * line ranges, when the diff was captured, and the hunk excerpt itself, then the
 * user's comment last. Fenced so the excerpt's leading +/- characters read as a code
 * block rather than markdown list/quote syntax.
 */
export function buildHunkCommentSteer(input: HunkCommentContextInput): string {
  const oldRange = hunkOldRange(input.hunk);
  const newRange = hunkNewRange(input.hunk);
  const comment = input.comment.trim();
  const lines = [
    'Comment on a specific code change:',
    `- File: ${input.filePath}`,
    `- Lines: new ${formatRange(newRange)} · old ${formatRange(oldRange)}`,
    `- Source: ${input.capturedLabel}`,
    '',
    'Change in question:',
    '```diff',
    hunkExcerpt(input.hunk, input.maxExcerptLines),
    '```',
    '',
    `My comment: ${comment}`,
  ];
  return lines.join('\n');
}
