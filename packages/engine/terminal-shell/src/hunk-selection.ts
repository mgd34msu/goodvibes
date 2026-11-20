/**
 * Per-hunk accept/reject at a terminal approval card, shared by both terminal
 * apps.
 *
 * Which entries are hunks, the text each will write and the arguments that run
 * when only some are approved are the platform's (control-plane
 * approval-hunk-apply.ts). This module holds only the terminal's part: the
 * selection state, the keys that move and toggle it, and the answer the card
 * sends. The answer carries `selectedHunks`, which the approval broker applies,
 * plus the same reduced arguments built by the platform rule for a resolver
 * that forwards arguments only.
 */
import {
  buildModifiedEditArgs,
  isHunkSelectableRequest,
  readApprovalEditHunks,
  type EditHunkLike,
} from '@goodvibes/engine/platform/platform/control-plane/approval-hunk-apply';
import type { PermissionPromptRequest } from '@goodvibes/engine/platform/platform/permissions';

export interface HunkSelectionState {
  readonly hunks: readonly EditHunkLike[];
  readonly cursor: number;
  readonly selected: ReadonlySet<number>;
}

export type HunkCommit = 'apply' | 'cancel' | null;

export interface HunkKeyResult {
  readonly state: HunkSelectionState;
  readonly commit: HunkCommit;
}

/** What a card sends when the owner applies a hunk selection. */
export interface HunkSelectionAnswer {
  /** Indices into the request's own `edits`, ascending. The broker applies these. */
  readonly selectedHunks: readonly number[];
  /** The same selection as arguments, for a resolver that forwards arguments only. */
  readonly modifiedArgs: Record<string, unknown>;
}

/**
 * True iff this is a multi-edit `edit` call. Single-edit `edit` calls, `write`
 * calls and everything else keep the plain approve/deny card.
 */
export function isHunkSelectable(request: Pick<PermissionPromptRequest, 'tool' | 'args'>): boolean {
  return isHunkSelectableRequest(request);
}

/** Initial state: every hunk selected, so the zero-navigation answer approves everything. */
export function buildHunkSelectionState(request: Pick<PermissionPromptRequest, 'args'>): HunkSelectionState {
  const hunks = readApprovalEditHunks(request.args) ?? [];
  return { hunks, cursor: 0, selected: new Set(hunks.map((_, index) => index)) };
}

/** The answer for the current selection. */
export function hunkSelectionAnswer(request: Pick<PermissionPromptRequest, 'args'>, state: HunkSelectionState): HunkSelectionAnswer {
  const selectedHunks = [...state.selected].sort((a, b) => a - b);
  return { selectedHunks, modifiedArgs: buildModifiedEditArgs(request, selectedHunks) };
}

/**
 * Pure reducer over raw stdin `data` for an active hunk-selection card. Raw
 * data, not the normalized key, because Space must stay distinguishable.
 */
export function applyHunkKey(state: HunkSelectionState, data: string): HunkKeyResult {
  const lower = data.toLowerCase().trim();
  if (data === 'j' || data === '\x1b[B') {
    return { state: { ...state, cursor: Math.min(state.hunks.length - 1, state.cursor + 1) }, commit: null };
  }
  if (data === 'k' || data === '\x1b[A') {
    return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, commit: null };
  }
  if (data === ' ') {
    const next = new Set(state.selected);
    if (next.has(state.cursor)) next.delete(state.cursor);
    else next.add(state.cursor);
    return { state: { ...state, selected: next }, commit: null };
  }
  if (lower === 'a') {
    return { state: { ...state, selected: new Set(state.hunks.map((_, index) => index)) }, commit: null };
  }
  if (data === '\r' || data === '\n') {
    // Nothing selected: the card stays open rather than applying an empty edit.
    if (state.selected.size === 0) return { state, commit: null };
    return { state, commit: 'apply' };
  }
  if (lower === 'y') {
    return { state: { ...state, selected: new Set(state.hunks.map((_, index) => index)) }, commit: 'apply' };
  }
  if (lower === 'n' || data === '\x1b' || data === '\x03') {
    return { state, commit: 'cancel' };
  }
  return { state, commit: null };
}
