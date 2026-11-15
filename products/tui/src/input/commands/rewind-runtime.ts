// ---------------------------------------------------------------------------
// rewind-runtime.ts, /rewind (message-anchored, unified files + conversation),
// plus the /undo rewind and /redo rewind reversals over the last receipt.
//
// The rewind engine is the platform's UnifiedRewindService (platform/rewind:
// plan() previews + issues a single-use confirm token; apply() is token-gated
// and returns a receipt carrying an undo block). It JOINS the platform's three
// existing history stores, it never adds a fourth. This module wires that
// service to the TUI's in-process stores through the two ports the service
// defines:
//   • RewindWorkspacePort  ← the in-process WorkspaceCheckpointManager (the
//     same store /checkpoints and the daemon's own files-rewind use). The port
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
//
// The confirm step is a question on a Changes preview (ctx.previewChanges):
// the handler resolves the anchor, shows exactly what changes, and waits for
// the answer; Esc or closing the preview answers no.
// ---------------------------------------------------------------------------

import {
  UnifiedRewindService,
  type RewindAnchor,
  type RewindCheckpointDiff,
  type RewindCheckpointView,
  type RewindReceipt,
  type RewindRestoreResult,
  type RewindScope as PlatformRewindScope,
  type RewindWorkspacePort,
} from '@goodvibes-jev/engine/platform/platform/rewind';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { join } from 'node:path';
import type { WorkspaceCheckpoint, WorkspaceCheckpointManager } from '@goodvibes-jev/engine/platform/platform/workspace';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { buildRewindReceiptBlock } from '../../core/rewind-receipt.ts';
import { getTurnAnchors, type TurnAnchor } from '@goodvibes-jev/engine/platform/platform/rewind';
import { createConversationRewindPort, type ConversationRewindPort } from '../../runtime/conversation-rewind-port.ts';
import { shortId } from './checkpoint-runtime.ts';

export type RewindScope = PlatformRewindScope;
const REWIND_SCOPES: readonly RewindScope[] = ['files', 'conversation', 'both'];

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
}

/**
 * Rewind state lives as long as its session is the open one: a resume, load or
 * new session replaces it, and the replaced session's receipts go with it (an
 * undo receipt points into a conversation that is no longer live).
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
    const convPort = createConversationRewindPort(() => conv, surface ? { undoDir: join(surface.sessionsDir, 'rewind-undo') } : {});
    const service = new UnifiedRewindService({
      workspace: mgr ? makeWorkspacePort(mgr) : null,
      conversation: convPort,
      anchorSurface: ctx.workspace.surface ?? null,
    });
    state = { service, convPort, undo: [], redo: [] };
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
 * the same Changes preview /rewind uses. Work done since the rewind (turns or
 * hand edits) is in that diff, so it is never replaced unseen.
 */
async function confirmFileRestore(
  ctx: CommandContext,
  mgr: WorkspaceCheckpointManager,
  checkpointId: string,
  question: string,
): Promise<'confirmed' | 'cancelled' | 'no-preview'> {
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
      if (state.convPort.restoreBefore(receipt.undo.conversation.undoSnapshotId)) {
        state.service.anchorsRestored(receipt.undo.conversation.undoSnapshotId);
        parts.push('conversation restored to pre-rewind state');
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
  if (ctx.isGenerating?.()) return { handled: true, message: BUSY_MESSAGE('re-applying the rewind') };
  const state = stateFor(ctx);
  const receipt = state.redo.pop();
  if (!receipt) return { handled: false, message: 'No undone rewind to redo. (Bare /redo restores the last conversation turn.)' };

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
      if (state.convPort.restoreAfter(receipt.undo.conversation.undoSnapshotId)) {
        state.service.anchorsDropped(receipt.undo.conversation.undoSnapshotId);
        parts.push('conversation re-applied');
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
// Recent-turns picker + anchor resolution
// ---------------------------------------------------------------------------

function formatAge(atMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Recent turns, NEWEST first, numbered 1..N for the picker. */
function recentTurnsNewestFirst(sessionId: string): TurnAnchor[] {
  return [...getTurnAnchors(sessionId)].reverse();
}

function renderTurnList(sessionId: string): string {
  const turns = recentTurnsNewestFirst(sessionId);
  if (turns.length === 0) {
    return 'No completed turns recorded this run yet. /rewind targets turns completed in the current session run.';
  }
  const lines = ['Recent turns (newest first): /rewind <n> [files|conversation|both]:'];
  turns.slice(0, 20).forEach((t, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. ${t.label}  (${formatAge(t.at)}, ${t.messageCount} msgs)`);
  });
  lines.push('Default scope is "both" (files + conversation). Files resolve only for turns that changed files.');
  return lines.join('\n');
}

/** Resolve a user ref ('1'..'N' newest-first, or a turnId / turnId prefix) to an anchor turn. */
function resolveRef(sessionId: string, ref: string): TurnAnchor | { error: string } {
  const turns = recentTurnsNewestFirst(sessionId);
  if (turns.length === 0) return { error: 'No completed turns recorded this run yet.' };
  if (/^\d+$/.test(ref)) {
    const idx = Number(ref) - 1;
    const turn = turns[idx];
    return turn ? turn : { error: `No turn #${ref}. Run /rewind to list recent turns (1–${turns.length}).` };
  }
  const exact = turns.find((t) => t.turnId === ref);
  if (exact) return exact;
  const prefix = turns.filter((t) => t.turnId.startsWith(ref));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return { error: `Turn ref "${ref}" is ambiguous (${prefix.length} matches). Use the list number instead.` };
  return { error: `Unknown turn ref "${ref}". Run /rewind to list recent turns.` };
}

function parseScope(token: string | undefined): RewindScope | null {
  if (token === undefined) return 'both';
  const lower = token.toLowerCase();
  return (REWIND_SCOPES as readonly string[]).includes(lower) ? (lower as RewindScope) : null;
}

// ---------------------------------------------------------------------------
// Checkpoint-only fallback, no completed turns recorded THIS run (e.g. right
// after a restart) means the message-anchored picker above has nothing to
// list, even though real workspace checkpoints exist on disk. Rather than
// dead-ending on "no completed turns" while /checkpoints and the boot notice
// both point back here, /rewind falls back to listing and restoring
// checkpoints directly, a FILES-ONLY restore (there is no turn anchor to
// join a conversation boundary against), reusing the same diff
// preview/confirm idiom as the turn-anchored path above.
// ---------------------------------------------------------------------------

const CHECKPOINT_FALLBACK_NO_ANCHORS_MESSAGE = 'No completed turns recorded this run yet. /rewind targets turns completed in the current session run.';

function renderCheckpointFallbackList(checkpoints: readonly WorkspaceCheckpoint[]): string {
  const lines = [
    'No completed turns recorded this run yet; falling back to workspace checkpoints (FILES ONLY, no conversation state):',
    ...checkpoints.slice(0, 20).map((cp, i) => `  ${String(i + 1).padStart(2)}. ${shortId(cp.id).padEnd(12)} ${cp.kind.padEnd(9)} ${cp.label}  (${formatAge(cp.createdAt)})`),
    'Restore one: /rewind <n|id>; files only; conversation history is untouched.',
  ];
  return lines.join('\n');
}

/** Resolve a user ref ('1'..'N' newest-first, or a checkpoint id / id prefix) to a checkpoint. */
function resolveCheckpointRef(checkpoints: readonly WorkspaceCheckpoint[], ref: string): WorkspaceCheckpoint | { error: string } {
  if (/^\d+$/.test(ref)) {
    const idx = Number(ref) - 1;
    const cp = checkpoints[idx];
    return cp ? cp : { error: `No checkpoint #${ref}. Run /rewind to list checkpoints (1–${checkpoints.length}).` };
  }
  const exact = checkpoints.find((cp) => cp.id === ref);
  if (exact) return exact;
  const prefix = checkpoints.filter((cp) => cp.id.startsWith(ref) || shortId(cp.id).startsWith(ref));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return { error: `Checkpoint ref "${ref}" is ambiguous (${prefix.length} matches). Use the list number instead.` };
  return { error: `Unknown checkpoint ref "${ref}". Run /rewind to list checkpoints.` };
}

/**
 * Handles bare `/rewind` and `/rewind <ref>` when this run has recorded no
 * turn anchors at all. Returns true if it handled the invocation (always,
 * once called), false is never returned, kept boolean-shaped only to mirror
 * the calling convention at the call site.
 */
async function handleCheckpointOnlyRewind(args: string[], ctx: CommandContext): Promise<void> {
  const mgr = ctx.workspace.workspaceCheckpointManager;
  if (!mgr) {
    ctx.print(CHECKPOINT_FALLBACK_NO_ANCHORS_MESSAGE);
    return;
  }
  let checkpoints: WorkspaceCheckpoint[];
  try {
    checkpoints = await mgr.list();
  } catch {
    checkpoints = [];
  }
  if (checkpoints.length === 0) {
    ctx.print(CHECKPOINT_FALLBACK_NO_ANCHORS_MESSAGE);
    return;
  }

  if (args.length === 0) {
    ctx.print(renderCheckpointFallbackList(checkpoints));
    return;
  }

  // A restore under a running turn would interleave with its file writes.
  if (ctx.isGenerating?.()) {
    ctx.print(BUSY_MESSAGE('restoring the checkpoint'));
    return;
  }
  const resolved = resolveCheckpointRef(checkpoints, args[0]!);
  if ('error' in resolved) {
    ctx.print(resolved.error);
    return;
  }
  const checkpoint = resolved;

  let diff: string | undefined;
  let note: string | undefined;
  try {
    const result = await mgr.diff(checkpoint.id);
    if (result.unifiedDiff.trim()) diff = result.unifiedDiff;
    else note = 'The working tree already matches this checkpoint.';
  } catch {
    note = 'Could not load the checkpoint diff.';
  }
  if (!ctx.previewChanges) {
    ctx.print('Previewing a restore needs the Changes view, which is not available in this session.');
    return;
  }

  ctx.print(`Previewing checkpoint restore: "${checkpoint.label}" (files only; no conversation state this run). Enter or y restores, n or Esc cancels.`);
  ctx.renderRequest();
  const confirmed = await ctx.previewChanges({
    title: checkpoint.label,
    diff,
    note,
    question: { text: `Restore "${checkpoint.label}"? Files only: no conversation state this run.`, confirmLabel: 'Restore', tone: 'warning' },
  });
  if (!confirmed) {
    ctx.print('Restore cancelled: nothing changed.');
    ctx.renderRequest();
    return;
  }
  // The preview waits on the owner; a turn may have started meanwhile.
  if (ctx.isGenerating?.()) {
    ctx.print(BUSY_MESSAGE('restoring the checkpoint'));
    return;
  }
  try {
    const restored = await mgr.restore(checkpoint.id, { safetyCheckpoint: true });
    const failed = restored.failedPaths ?? [];
    if (failed.length > 0) {
      const names = failed.map((f) => `${f.path}: ${f.reason}`).join('; ');
      ctx.print(`Checkpoint only partly restored (${failed.length} path${failed.length === 1 ? '' : 's'} failed): ${names}. Files only; conversation state is unchanged.`);
      ctx.renderRequest();
      return;
    }
    ctx.session.conversationManager.addTypedSystemMessage(
      `[Rewind] Restored files from checkpoint ${shortId(checkpoint.id)} ("${checkpoint.label}"). Files only: no turn anchors exist this run, so conversation state is unchanged.`,
      'operational',
    );
  } catch (err) {
    ctx.print(`Checkpoint restore failed: ${summarizeError(err)}`);
  }
  ctx.renderRequest();
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerRewindRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'rewind',
    description: 'Rewind files, conversation, or both to a completed turn (preview + confirm)',
    usage: '[<n|turnId> [files|conversation|both]]',
    argsHint: '[<n> [files|conversation|both]]',
    handler: async (args, ctx: CommandContext) => {
      const sessionId = ctx.session.runtime.sessionId;

      // No turn anchors recorded this run (most commonly: right after a
      // restart, before /session resume has restored any), fall back to a
      // files-only restore over the real workspace checkpoints instead of a
      // dead end (see handleCheckpointOnlyRewind's header doc).
      if (recentTurnsNewestFirst(sessionId).length === 0) {
        await handleCheckpointOnlyRewind(args, ctx);
        return;
      }

      if (args.length === 0) {
        ctx.print(renderTurnList(sessionId));
        return;
      }

      if (ctx.isGenerating?.()) {
        ctx.print(BUSY_MESSAGE('/rewind'));
        return;
      }

      const scope = parseScope(args[1]);
      if (scope === null) {
        ctx.print(`Unknown scope "${args[1]}". Use one of: files | conversation | both.`);
        return;
      }
      const resolved = resolveRef(sessionId, args[0]!);
      if ('error' in resolved) {
        ctx.print(resolved.error);
        return;
      }
      const anchor: RewindAnchor = { sessionId, turnId: resolved.turnId };

      if (wants(scope, 'files') && !ctx.workspace.workspaceCheckpointManager) {
        ctx.print('Checkpoints are not available in this session; files rewind cannot run. Try /rewind <n> conversation.');
        return;
      }

      const state = stateFor(ctx);
      const plan = await state.service.plan(anchor, scope).catch((err) => {
        ctx.print(`Could not plan rewind: ${summarizeError(err)}`);
        return null;
      });
      if (!plan) return;

      const filesAvailable = plan.files?.available ?? false;
      const conversationAvailable = plan.conversation?.available ?? false;
      if (!filesAvailable && !conversationAvailable) {
        ctx.print(`Nothing to rewind for turn "${resolved.label}" at scope ${scope}.`);
        for (const w of plan.warnings) ctx.print(`  note: ${w}`);
        return;
      }

      // Preview what changes in Changes, with the question on it.
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
        note = `Conversation rewind: keep ${remaining} message(s), drop ${drop} after this turn. No files change.`;
      }

      const summaryParts: string[] = [];
      if (wants(scope, 'files')) summaryParts.push(filesAvailable ? `${plan.files?.affectedFileCount ?? 0} file(s)` : 'files: none');
      if (wants(scope, 'conversation')) summaryParts.push(conversationAvailable ? `${plan.conversation?.messagesToDrop ?? 0} message(s)` : 'conversation: unavailable');
      if (!ctx.previewChanges) {
        ctx.print('Previewing a rewind needs the Changes view, which is not available in this session.');
        return;
      }

      ctx.print(`Previewing rewind of turn "${resolved.label}" (${scope}: ${summaryParts.join(', ')}). Enter or y rewinds, n or Esc cancels.`);
      for (const w of plan.warnings) ctx.print(`  note: ${w}`);
      ctx.renderRequest();
      const confirmed = await ctx.previewChanges({
        title: `rewind ${resolved.label}`,
        diff,
        note,
        question: { text: `Rewind ${scope} to "${resolved.label}"? (${summaryParts.join(', ')})`, confirmLabel: 'Rewind', tone: 'warning' },
      });
      if (!confirmed) {
        ctx.print('Rewind cancelled: nothing changed.');
        ctx.renderRequest();
        return;
      }
      // The preview waits on the owner; a turn may have started meanwhile.
      if (ctx.isGenerating?.()) {
        ctx.print(BUSY_MESSAGE('applying the rewind'));
        return;
      }
      try {
        const result = await state.service.apply(anchor, scope, { confirmToken: plan.token });
        const receipt = result.receipt;
        if (!receipt) {
          ctx.print(`Rewind not applied: ${result.refusal?.reason ?? 'confirmation was refused.'}`);
          return;
        }
        if (undoAvailable(receipt)) {
          state.undo.push(receipt);
          state.redo.length = 0; // a fresh apply invalidates the redo stack
        }
        // addTypedSystemMessage persists the receipt into real session
        // history (indexed by getTranscriptEventIndex + save/load), and the
        // [Rewind] prefix is force-surfaced inline (system-message-router.ts).
        ctx.session.conversationManager.addTypedSystemMessage(
          buildRewindReceiptBlock({ ...receipt, undoAvailable: undoAvailable(receipt) }),
          'operational',
        );
        ctx.renderRequest();
      } catch (err) {
        ctx.print(`Rewind failed: ${summarizeError(err)}`);
      }
    },
  });
}
