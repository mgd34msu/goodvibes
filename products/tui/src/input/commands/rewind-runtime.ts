// ---------------------------------------------------------------------------
// rewind-runtime.ts, /checkpoint rewind (message-anchored, unified files +
// conversation), plus the /undo rewind and /redo rewind reversals over the
// last receipt.
//
// The rewind engine is the platform's UnifiedRewindService (platform/rewind:
// plan() previews + issues a single-use confirm token; apply() is token-gated
// and returns a receipt carrying an undo block). It JOINS the platform's three
// existing history stores, it never adds a fourth. This module wires that
// service to the TUI's in-process stores through the two ports the service
// defines:
//   • RewindWorkspacePort  ← the in-process WorkspaceCheckpointManager (the
//     same store /checkpoint and the daemon's own files-rewind use). The port
//     resolves an anchor's checkpoint by turnId across the session's turn
//     checkpoints; the TUI does not stamp checkpoints with a sessionId, so the
//     adapter returns the full checkpoint list and lets the shared turnId do the
//     join (see rewind-turn-anchors.ts).
//   • RewindConversationPort ← the in-process ConversationManager. preview()
//     reports how many messages truncate to the recorded turn boundary;
//     rewind() truncates and captures the pre- and post-truncation snapshots so
//     /undo rewind and /redo rewind can reverse and re-apply it.
// The undo/redo stacks stay TUI-side: the service reports how to reverse a
// rewind (its receipt's undo block), and this module performs the reversal.
// The stacks are written beside the undo snapshots after every change, so
// /undo rewind still finds a rewind after the TUI restarts.
//
// The owner's own command goes back (or undoes, or redoes) at once: /undo
// rewind and the safety checkpoint put it back. Only a rewind the model runs
// is shown on a Changes preview (ctx.previewChanges) with a question first;
// Esc or closing the preview answers no.
// ---------------------------------------------------------------------------

import {
  UnifiedRewindService,
  type RewindAnchor,
  type RewindCheckpointDiff,
  type RewindCheckpointView,
  type RewindReceipt,
  type RewindRestoreResult,
  type RewindWorkspacePort,
} from '@goodvibes/engine/platform/platform/rewind';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { logger, readDocument, writeDocument } from '@goodvibes/engine/platform/platform/utils';
import { join } from 'node:path';
import type { WorkspaceCheckpointManager } from '@goodvibes/engine/platform/platform/workspace';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { RewindScope } from '@goodvibes/engine/terminal-shell/checkpoint-command';
import type { CommandContext } from '../command-registry.ts';
import { buildRewindReceiptBlock } from '../../core/rewind-receipt.ts';
import { getTurnAnchors, type TurnAnchor } from '@goodvibes/engine/platform/platform/rewind';
import { createConversationRewindPort, type ConversationRewindPort } from '../../runtime/conversation-rewind-port.ts';

// ---------------------------------------------------------------------------
// Ports, bridge the platform rewind service onto the TUI's in-process stores.
// ---------------------------------------------------------------------------

/**
 * Workspace port over the in-process WorkspaceCheckpointManager. The manager's
 * own list()/diff()/restore() satisfy the port shape; list() drops the
 * service's sessionId filter because TUI turn checkpoints are joined by the
 * shared turnId, not a stamped sessionId.
 */
function makeWorkspacePort(mgr: WorkspaceCheckpointManager): RewindWorkspacePort {
  return {
    async list(): Promise<readonly RewindCheckpointView[]> {
      return mgr.list();
    },
    async diff(id: string): Promise<RewindCheckpointDiff> {
      return mgr.diff(id);
    },
    async restore(id: string, opts?: { readonly safetyCheckpoint?: boolean | undefined }): Promise<RewindRestoreResult> {
      return mgr.restore(id, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Per-session rewind state, the platform service (with its wired ports) plus the
// TUI-owned undo/redo stacks of applied receipts.
// ---------------------------------------------------------------------------

interface RewindSessionState {
  readonly service: UnifiedRewindService;
  readonly convPort: ConversationRewindPort;
  readonly undo: RewindReceipt[];
  readonly redo: RewindReceipt[];
  /** Where the two stacks are kept on disk; null when the session has no sessions directory. */
  readonly stackFile: string | null;
}

/** As many receipts as the conversation port keeps undo snapshots for. */
const MAX_KEPT_RECEIPTS = 32;

interface StoredRewindStacks {
  readonly sessionId: string;
  readonly undo: readonly RewindReceipt[];
  readonly redo: readonly RewindReceipt[];
}

function isReceiptFor(sessionId: string, value: unknown): value is RewindReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const undo = v.undo as Record<string, unknown> | null | undefined;
  return v.sessionId === sessionId && typeof v.scope === 'string' && typeof v.appliedAt === 'number'
    && typeof undo === 'object' && undo !== null && 'files' in undo && 'conversation' in undo;
}

/** The stacks a previous run of this session left, or empty ones. */
function loadStacks(stackFile: string, sessionId: string): { undo: RewindReceipt[]; redo: RewindReceipt[] } {
  const stored = readDocument<StoredRewindStacks>(stackFile, {
    label: 'rewind/undo-stack',
    recovery: 'Rewinds applied before this run are no longer listed under /undo rewind; the conversation and files are unchanged.',
    validate: (parsed) => {
      const v = parsed as Partial<StoredRewindStacks> | null;
      if (!v || v.sessionId !== sessionId || !Array.isArray(v.undo) || !Array.isArray(v.redo)) throw new Error('not this session\'s rewind undo stack');
      return v as StoredRewindStacks;
    },
  });
  return {
    undo: (stored?.undo ?? []).filter((r) => isReceiptFor(sessionId, r)),
    redo: (stored?.redo ?? []).filter((r) => isReceiptFor(sessionId, r)),
  };
}

/** One write of both stacks after they changed; a failed write costs only the after-restart listing. */
function saveStacks(state: RewindSessionState, sessionId: string): void {
  if (!state.stackFile) return;
  try {
    writeDocument(state.stackFile, {
      sessionId,
      undo: state.undo.slice(-MAX_KEPT_RECEIPTS),
      redo: state.redo.slice(-MAX_KEPT_RECEIPTS),
    } satisfies StoredRewindStacks, { indent: null });
  } catch (error) {
    logger.warn('Rewind undo list could not be saved; it lasts until this session closes', { sessionId, error: summarizeError(error) });
  }
}

/**
 * Rewind state in memory lives as long as its session is the open one: a
 * resume, load or new session replaces it. The receipts stay on disk, so the
 * session's /undo rewind list comes back when it is resumed or the TUI restarts;
 * an undo still refuses when the conversation changed since the rewind.
 */
const sessions = new Map<string, RewindSessionState>();

/** Get or build the per-session service, capturing the session's live stores. */
function stateFor(ctx: CommandContext): RewindSessionState {
  const sessionId = ctx.session.runtime.sessionId;
  for (const other of [...sessions.keys()]) if (other !== sessionId) sessions.delete(other);
  let state = sessions.get(sessionId);
  if (!state) {
    const mgr = ctx.workspace.workspaceCheckpointManager;
    const conv = ctx.session.conversationManager;
    const surface = ctx.workspace.surface;
    // On disk beside the session's history, so the pre-rewind copy outlives this process.
    const undoDir = surface ? join(surface.sessionsDir, 'rewind-undo') : undefined;
    const convPort = createConversationRewindPort(() => conv, undoDir ? { undoDir } : {});
    const service = new UnifiedRewindService({
      workspace: mgr ? makeWorkspacePort(mgr) : null,
      conversation: convPort,
      anchorSurface: ctx.workspace.surface ?? null,
    });
    const stackFile = undoDir ? join(undoDir, `stack-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) : null;
    const stacks = stackFile ? loadStacks(stackFile, sessionId) : { undo: [], redo: [] };
    state = { service, convPort, undo: stacks.undo, redo: stacks.redo, stackFile };
    sessions.set(sessionId, state);
  }
  return state;
}

/** Reset a session's rewind state. Exposed for tests and session reset. */
export function resetRewindState(sessionId: string): void {
  sessions.delete(sessionId);
}

function wants(scope: RewindScope, part: 'files' | 'conversation'): boolean {
  return scope === 'both' || scope === part;
}

function undoAvailable(receipt: RewindReceipt): boolean {
  return receipt.undo.files !== null || receipt.undo.conversation !== null;
}

// ---------------------------------------------------------------------------
// /undo rewind & /redo rewind, reversal over the last receipt's undo points.
// Called from session-content.ts so the /undo and /redo commands stay single.
// ---------------------------------------------------------------------------

export interface RewindReversalResult {
  readonly handled: boolean;
  readonly message: string;
}

const BUSY_MESSAGE = (what: string): string =>
  `A turn is still running, so ${what} was not started and nothing changed. Stop it with Esc or let it finish, then retry.`;

/**
 * Shows what restoring `checkpointId` would do to the working tree and asks,
 * the same Changes preview /checkpoint rewind uses. Work done since the rewind (turns or
 * hand edits) is in that diff, so it is never replaced unseen.
 */
async function confirmFileRestore(
  ctx: CommandContext,
  mgr: WorkspaceCheckpointManager,
  checkpointId: string,
  question: string,
): Promise<'confirmed' | 'cancelled' | 'no-preview'> {
  // The owner's own /undo rewind or /redo rewind is the request: the restore takes a safety checkpoint first,
  // so it runs at once. Only one the model runs is shown and asked about.
  if (ctx.invokedByModel !== true) return 'confirmed';
  if (!ctx.previewChanges) return 'no-preview';
  let diff: string | undefined;
  let note: string | undefined;
  try {
    const result = await mgr.diff(checkpointId);
    if (result.unifiedDiff.trim()) diff = result.unifiedDiff;
    else note = 'The working tree already matches; no file changes.';
  } catch {
    note = 'Could not load the diff of the files this would restore.';
  }
  ctx.renderRequest();
  const confirmed = await ctx.previewChanges({
    title: question,
    diff,
    note,
    question: { text: `${question} A safety checkpoint of the current files is taken first.`, confirmLabel: 'Restore', tone: 'warning' },
  });
  return confirmed ? 'confirmed' : 'cancelled';
}

const NO_PREVIEW_MESSAGE = (what: string): string =>
  `${what} was not started: restoring files needs the Changes view to show what would be overwritten, and it is not available in this session. Nothing changed.`;

export async function undoLastRewind(ctx: CommandContext): Promise<RewindReversalResult> {
  const result = await undoLastRewindNow(ctx);
  saveStacks(stateFor(ctx), ctx.session.runtime.sessionId);
  return result;
}

async function undoLastRewindNow(ctx: CommandContext): Promise<RewindReversalResult> {
  if (ctx.isGenerating?.()) return { handled: true, message: BUSY_MESSAGE('undoing the rewind') };
  const state = stateFor(ctx);
  const receipt = state.undo.pop();
  if (!receipt) return { handled: false, message: 'No applied rewind to undo. (Bare /undo removes the last conversation turn.)' };

  // The pre-rewind copy replaces the whole conversation, so it is only safe
  // while nothing newer has been added since the rewind. Nothing is touched
  // otherwise, files included, and the receipt stays undoable.
  const since = receipt.undo.conversation ? state.convPort.messagesSinceRewind(receipt.undo.conversation.undoSnapshotId) : 0;
  if (since !== null && since !== 0) {
    state.undo.push(receipt);
    return { handled: true, message: `Undo rewind refused: the conversation has ${since > 0 ? `${since} newer message${since === 1 ? '' : 's'}` : 'changed'} since the rewind, and restoring the earlier copy would discard ${since > 0 ? 'them' : 'that change'}. Nothing was changed. Copy what you need, or use /session fork to keep this conversation, before rewinding again.` };
  }

  const mgr = ctx.workspace.workspaceCheckpointManager;
  if (receipt.undo.files && mgr) {
    const answer = await confirmFileRestore(ctx, mgr, receipt.undo.files.restoreCheckpointId, 'Undo the rewind: put the files back as they were before it?');
    if (answer !== 'confirmed' || ctx.isGenerating?.()) {
      state.undo.push(receipt);
      return {
        handled: true,
        message: answer === 'no-preview' ? NO_PREVIEW_MESSAGE('Undo rewind')
          : answer === 'cancelled' ? 'Undo rewind cancelled: nothing changed. The rewind is still listed under /undo rewind.'
          : BUSY_MESSAGE('undoing the rewind'),
      };
    }
    // The question took time: a message added meanwhile is checked again before anything changes.
    const sinceConfirm = receipt.undo.conversation ? state.convPort.messagesSinceRewind(receipt.undo.conversation.undoSnapshotId) : 0;
    if (sinceConfirm !== null && sinceConfirm !== 0) {
      state.undo.push(receipt);
      return { handled: true, message: `Undo rewind refused: the conversation changed while you were asked (${sinceConfirm > 0 ? `${sinceConfirm} newer message${sinceConfirm === 1 ? '' : 's'}` : 'an edit'}). Nothing was changed.` };
    }
  }
  const parts: string[] = [];
  let conversationFailed = false;
  let filesFailed = '';
  try {
    if (receipt.undo.files && mgr) {
      const restored = await mgr.restore(receipt.undo.files.restoreCheckpointId, { safetyCheckpoint: true });
      const failed = restored.failedPaths ?? [];
      if (failed.length > 0) {
        filesFailed = failed.map((f) => `${f.path}: ${f.reason}`).join('; ');
        parts.push(`files only partly restored (${failed.length} path${failed.length === 1 ? '' : 's'} failed)`);
      } else {
        parts.push('files restored to pre-rewind state');
      }
    }
    if (receipt.undo.conversation) {
      const restored = await state.convPort.restoreBeforeSaved(receipt.undo.conversation.undoSnapshotId);
      if (restored.restored) {
        state.service.anchorsRestored(receipt.undo.conversation.undoSnapshotId);
        parts.push(restored.notSaved === undefined
          ? 'conversation restored to pre-rewind state'
          : `conversation restored to pre-rewind state but not saved (${restored.notSaved}); a restart brings back the rewound one`);
      }
      else conversationFailed = true;
    }
  } catch (err) {
    state.undo.push(receipt);
    return { handled: true, message: `Undo rewind failed: ${summarizeError(err)}` };
  }
  if (filesFailed) {
    // Files that could not be put back mean the undo did not complete; keep it retryable.
    // A conversation that was already restored is not part of the retry: its
    // pre-rewind copy is now live, so the newer-messages guard would refuse
    // every later attempt and the files would never be retried.
    const conversationDone = receipt.undo.conversation !== null && !conversationFailed;
    state.undo.push(conversationDone ? { ...receipt, undo: { ...receipt.undo, conversation: null } } : receipt);
    ctx.renderRequest();
    return {
      handled: true,
      message: `Rewind only partly undone: ${parts.join(', ')}; could not restore ${filesFailed}${conversationFailed ? '; the conversation could not be restored either' : ''}. The rewind is still listed under /undo rewind.`,
    };
  }
  if (conversationFailed) {
    // Half an undo is reported as half, and the receipt stays undoable.
    state.undo.push(receipt);
    ctx.renderRequest();
    return {
      handled: true,
      message: `Rewind only partly undone: ${parts.join(', ') || 'no files were reversed'}; the conversation could not be restored (its pre-rewind copy is gone). The rewind is still listed under /undo rewind.`,
    };
  }
  state.redo.push(receipt);
  ctx.renderRequest();
  return { handled: true, message: `Rewind undone: ${parts.join(', ') || 'nothing to reverse'}. Use /redo rewind to re-apply.` };
}

export async function redoLastRewind(ctx: CommandContext): Promise<RewindReversalResult> {
  const result = await redoLastRewindNow(ctx);
  saveStacks(stateFor(ctx), ctx.session.runtime.sessionId);
  return result;
}

async function redoLastRewindNow(ctx: CommandContext): Promise<RewindReversalResult> {
  if (ctx.isGenerating?.()) return { handled: true, message: BUSY_MESSAGE('re-applying the rewind') };
  const state = stateFor(ctx);
  const receipt = state.redo.pop();
  if (!receipt) return { handled: false, message: 'No undone rewind to redo. (Bare /redo restores the last conversation turn.)' };

  // Re-applying the rewind replaces the whole conversation with the rewound copy, so it is
  // only safe while nothing was added since the undo, as /undo rewind requires of the rewind.
  const sinceUndo = (): number | null => receipt.undo.conversation ? state.convPort.messagesSinceUndo(receipt.undo.conversation.undoSnapshotId) : 0;
  const refusedSince = (since: number): RewindReversalResult => {
    state.redo.push(receipt);
    return { handled: true, message: `Redo rewind refused: the conversation has ${since > 0 ? `${since} newer message${since === 1 ? '' : 's'}` : 'changed'} since the rewind was undone, and re-applying it would discard ${since > 0 ? 'them' : 'that change'}. Nothing was changed. Use /session fork to keep this conversation, then rewind again.` };
  };
  const before = sinceUndo();
  if (before !== null && before !== 0) return refusedSince(before);

  const mgr = ctx.workspace.workspaceCheckpointManager;
  if (receipt.files?.checkpointId && mgr) {
    const answer = await confirmFileRestore(ctx, mgr, receipt.files.checkpointId, 'Redo the rewind: restore the files to the rewound turn again?');
    if (answer !== 'confirmed' || ctx.isGenerating?.()) {
      state.redo.push(receipt);
      return {
        handled: true,
        message: answer === 'no-preview' ? NO_PREVIEW_MESSAGE('Redo rewind')
          : answer === 'cancelled' ? 'Redo rewind cancelled: nothing changed. The rewind is still listed under /redo rewind.'
          : BUSY_MESSAGE('re-applying the rewind'),
      };
    }
    const afterConfirm = sinceUndo();
    if (afterConfirm !== null && afterConfirm !== 0) return refusedSince(afterConfirm);
  }
  const parts: string[] = [];
  let conversationFailed = false;
  let filesFailed = '';
  try {
    if (receipt.files?.checkpointId && mgr) {
      const restored = await mgr.restore(receipt.files.checkpointId, { safetyCheckpoint: true });
      const failed = restored.failedPaths ?? [];
      if (failed.length > 0) {
        filesFailed = failed.map((f) => `${f.path}: ${f.reason}`).join('; ');
        parts.push(`files only partly re-applied (${failed.length} path${failed.length === 1 ? '' : 's'} failed)`);
      } else {
        parts.push('files re-applied');
      }
    }
    if (receipt.undo.conversation) {
      const restored = await state.convPort.restoreAfterSaved(receipt.undo.conversation.undoSnapshotId);
      if (restored.restored) {
        state.service.anchorsDropped(receipt.undo.conversation.undoSnapshotId);
        parts.push(restored.notSaved === undefined
          ? 'conversation re-applied'
          : `conversation re-applied but not saved (${restored.notSaved}); a restart brings back the one before`);
      }
      else conversationFailed = true;
    }
  } catch (err) {
    state.redo.push(receipt);
    return { handled: true, message: `Redo rewind failed: ${summarizeError(err)}` };
  }
  if (conversationFailed) {
    state.redo.push(receipt);
    ctx.renderRequest();
    return {
      handled: true,
      message: `Rewind only partly re-applied: ${parts.join(', ') || 'no files were re-applied'}; the conversation could not be re-applied (its snapshot is gone). The rewind is still listed under /redo rewind.`,
    };
  }
  if (filesFailed) {
    // The rewind is applied in part. With the conversation re-applied it moves to the undo
    // list (a redo retry would re-apply the conversation twice); otherwise it stays redoable.
    const conversationDone = receipt.undo.conversation !== null;
    (conversationDone ? state.undo : state.redo).push(receipt);
    ctx.renderRequest();
    return {
      handled: true,
      message: `Rewind only partly re-applied: ${parts.join(', ')}; could not restore ${filesFailed}. ${conversationDone ? 'The rewind is listed under /undo rewind.' : 'The rewind is still listed under /redo rewind.'}`,
    };
  }
  state.undo.push(receipt);
  ctx.renderRequest();
  return { handled: true, message: `Rewind re-applied: ${parts.join(', ') || 'nothing to re-apply'}.` };
}

// ---------------------------------------------------------------------------
// /checkpoint rewind: resolve the turn, read the plan, show it, ask, apply it.
// ---------------------------------------------------------------------------

/** Recent turns, NEWEST first, numbered 1..N as the picker lists them. */
function recentTurnsNewestFirst(sessionId: string): TurnAnchor[] {
  return [...getTurnAnchors(sessionId)].reverse();
}

/** Resolve a user ref ('1'..'N' newest-first, or a turnId / turnId prefix) to an anchor turn. */
function resolveRef(turns: readonly TurnAnchor[], ref: string): TurnAnchor | { error: string } {
  if (/^\d+$/.test(ref)) {
    const turn = turns[Number(ref) - 1];
    return turn ? turn : { error: `No turn #${ref}; this conversation has ${turns.length} (/checkpoint rewind lists them, newest first).` };
  }
  const exact = turns.find((t) => t.turnId === ref);
  if (exact) return exact;
  const prefix = turns.filter((t) => t.turnId.startsWith(ref));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return { error: `Turn "${ref}" is ambiguous (${prefix.length} match); use its number from the list instead.` };
  return { error: `No turn "${ref}" in this conversation (/checkpoint rewind lists them, newest first).` };
}

/**
 * Goes back to a completed turn: the platform rewind service plans it (and
 * issues a single-use token bound to that plan), the plan is shown on the
 * Changes preview with the question, and only a yes applies it, with that
 * token. The service refuses the token when the conversation changed after
 * the preview, so what is applied is exactly what was shown.
 */
export async function rewindToTurn(ctx: CommandContext, input: { readonly turn: string; readonly scope: RewindScope }): Promise<string | void> {
  const sessionId = ctx.session.runtime.sessionId;
  const { scope } = input;
  const turns = recentTurnsNewestFirst(sessionId);
  if (turns.length === 0) {
    throw commandRefusal('No completed turns are recorded for this conversation yet, so there is nothing to go back to.', 'Put the files back to a workspace checkpoint instead: /checkpoint restore');
  }
  if (ctx.isGenerating?.()) throw commandRefusal(BUSY_MESSAGE('going back to a turn'), undefined, 'BUSY');
  const resolved = resolveRef(turns, input.turn);
  if ('error' in resolved) throw commandRefusal(resolved.error, undefined, 'NOT_FOUND');
  const anchor: RewindAnchor = { sessionId, turnId: resolved.turnId };
  if (wants(scope, 'files') && !ctx.workspace.workspaceCheckpointManager) {
    throw commandRefusal('Checkpoints are not available in this session, so the files cannot go back.', `Take back only the conversation: /checkpoint rewind ${input.turn} conversation`, 'UNAVAILABLE');
  }
  // The owner's own command is the request: it goes back at once, and /undo rewind puts it back. Only a rewind
  // the model asks for is shown on the Changes preview with a question first.
  const asked = ctx.invokedByModel === true;
  if (asked && !ctx.previewChanges) {
    throw commandRefusal('Going back needs the Changes preview to show what would change, and it is not available in this session. Nothing changed.', undefined, 'UNAVAILABLE');
  }

  const state = stateFor(ctx);
  let plan: Awaited<ReturnType<UnifiedRewindService['plan']>>;
  try {
    plan = await state.service.plan(anchor, scope);
  } catch (error) {
    throw commandRefusal(`Could not plan going back: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  const filesAvailable = plan.files?.available ?? false;
  const conversationAvailable = plan.conversation?.available ?? false;
  if (!filesAvailable && !conversationAvailable) {
    throw commandRefusal([`Nothing to take back after turn "${resolved.label}" (${scope}).`, ...plan.warnings.map((w) => `  note: ${w}`)].join('\n'));
  }

  // The plan's diff, shown on Changes with the question on it.
  let diff: string | undefined;
  let note: string | undefined;
  const checkpointId = plan.files?.checkpointId ?? null;
  if (filesAvailable && checkpointId && ctx.workspace.workspaceCheckpointManager) {
    try {
      const result = await ctx.workspace.workspaceCheckpointManager.diff(checkpointId);
      if (result.unifiedDiff.trim()) diff = result.unifiedDiff;
      else note = 'The working tree already matches this checkpoint.';
    } catch {
      note = 'Could not load the checkpoint diff.';
    }
  } else {
    const drop = plan.conversation?.messagesToDrop ?? 0;
    const remaining = plan.conversation?.messagesRemaining ?? 0;
    note = `Conversation only: ${remaining} message(s) stay, ${drop} after this turn are dropped. No files change.`;
  }
  const summaryParts: string[] = [];
  if (wants(scope, 'files')) summaryParts.push(filesAvailable ? `${plan.files?.affectedFileCount ?? 0} file(s)` : 'files: none');
  if (wants(scope, 'conversation')) summaryParts.push(conversationAvailable ? `${plan.conversation?.messagesToDrop ?? 0} message(s)` : 'conversation: unavailable');

  for (const w of plan.warnings) ctx.print(`  note: ${w}`);
  if (asked && ctx.previewChanges) {
    ctx.print(`Previewing going back to turn "${resolved.label}" (${scope}: ${summaryParts.join(', ')}). Enter or y goes back, n or Esc cancels.`);
    ctx.renderRequest();
    const confirmed = await ctx.previewChanges({
      title: `go back to ${resolved.label}`,
      diff,
      note,
      question: { text: `Go back to "${resolved.label}" (${scope}: ${summaryParts.join(', ')})? Dropped messages come back with /undo rewind only while no new message is added.`, confirmLabel: 'Go back', tone: 'warning' },
    });
    if (!confirmed) {
      ctx.renderRequest();
      return 'Nothing changed: you chose not to go back.';
    }
    // The preview waits on the owner; a turn may have started meanwhile.
    if (ctx.isGenerating?.()) throw commandRefusal(BUSY_MESSAGE('going back to the turn'), undefined, 'BUSY');
  }
  let result: Awaited<ReturnType<UnifiedRewindService['apply']>>;
  try {
    // The token binds the apply to the plan shown: a conversation changed since is refused.
    result = await state.service.apply(anchor, scope, { confirmToken: plan.token });
  } catch (error) {
    throw commandRefusal(`Going back failed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  const receipt = result.receipt;
  if (!receipt) throw commandRefusal(`Nothing changed: ${result.refusal?.reason ?? 'the plan shown no longer matches the conversation'}.`, '/checkpoint rewind shows the plan again.');
  if (undoAvailable(receipt)) {
    state.undo.push(receipt);
    state.redo.length = 0; // a fresh apply invalidates the redo stack
    saveStacks(state, anchor.sessionId);
  }
  // addTypedSystemMessage persists the receipt into real session history
  // (indexed by getTranscriptEventIndex + save/load), and the [Rewind] prefix
  // is force-surfaced inline (system-message-router.ts).
  ctx.session.conversationManager.addTypedSystemMessage(
    buildRewindReceiptBlock({ ...receipt, undoAvailable: undoAvailable(receipt) }),
    'operational',
  );
  ctx.renderRequest();
}
