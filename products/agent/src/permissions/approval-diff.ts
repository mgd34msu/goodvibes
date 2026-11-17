import { decodeBase64, readApprovalEditHunks } from '@goodvibes-jev/engine/platform/platform/control-plane/approval-hunk-apply';
import type { PermissionRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { HunkSelectionState } from '@goodvibes-jev/engine/terminal-shell/hunk-selection';

/**
 * The change a `write` or `edit` ask would make, as unified-diff text for
 * renderDiffView, read from the arguments the request already carries (no
 * file is read). A write shows each file's new content as added lines; an
 * edit shows each entry's find text removed and its replacement added, under
 * a hunk header naming the file and no line numbers, since where the match
 * sits in the file is not known until the edit runs. Edit text is read
 * through the platform's one rule (approval-hunk-apply), so the owner sees
 * exactly the text the tool will match and write. Null for any other ask, or
 * one whose arguments carry no change to show.
 *
 * Input beyond `maxLines` diff lines is not turned into text; `hiddenLines`
 * says how many were left out and `totalLines` how many the whole change has,
 * so the card can say so.
 */
export function approvalDiffText(
  request: Pick<PermissionRequest, 'tool' | 'args'>,
  maxLines: number,
): { readonly text: string; readonly hiddenLines: number; readonly totalLines: number } | null {
  const out: string[] = [];
  let hidden = 0;
  const push = (line: string): void => {
    if (out.length < maxLines) out.push(line);
    else hidden += 1;
  };

  if (request.tool === 'write') {
    const files = request.args['files'];
    if (!Array.isArray(files)) return null;
    for (const file of files) {
      if (typeof file !== 'object' || file === null) continue;
      const entry = file as Record<string, unknown>;
      const path = typeof entry['path'] === 'string' ? entry['path'] : '(no path)';
      const text = typeof entry['content_base64'] === 'string'
        ? decodeBase64(entry['content_base64'])
        : typeof entry['content'] === 'string' ? entry['content'] : null;
      if (text === null) continue;
      if (/[\u0000�]/.test(text)) {
        push(`@@ ${path}: binary content, not shown @@`);
        continue;
      }
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
      push(`@@ -0,0 +1,${lines.length} @@ ${path}${lines.length === 0 ? ' (empty file)' : ''}`);
      for (const line of lines) push(`+${line}`);
    }
  } else if (request.tool === 'edit') {
    const hunks = readApprovalEditHunks(request.args);
    if (!hunks) return null;
    for (const hunk of hunks) {
      push(`@@ ${hunk.path} @@`);
      for (const line of hunk.find.split('\n')) push(`-${line}`);
      if (hunk.replace !== '') for (const line of hunk.replace.split('\n')) push(`+${line}`);
    }
  } else {
    return null;
  }

  if (out.length === 0) return null;
  return { text: out.join('\n'), hiddenLines: hidden, totalLines: out.length + hidden };
}

/**
 * A multi-edit `edit` ask as the hunk-selection card shows it: each hunk under
 * a header with its checkbox (`[x]` applies it) and number, the cursor's hunk
 * marked `›` and listed first, so it is always in view; the hunks above it are
 * counted. Same shape as {@link approvalDiffText}, for renderDiffView.
 */
export function approvalHunkDiffText(
  state: HunkSelectionState,
  maxLines: number,
): { readonly text: string; readonly hiddenLines: number; readonly totalLines: number } {
  const out: string[] = [];
  let hidden = 0;
  const push = (line: string): void => {
    if (out.length < maxLines) out.push(line);
    else hidden += 1;
  };
  if (state.cursor > 0) push(`@@ ${state.cursor} hunk${state.cursor === 1 ? '' : 's'} above (k moves up) @@`);
  state.hunks.forEach((hunk, index) => {
    if (index < state.cursor) return;
    push(`@@ ${index === state.cursor ? '›' : ' '} [${state.selected.has(index) ? 'x' : ' '}] ${index + 1}. ${hunk.path} @@`);
    for (const line of hunk.find.split('\n')) push(`-${line}`);
    if (hunk.replace !== '') for (const line of hunk.replace.split('\n')) push(`+${line}`);
  });
  return { text: out.join('\n'), hiddenLines: hidden, totalLines: out.length + hidden };
}
