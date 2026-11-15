/**
 * structured-diff.ts, the one reader of git's unified diff: the TUI, the web
 * UI (through the browser-safe `git/diff` subpath) and the daemon's hunk revert
 * all parse with it, so one rule decides what a hunk is and how its lines are
 * numbered.
 *
 * The FULL diff is parsed into per-file entries with per-hunk lines, no size cap
 * anywhere. Each line carries its old and new line number. A hunk ends when the
 * line counts in its header are used up, so a plain `diff -u` concatenation
 * without `diff --git` lines still splits into files. `reconstructUnifiedDiff`
 * proves the structure is complete: parse → reconstruct round-trips the text.
 *
 * No imports and no Node globals: this module runs in the browser as is.
 */

/** One line inside a hunk. */
export interface StructuredDiffLine {
  /** 'context' (unchanged), 'add' (+), 'del' (-), or 'meta' (a `\ No newline at end of file` marker). */
  readonly kind: 'context' | 'add' | 'del' | 'meta';
  /** The line content WITHOUT its +/-/space prefix; a meta line keeps its text verbatim. */
  readonly text: string;
  /** 1-based line number in the old file (context and del lines); null for add and meta. */
  readonly oldLine: number | null;
  /** 1-based line number in the new file (context and add lines); null for del and meta. */
  readonly newLine: number | null;
}

/** One @@ hunk: header coordinates plus every line, unabridged. */
export interface StructuredDiffHunk {
  /** The raw `@@ -a,b +c,d @@ ...` header line. */
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly StructuredDiffLine[];
}

/** One file's diff: paths, status, and every hunk, unabridged. */
export interface StructuredDiffFile {
  /** Path before the change (null for an added file). */
  readonly oldPath: string | null;
  /** Path after the change (null for a deleted file). */
  readonly newPath: string | null;
  readonly status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  readonly hunks: readonly StructuredDiffHunk[];
  /** The file-header lines exactly as emitted (diff --git, index, ---/+++, etc.). */
  readonly headerLines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

/** The whole diff, structured, with honest totals. Never truncated. */
export interface StructuredDiff {
  readonly files: readonly StructuredDiffFile[];
  readonly additions: number;
  readonly deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// git's path prefixes: the conventional a/ b/ plus the mnemonicPrefix set
// (c=commit, i=index, w=working tree, o=object). Tolerates --no-prefix.
const DIFF_PATH_PREFIX = /^[abciow]\//;

function stripPathPrefix(raw: string): string {
  return DIFF_PATH_PREFIX.test(raw) ? raw.slice(2) : raw;
}

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

/** Decodes git's C-quoted path ("a/\303\251"), where non-ASCII bytes are octal escapes. */
function unquoteCPath(quoted: string): string {
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== '\\') { bytes.push(...UTF8_ENCODER.encode(char)); continue; }
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); index += octal[0].length; continue; }
    const escaped = body[index + 1];
    if (escaped !== undefined && C_ESCAPES[escaped] !== undefined) { bytes.push(C_ESCAPES[escaped]!); index += 1; continue; }
    bytes.push(92);
  }
  return UTF8_DECODER.decode(new Uint8Array(bytes));
}

/** One path as git writes it, plain or C-quoted, without its a/ b/ prefix. */
function readGitPath(raw: string): string {
  const text = raw.trim();
  return stripPathPrefix(text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? unquoteCPath(text) : text);
}

/** The path on a `---`/`+++` line; git ends a path that holds a space with a tab and a timestamp. */
function parsePath(line: string, prefix: string): string | null {
  let raw = line.slice(prefix.length);
  if (!raw.startsWith('"')) raw = raw.replace(/\t.*$/, '');
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  return readGitPath(raw);
}

/** A hunk being read: its header, its lines, and where each side's next line number stands. */
interface OpenHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: StructuredDiffLine[];
  oldNext: number;
  newNext: number;
}

function openHunk(header: string): OpenHunk | null {
  const match = HUNK_HEADER.exec(header);
  if (!match) return null;
  const oldStart = Number(match[1]), newStart = Number(match[3]);
  return {
    header,
    oldStart,
    oldLines: match[2] !== undefined ? Number(match[2]) : 1,
    newStart,
    newLines: match[4] !== undefined ? Number(match[4]) : 1,
    lines: [],
    oldNext: oldStart,
    newNext: newStart,
  };
}

/** Whether every line the header counts has been read. */
function hunkComplete(hunk: OpenHunk): boolean {
  return hunk.oldNext >= hunk.oldStart + hunk.oldLines && hunk.newNext >= hunk.newStart + hunk.newLines;
}

/**
 * Read one body line into the open hunk. False when the line is not part of it:
 * the header's counts are used up (only a `\` marker may still follow) or the
 * line has no body prefix. An empty line counts as an empty context line, which
 * is how editors that strip trailing spaces leave one.
 */
function readHunkLine(hunk: OpenHunk, line: string): boolean {
  if (line.startsWith('\\')) {
    if (hunk.lines.length === 0) return false;
    hunk.lines.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
    return true;
  }
  if (hunkComplete(hunk)) return false;
  if (line.startsWith('+')) {
    hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: hunk.newNext });
    hunk.newNext += 1;
  } else if (line.startsWith('-')) {
    hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: hunk.oldNext, newLine: null });
    hunk.oldNext += 1;
  } else if (line.startsWith(' ') || line === '') {
    hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine: hunk.oldNext, newLine: hunk.newNext });
    hunk.oldNext += 1;
    hunk.newNext += 1;
  } else {
    return false;
  }
  return true;
}

function closeHunk(hunk: OpenHunk): StructuredDiffHunk {
  const { header, oldStart, oldLines, newStart, newLines, lines } = hunk;
  return { header, oldStart, oldLines, newStart, newLines, lines };
}

/**
 * Parse text that is only hunks (no file headers), as a client sends back one
 * hunk to revert. `unread` holds every other non-empty line, so a caller that
 * needs exact input can refuse a malformed one.
 */
export function parseUnifiedHunks(raw: string): { readonly hunks: readonly StructuredDiffHunk[]; readonly unread: readonly string[] } {
  const hunks: StructuredDiffHunk[] = [];
  const unread: string[] = [];
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let open: OpenHunk | null = null;
  for (const line of lines) {
    const next = openHunk(line);
    if (next) {
      if (open) hunks.push(closeHunk(open));
      open = next;
      continue;
    }
    if (open && readHunkLine(open, line)) continue;
    if (line.length > 0) unread.push(line);
  }
  if (open) hunks.push(closeHunk(open));
  return { hunks, unread };
}

/** The old and new path on a `diff --git` line, which git does not delimit when a path holds a space. */
function parseDiffGitPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    let end = 1;
    while (end < rest.length && (rest[end] !== '"' || rest[end - 1] === '\\')) end += 1;
    const first = rest.slice(0, end + 1);
    const second = rest.slice(end + 1).trim();
    return second ? [readGitPath(first), readGitPath(second)] : null;
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond > 0) return [readGitPath(rest.slice(0, quotedSecond)), readGitPath(rest.slice(quotedSecond + 1))];
  // Unrenamed paths appear twice with one space between: split at the middle when both halves agree.
  const middle = (rest.length - 1) / 2;
  if (Number.isInteger(middle) && rest[middle] === ' ' && readGitPath(rest.slice(0, middle)) === readGitPath(rest.slice(middle + 1))) {
    return [readGitPath(rest.slice(0, middle)), readGitPath(rest.slice(middle + 1))];
  }
  const split = rest.indexOf(' ');
  return split > 0 ? [readGitPath(rest.slice(0, split)), readGitPath(rest.slice(split + 1))] : null;
}

/**
 * Parse raw unified-diff text (any size, no cap) into structured files/hunks.
 * Unknown leading material and binary-file notices are handled; an empty diff
 * yields zero files.
 */
export function parseUnifiedDiff(raw: string): StructuredDiff {
  const files: StructuredDiffFile[] = [];
  if (!raw.trim()) return { files, additions: 0, deletions: 0 };
  const lines = raw.split('\n');
  // Drop a single trailing empty element produced by a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  interface Building {
    headerLines: string[];
    oldPath: string | null;
    newPath: string | null;
    binary: boolean;
    renamed: boolean;
    added: boolean;
    deleted: boolean;
    hunks: StructuredDiffHunk[];
  }
  let current: Building | null = null;
  let hunk: OpenHunk | null = null;

  const finalize = (): void => {
    if (current && hunk) current.hunks.push(closeHunk(hunk));
    hunk = null;
    if (!current) return;
    const additions = current.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === 'add').length, 0);
    const deletions = current.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((l) => l.kind === 'del').length, 0);
    const status: StructuredDiffFile['status'] = current.binary
      ? 'binary'
      : current.added || current.oldPath === null
        ? 'added'
        : current.deleted || current.newPath === null
          ? 'deleted'
          : current.renamed
            ? 'renamed'
            : 'modified';
    files.push({
      oldPath: current.oldPath,
      newPath: current.newPath,
      status,
      hunks: current.hunks,
      headerLines: current.headerLines,
      additions,
      deletions,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finalize();
      // Fallback paths from the diff --git line itself (kept when ---/+++ follow).
      current = { headerLines: [line], oldPath: null, newPath: null, binary: false, renamed: false, added: false, deleted: false, hunks: [] };
      const paths = parseDiffGitPaths(line.slice('diff --git '.length));
      if (paths) [current.oldPath, current.newPath] = paths;
      continue;
    }
    if (hunk && readHunkLine(hunk, line)) continue;
    // Tolerate diffs without diff --git lines: a `---` line outside a hunk opens the
    // next file once the current one has hunks (or when none is open).
    if (line.startsWith('--- ') && (!current || current.hunks.length > 0 || hunk)) {
      finalize();
      current = { headerLines: [], oldPath: null, newPath: null, binary: false, renamed: false, added: false, deleted: false, hunks: [] };
    }
    if (!current) continue;
    const next = openHunk(line);
    if (next) {
      if (hunk) current.hunks.push(closeHunk(hunk));
      hunk = next;
      continue;
    }
    // File-header territory (index/---/+++/rename/binary/mode lines).
    if (hunk) { current.hunks.push(closeHunk(hunk)); hunk = null; }
    current.headerLines.push(line);
    if (line.startsWith('--- ')) current.oldPath = parsePath(line, '--- ');
    else if (line.startsWith('+++ ')) current.newPath = parsePath(line, '+++ ');
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.binary = true;
    // An empty file added or deleted has no ---/+++ lines, so its mode line is the only signal.
    else if (line.startsWith('new file mode ')) { current.added = true; current.oldPath = null; }
    else if (line.startsWith('deleted file mode ')) { current.deleted = true; current.newPath = null; }
    else if (line.startsWith('rename from ')) { current.renamed = true; current.oldPath = readGitPath(line.slice('rename from '.length)); }
    else if (line.startsWith('rename to ')) { current.renamed = true; current.newPath = readGitPath(line.slice('rename to '.length)); }
  }
  finalize();

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/**
 * Rebuild unified-diff text from the structure, the completeness proof used
 * by tests (parse → reconstruct round-trips byte-for-byte for text diffs) and
 * an escape hatch for consumers that still want raw text for one file.
 */
export function reconstructUnifiedDiff(diff: StructuredDiff): string {
  const out: string[] = [];
  for (const file of diff.files) {
    out.push(...file.headerLines);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        if (line.kind === 'add') out.push(`+${line.text}`);
        else if (line.kind === 'del') out.push(`-${line.text}`);
        else if (line.kind === 'meta') out.push(line.text);
        else out.push(` ${line.text}`);
      }
    }
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
}
