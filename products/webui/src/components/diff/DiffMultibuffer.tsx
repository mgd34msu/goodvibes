/**
 * DiffMultibuffer, one scrollable review surface for a parsed unified diff: every
 * changed file as its own section, each file broken into hunk-boundary blocks. Built
 * directly on lib/unified-diff.ts's DiffFile/DiffHunk shape (parseUnifiedDiff), so it is
 * a pure presentational renderer, no network, no wire concern of its own.
 *
 * Two callers share it, which is why it is a component and not inlined:
 *   - SessionChanges (the session review cockpit, task 1): INTERACTIVE, each textual
 *     hunk is a tap target (onHunkActivate opens the per-hunk action sheet) and carries a
 *     client-review status marker (reviewed / reverted / conflict) via statusFor.
 *   - AttemptComparison (best-of-N candidate comparison, task 3): READ-ONLY, no
 *     onHunkActivate, so each hunk renders as a plain block for side-by-side reading.
 *
 * Phone-first: an interactive hunk is a full-width ≥44px tap target; long hunks cap at
 * maxHunkLines with an honest "… N more" marker so a huge file never blows out the column.
 */
import type { DiffFile, DiffHunk } from '../../lib/unified-diff';
import { contentDigest } from '@goodvibes/engine/platform/platform/utils/target-ref';
import { Chip } from '../ui/Chip';
import { StatusDot, type StatusTone } from '../ui/StatusDot';
import '../../styles/components/diff-multibuffer.css';

/** Client-side, pre-refresh review status for one hunk (never a daemon field). */
export type HunkReviewStatus = 'reviewed' | 'reverted' | 'conflict';

export interface DiffMultibufferProps {
  files: readonly DiffFile[];
  /** Max body lines shown per hunk before a "… N more" marker (default 12; Infinity = all). */
  maxHunkLines?: number;
  /** When set, each TEXTUAL hunk is a tap target calling this (task 1 opens its action sheet). */
  onHunkActivate?: (file: DiffFile, hunk: DiffHunk) => void;
  /** Per-hunk client-review status, drives the reviewed/reverted/conflict marker (task 1). */
  statusFor?: (file: DiffFile, hunk: DiffHunk) => HunkReviewStatus | null;
  /** The per-hunk CTA label when interactive (default "Review"). */
  hunkCtaLabel?: string;
  /** A stable prefix for React keys so two multibuffers on one screen never collide. */
  idPrefix?: string;
}

const hunkDigests = new WeakMap<DiffHunk, string>();

/**
 * A stable key for a hunk within a diff, for client-side review tracking: the file path
 * and the content digest of the hunk's lines (each line's kind and text, the engine's
 * `contentDigest`). A hunk whose content changed, even within the same `@@` range, is a
 * new key, so a "reviewed" mark never stays on content nobody looked at; the same lines
 * moved by an edit elsewhere in the file keep their mark. One digest per hunk object.
 */
export function hunkReviewKey(filePath: string, hunk: DiffHunk): string {
  let digest = hunkDigests.get(hunk);
  if (digest === undefined) {
    digest = contentDigest(hunk.lines.map((line) => [line.type, line.text]));
    hunkDigests.set(hunk, digest);
  }
  return `${filePath}\0${digest}`;
}

/** How many textual (reviewable) hunks the diff carries, the denominator for a
 * reviewed/total progress indicator. Binary and metadata-only files contribute none. */
export function countReviewableHunks(files: readonly DiffFile[]): number {
  return files.reduce((total, file) => total + (file.binary ? 0 : file.hunks.length), 0);
}

function statusLabel(status: HunkReviewStatus): string {
  if (status === 'reviewed') return 'Reviewed';
  if (status === 'reverted') return 'Reverted: refreshing…';
  return 'Changed since captured: refresh';
}

function statusTone(status: HunkReviewStatus): StatusTone {
  if (status === 'reviewed') return 'ok';
  if (status === 'conflict') return 'warn';
  return 'idle';
}

function fileStatusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : status;
}

function HunkLines({ hunk, maxLines }: { hunk: DiffHunk; maxLines: number }) {
  const shown = hunk.lines.slice(0, maxLines);
  const remainder = hunk.lines.length - shown.length;
  return (
    <code className="diff-mb__lines">
      {shown.map((line, i) => (
        <span key={i} className={`diff-mb__line diff-mb__line--${line.type}`}>
          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'meta' ? '' : ' '}
          {line.text}
        </span>
      ))}
      {remainder > 0 && (
        <span className="diff-mb__line diff-mb__line--more">… {remainder} more line{remainder === 1 ? '' : 's'}</span>
      )}
    </code>
  );
}

export function DiffMultibuffer({
  files,
  maxHunkLines = 12,
  onHunkActivate,
  statusFor,
  hunkCtaLabel = 'Review',
  idPrefix = 'diff-mb',
}: DiffMultibufferProps) {
  return (
    <div className="diff-mb">
      {files.map((file, fileIndex) => (
        <div key={`${idPrefix}-${fileIndex}-${file.path}`} className="diff-mb__file">
          <div className="diff-mb__file-head">
            <span className="diff-mb__file-path">{file.path}</span>
            <Chip size="sm" tone={file.status === 'deleted' ? 'bad' : file.status === 'added' ? 'ok' : 'idle'}>
              {fileStatusLabel(file.status)}
            </Chip>
          </div>

          {file.binary ? (
            <p className="diff-mb__note" role="note">Binary file: no line diff.</p>
          ) : file.hunks.length === 0 ? (
            <p className="diff-mb__note" role="note">No textual hunks (metadata-only change).</p>
          ) : (
            <div className="diff-mb__frame">
              {file.hunks.map((hunk) => {
              const status = statusFor?.(file, hunk) ?? null;
              const statusMod = status ? ` diff-mb__hunk--${status}` : '';
              const body = (
                <>
                  <span className="diff-mb__hunk-header">{hunk.header}</span>
                  <HunkLines hunk={hunk} maxLines={maxHunkLines} />
                  {status && (
                    <span className={`diff-mb__hunk-status diff-mb__hunk-status--${status}`}>
                      <StatusDot tone={statusTone(status)} />
                      {statusLabel(status)}
                    </span>
                  )}
                </>
              );
              if (!onHunkActivate) {
                return (
                  <div key={hunk.id} className={`diff-mb__hunk diff-mb__hunk--static${statusMod}`}>
                    {body}
                  </div>
                );
              }
              return (
                <button
                  key={hunk.id}
                  type="button"
                  className={`diff-mb__hunk${statusMod}`}
                  onClick={() => onHunkActivate(file, hunk)}
                  title="Review this hunk"
                >
                  {body}
                  <span className="diff-mb__hunk-cta">{hunkCtaLabel}</span>
                </button>
              );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
