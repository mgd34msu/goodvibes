/**
 * service.ts, UnifiedRewindService.
 *
 * One coordinator over the platform's existing history stores. `plan()` is a
 * dry-run preview of exactly what a rewind to a turn anchor would change, plus
 * a single-use confirm token; `apply()` runs only with that token, so what runs
 * is what was previewed, and performs the restore(s), recording an undo point
 * so the rewind is itself reversible
 * (restore-the-restore). The workspace side reuses the checkpoint manager's
 * own pre-restore safety checkpoint as that undo point; the conversation side
 * reuses its store's captured pre-rewind snapshot. Every apply emits a receipt
 * event so surfaces can render it.
 */
import type { WorkspaceEvent } from '../../events/workspace.js';
import { ReviewTokenStore } from '../control-plane/review-tokens.js';
import { TargetChangedError, targetRef, type TargetRef } from '../utils/target-ref.js';
import { discardTurnAnchorsAfter, dropAnchorsAgainFor, restoreAnchorsDroppedBy } from './turn-anchors.js';
import type { SessionSurface } from '../runtime/session-surface.js';
import type {
  RewindAnchor,
  RewindApplyResult,
  RewindCheckpointView,
  RewindConversationPort,
  RewindEventSink,
  RewindPlan,
  RewindPlanConversation,
  RewindPlanFiles,
  RewindReceiptConversation,
  RewindReceiptFiles,
  RewindScope,
  RewindUndo,
  RewindWorkspacePort,
} from './types.js';

/** Thrown when rewind.apply is handed an unknown, spent or expired confirm token. */
export class RewindTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewindTokenError';
  }
}

/** What authorizes an apply: the confirm token the matching plan returned. */
export const REWIND_CONFIRM_OPTIONS = ['confirmToken'] as const;

/** The lifetime a receipt states when the conversation's port does not say its own. */
const CONVERSATION_UNDO_DEFAULT_LIFETIME = 'until 32 newer conversation rewinds in the process holding the conversation, or until that process exits';

export interface UnifiedRewindServiceDeps {
  /** The workspace-checkpoint store port. Absent → files rewind is honestly unavailable. */
  readonly workspace?: RewindWorkspacePort | null;
  /** Resolve the project-scoped workspace checkpoint store for a session/project on a multi-project daemon. */
  readonly workspaceFor?: ((sessionId: string, project?: string) => RewindWorkspacePort | null | undefined) | null;
  /** The conversation store port. Absent → conversation rewind is honestly unavailable. */
  readonly conversation?: RewindConversationPort | null;
  /** Receipt event sink. Absent → no events emitted (a graceful degrade). */
  readonly emit?: RewindEventSink | null;
  readonly now?: () => number;
  readonly tokens?: ReviewTokenStore;
  /**
   * The session surface that owns the sessions directory. When present, a
   * conversation rewind also rewrites the turn-anchor sidecar, so a resume
   * before the next turn does not bring back anchors for turns that were
   * rewound away.
   */
  readonly anchorSurface?: SessionSurface | null;
}

export interface RewindApplyOptions {
  /** The single-use token `plan()` returned for this same anchor and scope; without it nothing runs. */
  readonly confirmToken?: string | undefined;
  /** The project folder whose checkpoint store to resolve on a multi-project daemon. */
  readonly project?: string | undefined;
}

function wants(scope: RewindScope, part: 'files' | 'conversation'): boolean {
  return scope === 'both' || scope === part;
}

interface ResolvedFiles {
  readonly workspace: RewindWorkspacePort | null;
  readonly checkpoint: RewindCheckpointView | null;
  /** The anchor turn, when it has no checkpoint although the session has others. */
  readonly unmatchedTurn: string | null;
}

function unmatchedTurnReason(turnId: string): string {
  return `Turn ${turnId} has no workspace checkpoint of its own (it changed no files, or its checkpoint was pruned), so the files as they were at that turn cannot be identified, and rewinding only the conversation would leave later file edits in place. Rewind with scope "conversation" to keep the files as they are, or pick a turn that changed files to rewind both.`;
}

/** The conversation as counted: its port's revision, else its message count. */
function conversationRevision(preview: { readonly messagesToDrop: number; readonly messagesRemaining: number; readonly revision?: string | undefined }): string {
  return preview.revision?.trim() || `${preview.messagesToDrop + preview.messagesRemaining} messages`;
}

/**
 * What a rewind plan showed and its apply must still find: the session, turn
 * and scope, the workspace checkpoint it restores, and the conversation's
 * revision when it was counted (null when no conversation was counted).
 */
function rewindTarget(anchor: RewindAnchor, scope: RewindScope, checkpointId: string | null, conversation: string | null): TargetRef<'rewind'> {
  return targetRef('rewind', `${anchor.sessionId}:${anchor.turnId ?? 'latest'}:${scope}`,
    { checkpoint: checkpointId, conversation },
    { checkpoint: checkpointId ?? 'none', conversation: conversation ?? 'not counted' },
    anchor.sessionId);
}

// A files rewind restores the whole workspace tree, not only what this session
// wrote, so edits other sessions, agents or the user made after the checkpoint go too.
const WHOLE_WORKSPACE_WARNING = 'files rewind resets the whole workspace to the checkpoint, not only this session\'s edits: changes made after it by other sessions, agents or you are reverted too. The receipt names a checkpoint that undoes it.';

export class UnifiedRewindService {
  private readonly workspace: RewindWorkspacePort | null;
  private readonly workspaceFor: ((sessionId: string, project?: string) => RewindWorkspacePort | null | undefined) | null;
  private readonly conversation: RewindConversationPort | null;
  private readonly emitSink: RewindEventSink | null;
  private readonly now: () => number;
  private readonly tokens: ReviewTokenStore;
  private readonly anchorSurface: SessionSurface | null;
  /** Sessions with an apply running; a second apply for one of them is refused. */
  private readonly applying = new Set<string>();

  constructor(deps: UnifiedRewindServiceDeps = {}) {
    this.workspace = deps.workspace ?? null;
    this.workspaceFor = deps.workspaceFor ?? null;
    this.conversation = deps.conversation ?? null;
    this.emitSink = deps.emit ?? null;
    this.now = deps.now ?? Date.now;
    this.tokens = deps.tokens ?? new ReviewTokenStore(this.now);
    this.anchorSurface = deps.anchorSurface ?? null;
  }

  private workspacePortFor(sessionId: string, project?: string): RewindWorkspacePort | null {
    return this.workspaceFor?.(sessionId, project) ?? this.workspace;
  }

  /**
   * The conversation of a rewind was put back (undo): its turn anchors come
   * back with it, in memory and in the sidecar (which also holds them across
   * a restart).
   */
  anchorsRestored(undoSnapshotId: string): void {
    restoreAnchorsDroppedBy(undoSnapshotId, this.anchorSurface ?? undefined);
  }

  /** The conversation of an undone rewind was cut again (redo): its anchors go again. */
  anchorsDropped(undoSnapshotId: string): void {
    dropAnchorsAgainFor(undoSnapshotId, this.anchorSurface ?? undefined);
  }

  /** Dry-run preview of a rewind + a single-use confirm token authorizing it. */
  async plan(anchor: RewindAnchor, scope: RewindScope, opts?: { readonly project?: string | undefined }): Promise<RewindPlan> {
    const turnId = anchor.turnId ?? null;
    const warnings: string[] = [];
    const resolved = wants(scope, 'files') ? await this.resolveFiles(anchor, opts?.project) : null;
    const files = resolved ? await this.planFiles(resolved, warnings) : null;
    const counted = wants(scope, 'conversation') ? await this.planConversation(anchor, warnings) : null;
    const conversation = counted?.plan ?? null;
    if (scope === 'both' && resolved?.unmatchedTurn) warnings.push(unmatchedTurnReason(resolved.unmatchedTurn));

    const { token, expiresAt } = this.tokens.issue(rewindTarget(anchor, scope, resolved?.checkpoint?.id ?? null, counted?.revision ?? null));
    this.emitEvent({ type: 'REWIND_PLANNED', sessionId: anchor.sessionId, turnId, scope }, anchor.sessionId);
    return { sessionId: anchor.sessionId, turnId, scope, token, expiresAt, files, conversation, warnings };
  }

  /** Apply a planned rewind. No token → a non-error refusal naming the plan; bad token → RewindTokenError. */
  async apply(anchor: RewindAnchor, scope: RewindScope, opts: RewindApplyOptions = {}): Promise<RewindApplyResult> {
    // Two applies for one session (a double click, two surfaces) would restore
    // and truncate over each other and interleave their undo points. The
    // second is refused before it can spend a confirm token.
    if (this.applying.has(anchor.sessionId)) {
      return {
        receipt: null,
        refused: true,
        refusal: {
          reason: 'Another rewind of this session is still running, so this one was not started and nothing changed. Wait for its receipt, then plan again if you still want this rewind.',
          confirmField: 'confirmToken',
          planMethod: 'rewind.plan',
          options: [],
        },
      };
    }
    this.applying.add(anchor.sessionId);
    try {
      return await this.applyNow(anchor, scope, opts);
    } finally {
      this.applying.delete(anchor.sessionId);
    }
  }

  private async applyNow(anchor: RewindAnchor, scope: RewindScope, opts: RewindApplyOptions): Promise<RewindApplyResult> {
    const turnId = anchor.turnId ?? null;
    // The token is the one authority: it binds this apply to the plan that
    // previewed it (which workspace checkpoint gets restored, and the
    // conversation as it was counted), and the plan is where the
    // whole-workspace warning is shown.
    if (opts.confirmToken === undefined) {
      return {
        receipt: null,
        refused: true,
        refusal: {
          reason: 'Nothing was changed: rewind.apply runs only with the confirmToken that rewind.plan returns, so the rewind that runs is the one that was previewed. Call rewind.plan with the same sessionId, turnId and scope, read its warnings, then call rewind.apply with its token.',
          confirmField: 'confirmToken',
          planMethod: 'rewind.plan',
          options: [...REWIND_CONFIRM_OPTIONS],
        },
      };
    }
    const resolved = wants(scope, 'files') ? await this.resolveFiles(anchor) : null;
    // The conversation is counted again now: a message that arrived after the
    // plan would otherwise be cut by a rewind that never showed it.
    const preview = wants(scope, 'conversation') && this.conversation ? await this.previewNow(anchor) : null;
    const spent = this.tokens.consume(opts.confirmToken,
      rewindTarget(anchor, scope, resolved?.checkpoint?.id ?? null, preview?.revision ?? null));
    if (!spent.ok && spent.reason === 'changed' && spent.reviewed) {
      throw new TargetChangedError(spent.reviewed, spent.changes ?? [],
        `rewind.plan with sessionId ${anchor.sessionId}${turnId ? `, turnId ${turnId}` : ''} and scope ${scope}`);
    }
    if (!spent.ok) {
      throw new RewindTokenError(
        `confirmToken is ${spent.reason === 'expired' ? 'expired' : 'unknown or already used'}. Re-run rewind.plan.`,
      );
    }

    if (scope === 'both' && resolved?.unmatchedTurn) {
      // Truncating the conversation while later file edits stay on disk would
      // leave the two describing different points in time.
      return {
        receipt: null,
        refused: true,
        refusal: {
          reason: unmatchedTurnReason(resolved.unmatchedTurn),
          confirmField: 'scope',
          planMethod: 'rewind.plan',
          options: ['conversation'],
        },
      };
    }

    // Restoring files and then finding the conversation cannot follow would
    // leave the two at different points in time, so the conversation is asked
    // first and a refusal changes nothing.
    if (scope === 'both' && resolved?.checkpoint && this.conversation) {
      const reason = preview === null ? null : 'reason' in preview ? preview.reason : null;
      if (reason !== null) {
        return {
          receipt: null,
          refused: true,
          refusal: {
            reason: `The conversation cannot be rewound right now (${reason}), and rewinding only the files would leave the two at different points in time. Nothing was changed. Rewind with scope "files" to restore the files alone, or try again when the conversation is reachable.`,
            confirmField: 'scope',
            planMethod: 'rewind.plan',
            options: ['files'],
          },
        };
      }
    }

    const warnings: string[] = [];
    const { files, undoFiles } = resolved
      ? await this.applyFiles(resolved, warnings)
      : { files: null as RewindReceiptFiles | null, undoFiles: null as RewindUndo['files'] };
    let conversation: RewindReceiptConversation | null = null;
    let undoConversation: RewindUndo['conversation'] = null;
    if (wants(scope, 'conversation')) {
      try {
        // The cut is checked against the revision this apply was confirmed against, after the file restore awaited.
        const expected = preview !== null && 'expected' in preview ? preview.expected : undefined;
        ({ conversation, undoConversation } = await this.applyConversation(anchor, warnings, expected));
      } catch (error) {
        // Only the conversation half failed. When the files were already
        // restored, the receipt that names their undo point must still be
        // returned; otherwise the caller never learns where to undo to.
        if (undoFiles === null) throw error;
        warnings.push(`conversation rewind failed after the files were restored: ${error instanceof Error ? error.message : String(error)}. The conversation was not changed; restore checkpoint ${undoFiles.restoreCheckpointId} to undo the file restore.`);
        conversation = { rewound: false, droppedMessages: 0, undoSnapshotId: null };
      }
    }
    // Turns after the anchor are gone from the conversation; their anchors
    // would otherwise cut the new branch at an unrelated message.
    if (conversation?.rewound && anchor.turnId !== undefined) {
      const { saved } = discardTurnAnchorsAfter(anchor.sessionId, anchor.turnId, this.anchorSurface ?? undefined, conversation.undoSnapshotId ?? undefined);
      if (!saved) warnings.push('the list of rewind points could not be saved; after a restart it may offer turns that were rewound away');
    }

    const receipt = {
      sessionId: anchor.sessionId,
      turnId,
      scope,
      appliedAt: this.now(),
      files,
      conversation,
      undo: { files: undoFiles, conversation: undoConversation },
      warnings,
    };
    this.emitEvent(
      {
        type: 'REWIND_APPLIED',
        sessionId: anchor.sessionId,
        turnId,
        scope,
        filesRestored: files?.restored ?? false,
        conversationRewound: conversation?.rewound ?? false,
        undoAvailable: undoFiles !== null || undoConversation !== null,
      },
      anchor.sessionId,
    );
    return { receipt, refused: false, refusal: null };
  }

  /**
   * The checkpoint a files rewind to `anchor` restores. With no turn anchor it
   * is the session's most recent checkpoint. A turn that changed no files has
   * no checkpoint of its own; when the session has checkpoints from other
   * turns, `unmatchedTurn` records that the file state at that turn cannot be
   * identified.
   */
  private async resolveFiles(anchor: RewindAnchor, project?: string): Promise<ResolvedFiles> {
    const workspace = this.workspacePortFor(anchor.sessionId, project);
    if (!workspace) return { workspace: null, checkpoint: null, unmatchedTurn: null };
    const list = await workspace.list({ sessionId: anchor.sessionId });
    if (list.length === 0) return { workspace, checkpoint: null, unmatchedTurn: null };
    if (anchor.turnId !== undefined) {
      const checkpoint = list.find((c) => c.turnId === anchor.turnId) ?? null;
      return { workspace, checkpoint, unmatchedTurn: checkpoint ? null : anchor.turnId };
    }
    // No turn anchor → the session's most recent checkpoint (do not assume list order).
    return { workspace, checkpoint: [...list].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null, unmatchedTurn: null };
  }

  /** The conversation's revision now, or why it cannot be rewound now. */
  /**
   * The conversation counted now. `revision` is what the confirm token binds;
   * `expected` is the port's own revision, which the cut is checked against
   * (absent when the port reports none).
   */
  private async previewNow(anchor: RewindAnchor): Promise<{ readonly revision: string | null; readonly expected?: string | undefined } | { readonly revision: null; readonly reason: string }> {
    try {
      const preview = await this.conversation!.preview(anchor);
      if (preview.available === false) {
        return { revision: null, reason: preview.unavailableReason?.trim() || 'no conversation is reachable for this session' };
      }
      const expected = preview.revision?.trim();
      return { revision: conversationRevision(preview), ...(expected ? { expected } : {}) };
    } catch (error) {
      return { revision: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async planFiles(resolved: ResolvedFiles, warnings: string[]): Promise<RewindPlanFiles> {
    if (!resolved.workspace) {
      warnings.push('files rewind unavailable: no workspace checkpoint store is wired on this runtime');
      return { available: false, checkpointId: null, checkpointLabel: null, affectedFileCount: 0 };
    }
    const checkpoint = resolved.checkpoint;
    if (!checkpoint) {
      warnings.push('files rewind: no workspace checkpoint found for this anchor');
      return { available: false, checkpointId: null, checkpointLabel: null, affectedFileCount: 0 };
    }
    warnings.push(WHOLE_WORKSPACE_WARNING);
    const diff = await resolved.workspace.diff(checkpoint.id);
    return {
      available: true,
      checkpointId: checkpoint.id,
      checkpointLabel: checkpoint.label,
      affectedFileCount: diff.files.length,
    };
  }

  private async planConversation(anchor: RewindAnchor, warnings: string[]): Promise<{ readonly plan: RewindPlanConversation; readonly revision: string | null }> {
    if (!this.conversation) {
      warnings.push('conversation rewind unavailable: no conversation store is wired on this runtime');
      return { plan: { available: false, messagesToDrop: 0, messagesRemaining: 0 }, revision: null };
    }
    const preview = await this.conversation.preview(anchor);
    if (preview.available === false) {
      warnings.push(preview.unavailableReason?.trim()
        ? `conversation rewind unavailable: ${preview.unavailableReason.trim()}`
        : 'conversation rewind unavailable: no conversation is reachable for this session');
      return { plan: { available: false, messagesToDrop: 0, messagesRemaining: 0 }, revision: null };
    }
    return {
      plan: { available: true, messagesToDrop: preview.messagesToDrop, messagesRemaining: preview.messagesRemaining },
      revision: conversationRevision(preview),
    };
  }

  private async applyFiles(
    resolved: ResolvedFiles,
    warnings: string[],
  ): Promise<{ files: RewindReceiptFiles; undoFiles: RewindUndo['files'] }> {
    const checkpoint = resolved.checkpoint;
    if (!resolved.workspace || !checkpoint) {
      warnings.push('files rewind skipped: no workspace checkpoint available for this anchor');
      return {
        files: { restored: false, checkpointId: checkpoint?.id ?? null, safetyCheckpointId: null, restoredFileCount: 0, removedFileCount: 0 },
        undoFiles: null,
      };
    }
    // safetyCheckpoint: true records the pre-restore state, the undo point that
    // makes this rewind reversible (restore that checkpoint to reverse it).
    const result = await resolved.workspace.restore(checkpoint.id, { safetyCheckpoint: true });
    warnings.push(WHOLE_WORKSPACE_WARNING);
    // A restore that could not apply every path is not a completed rewind: say
    // so, and keep the undo point so the partial state can be reversed.
    const failed = result.failedPaths ?? [];
    if (failed.length > 0) {
      warnings.push(`files rewind was only partly applied: ${failed.length} path(s) could not be restored (${failed.map((f) => `${f.path}: ${f.reason}`).join('; ')}).${result.safetyCheckpointId ? ` Restore checkpoint ${result.safetyCheckpointId} to return to the state before the rewind.` : ''}`);
    }
    return {
      files: {
        restored: failed.length === 0,
        checkpointId: result.checkpointId,
        safetyCheckpointId: result.safetyCheckpointId,
        restoredFileCount: result.restoredFiles.length,
        removedFileCount: result.removedFiles.length,
      },
      undoFiles: result.safetyCheckpointId ? { restoreCheckpointId: result.safetyCheckpointId } : null,
    };
  }

  private async applyConversation(
    anchor: RewindAnchor,
    warnings: string[],
    expectedRevision?: string,
  ): Promise<{ conversation: RewindReceiptConversation; undoConversation: RewindUndo['conversation'] }> {
    if (!this.conversation) {
      warnings.push('conversation rewind skipped: no conversation store is wired on this runtime');
      return { conversation: { rewound: false, droppedMessages: 0, undoSnapshotId: null }, undoConversation: null };
    }
    const outcome = await this.conversation.rewind(anchor, expectedRevision);
    if (outcome.available === false) {
      warnings.push(outcome.unavailableReason?.trim()
        ? `conversation rewind skipped: ${outcome.unavailableReason.trim()}`
        : 'conversation rewind skipped: no conversation is reachable for this session');
      return { conversation: { rewound: false, droppedMessages: 0, undoSnapshotId: null }, undoConversation: null };
    }
    if (outcome.notSaved) {
      warnings.push(`the conversation was rewound but the change could not be saved (${outcome.notSaved}): it holds until the daemon restarts, which brings back the transcript from before the rewind. Fix the session store's disk or permissions, then apply the rewind again.`);
    }
    return {
      conversation: { rewound: true, droppedMessages: outcome.droppedMessages, undoSnapshotId: outcome.undoSnapshotId },
      undoConversation: { undoSnapshotId: outcome.undoSnapshotId,
        expiresAfter: outcome.undoExpiresAfter?.trim() || CONVERSATION_UNDO_DEFAULT_LIFETIME },
    };
  }

  private emitEvent(event: WorkspaceEvent, sessionId: string): void {
    if (!this.emitSink) return;
    try {
      this.emitSink(event, sessionId);
    } catch {
      // Never throw from event emission.
    }
  }
}
