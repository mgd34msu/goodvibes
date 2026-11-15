import type { PermissionPromptRequest } from '../permissions/prompt.js';
import { resolveEditText } from '../tools/edit/edit-text.js';

export { decodeBase64, resolveEditText, type EditTextFields } from '../tools/edit/edit-text.js';

/**
 * approval-hunk-apply.ts
 *
 * The one home of per-hunk approval: which entries of a multi-edit `edit`
 * call are hunks, the text each one will write, and the arguments that run
 * when only some of them are approved. The broker applies a `selectedHunks`
 * answer here, and the terminal apps and the web UI read the hunks they show
 * through `readApprovalEditHunks`, so every surface shows and approves the
 * same thing. This module imports nothing else at run time, so a browser
 * bundle can use it.
 *
 * Scoped to the `edit` tool: EditInput.edits is already an array of independent
 * find/replace units (each a natural "hunk"), so no diff/patch-apply primitive
 * is needed. Non-edit tools have no hunks; a selection against them is a
 * validation error, not a silent whole-request approve.
 *
 * Applied result: for a request whose `args.edits` are all valid hunks and a
 * selection set S of in-range indices, the modified args are
 * `{ ...request.args, edits: edits.filter((_, i) => S.has(i)) }`, the
 * original entries exactly as the model sent them.
 */

/**
 * One edit hunk as a surface shows it: the entry's own fields, with `find`
 * and `replace` set to the text the edit tool will really match and write
 * (a base64 field wins over its plain twin).
 */
export interface EditHunkLike {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly id?: string | undefined;
}

/** An entry as a hunk to show, or null when it is not a valid edit entry. */
function toEditHunkLike(value: unknown): EditHunkLike | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['path'] !== 'string') return null;
  if (candidate['id'] !== undefined && typeof candidate['id'] !== 'string') return null;
  for (const key of ['find', 'replace', 'find_base64', 'replace_base64'] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'string') return null;
  }
  const text = resolveEditText(candidate as Parameters<typeof resolveEditText>[0]);
  if ('error' in text) return null;
  return { ...candidate, path: candidate['path'], find: text.find, replace: text.replace } as EditHunkLike;
}

/** The raw `edits` entries when every one is a valid hunk, else null. */
function readEditEntries(args: Record<string, unknown>): { readonly entries: readonly unknown[]; readonly hunks: EditHunkLike[] } | null {
  const edits = args['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const hunks: EditHunkLike[] = [];
  for (const entry of edits) {
    const hunk = toEditHunkLike(entry);
    if (!hunk) return null;
    hunks.push(hunk);
  }
  return { entries: edits, hunks };
}

/**
 * The hunks of a permission request, for display, or null if the args are
 * not edit-shaped (no `edits` array, empty, or any entry the edit tool would
 * refuse, including one whose plain and base64 text disagree).
 */
export function readApprovalEditHunks(args: Record<string, unknown>): EditHunkLike[] | null {
  return readEditEntries(args)?.hunks ?? null;
}

/** True for a multi-edit `edit` call: the case where approving some hunks means anything. */
export function isHunkSelectableRequest(request: Pick<PermissionPromptRequest, 'tool' | 'args'>): boolean {
  if (request.tool !== 'edit') return false;
  const hunks = readApprovalEditHunks(request.args);
  return hunks !== null && hunks.length > 1;
}

/**
 * `request.args` with `edits` filtered to exactly the selected indices (in
 * original order), every entry and every other field untouched. A request
 * that is not edit-shaped yields `edits: []`; validate first with
 * {@link resolveApprovalHunkSelection} when an honest refusal is needed.
 */
export function buildModifiedEditArgs(
  request: Pick<PermissionPromptRequest, 'args'>,
  selectedHunks: ReadonlySet<number> | readonly number[],
): Record<string, unknown> {
  const selected = selectedHunks instanceof Set ? selectedHunks : new Set(selectedHunks);
  const entries = readEditEntries(request.args)?.entries ?? [];
  return { ...request.args, edits: entries.filter((_, index) => selected.has(index)) };
}

export type ApprovalHunkSelectionResolution =
  | {
      readonly ok: true;
      readonly modifiedArgs: Record<string, unknown>;
      readonly selectedCount: number;
      readonly totalHunks: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Validate a per-hunk selection against a pending approval's own request and,
 * when valid, compute the modified args. This is the single place the
 * bounds/shape rules live:
 *  - the request MUST be edit-shaped (has a valid `edits` array), selecting
 *    hunks on a non-edit tool is a client error, not a whole-request approve;
 *  - every index MUST be a finite integer in [0, totalHunks);
 *  - duplicate indices are tolerated (deduped by the Set), selecting the same
 *    hunk twice is not an error.
 *
 * An empty selection is allowed and yields `edits: []` (the caller, the human's
 * surface, is responsible for the "nothing selected" UX; the wire honors it as
 * an explicit approve-of-nothing). Callers that want "no selection = approve
 * all" must simply NOT pass a selection (see the broker's back-compat path).
 */
export function resolveApprovalHunkSelection(
  request: Pick<PermissionPromptRequest, 'args'>,
  selectedHunks: readonly number[],
): ApprovalHunkSelectionResolution {
  const hunks = readApprovalEditHunks(request.args);
  if (hunks === null) {
    return { ok: false, reason: 'This approval has no per-hunk edit list; selectedHunks is not applicable.' };
  }
  for (const index of selectedHunks) {
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length) {
      return {
        ok: false,
        reason: `selectedHunks index ${String(index)} is out of range for ${hunks.length} hunk(s).`,
      };
    }
  }
  const selected = new Set(selectedHunks);
  return {
    ok: true,
    modifiedArgs: buildModifiedEditArgs(request, selected),
    selectedCount: selected.size,
    totalHunks: hunks.length,
  };
}
