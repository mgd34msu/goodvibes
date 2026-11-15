export interface DiffParseResult {
  filePath?: string | undefined;
  diffOriginal?: string | undefined;
  diffUpdated?: string | undefined;
  /**
   * Why the diff cannot be applied as one replacement (more than one hunk or
   * more than one file). When set, `diffOriginal` and `diffUpdated` are left
   * out rather than holding a partial or concatenated approximation.
   */
  unsupported?: string | undefined;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** A header path is applied relative to the project, so it must stay inside it. */
function safeRelativePath(raw: string): string | undefined {
  const path = raw.startsWith('b/') ? raw.slice(2) : raw.split(' ')[0];
  if (!path || path === '/dev/null' || path.includes('\0')) return undefined;
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return undefined;
  if (path.split(/[\\/]/).includes('..')) return undefined;
  return path;
}

/**
 * Reads one unified diff into the text it removes and the text it adds. Hunk
 * line counts decide where a hunk ends, so a removed line that itself starts
 * with `--` or an added `++x` is content, not a header. A diff with several
 * hunks or files cannot be applied as one contiguous replacement and is
 * reported through `unsupported` instead of being joined into text that never
 * occurs in the file.
 */
export function parseDiffForApply(diffText: string): DiffParseResult {
  const lines = diffText.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let filePath: string | undefined;

  const original: string[] = [];
  const updated: string[] = [];
  let hunks = 0;
  let files = 0;
  // `inHunk` with Infinity counts is a headerless diff: everything after the
  // file header is one hunk.
  let inHunk = false;
  let remainingOld = 0;
  let remainingNew = 0;
  let sawHeaderPath = false;

  for (const line of lines) {
    if (inHunk && (remainingOld > 0 || remainingNew > 0)) {
      if (line.startsWith('\\')) continue;
      if (line.startsWith('-')) { if (hunks === 1) original.push(line.slice(1)); remainingOld--; continue; }
      if (line.startsWith('+')) { if (hunks === 1) updated.push(line.slice(1)); remainingNew--; continue; }
      const content = line.startsWith(' ') ? line.slice(1) : line;
      if (hunks === 1) { original.push(content); updated.push(content); }
      remainingOld--; remainingNew--;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunks++;
      inHunk = true;
      remainingOld = header[1] === undefined ? 1 : Number(header[1]);
      remainingNew = header[2] === undefined ? 1 : Number(header[2]);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ')) {
      if (line.startsWith('+++ ')) {
        if (sawHeaderPath || hunks > 0) files++;
        else { sawHeaderPath = true; files = 1; filePath = safeRelativePath(line.slice(4).trim()); }
      }
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (hunks === 0 && sawHeaderPath) {
      // No hunk header: the rest is a single hunk of unknown length.
      hunks = 1; inHunk = true; remainingOld = Infinity; remainingNew = Infinity;
      if (line.startsWith('-')) original.push(line.slice(1));
      else if (line.startsWith('+')) updated.push(line.slice(1));
      else { const content = line.startsWith(' ') ? line.slice(1) : line; original.push(content); updated.push(content); }
    }
  }

  if (hunks > 1 || files > 1) {
    return {
      filePath,
      unsupported: files > 1
        ? 'This diff touches more than one file; apply each file\'s change on its own.'
        : `This diff has ${hunks} separate hunks; apply supports one hunk at a time.`,
    };
  }
  return {
    filePath,
    diffOriginal: original.join('\n'),
    diffUpdated: updated.join('\n'),
  };
}

export function applyDiffContent(
  fileContent: string,
  original: string,
  updated: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!original) {
    return { ok: false, error: 'empty original pattern' };
  }
  if (!fileContent.includes(original)) {
    return { ok: false, error: 'original text not found in file' };
  }
  const occurrenceCount = fileContent.split(original).length - 1;
  if (occurrenceCount > 1) {
    return { ok: false, error: `ambiguous: pattern found ${occurrenceCount} times` };
  }
  return { ok: true, content: fileContent.replace(original, updated) };
}
