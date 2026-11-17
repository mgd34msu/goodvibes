/**
 * recovery-snapshot-apply.ts, restoring a crash-recovery snapshot the user
 * explicitly asked for.
 *
 * The snapshot is the whole conversation as it stood at the last turn moment
 * (prompt accepted, each tool batch done): it holds the turn that was in flight
 * when the process died, including a session that crashed before its first
 * clean save.
 *
 * What lives here and what does not
 * ─────────────────────────────────
 * Here: read the snapshot, check what came back is a conversation,
 * put it on the live conversation, save the result to the session store, retire the snapshot, and report how
 * many messages ended up there.
 *
 * Not here: WHETHER to restore. That is a question for the user, asked in
 * whatever idiom a surface has, a terminal modal, a chat reply, an operator
 * verb. A surface writes its own ask and calls this with the answer.
 *
 * Why the ask cannot be skipped
 * ─────────────────────────────
 * A recovery snapshot is a conversation the user has not seen since the process
 * died. Loading one without being asked replaces whatever they are looking at
 * with state from a crash they may not know happened, so the standing rule is
 * ask-then-retire and never auto-load.
 *
 * Two things here make that structural rather than a convention each surface
 * re-implements:
 *
 *  1. {@link applyRecoverySnapshot} will not run without a
 *     {@link RecoveryRestoreConfirmation}, and the only way to obtain one is
 *     {@link confirmRecoveryRestore}, whose single argument is the answer the
 *     user gave. There is no flag, no config key, and no default that produces
 *     one, a caller that has not asked has nothing to pass.
 *  2. Retirement happens INSIDE this function, once the conversation has
 *     accepted the snapshot and the session store holds it. A caller cannot apply a snapshot and keep it:
 *     applying is the same operation as retiring it. That closes the hand-rolled
 *     "load, apply, forget to delete" sequence, which is how the same crash
 *     conversation gets offered again on the next launch. A snapshot the
 *     conversation refuses stays on disk, and the live conversation is put back.
 */

import { loadRecoveryConversation, removeRecoveryPoint } from './session-recovery.js';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.js';
import type { SessionSurface } from './session-surface.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ─── The user's answer ──────────────────────────────────────────────────────

declare const recoveryRestoreConfirmationBrand: unique symbol;

/**
 * Proof that a user was asked whether to restore a recovery snapshot and said
 * yes. Cannot be constructed by a literal, {@link confirmRecoveryRestore} is
 * the only source.
 */
export interface RecoveryRestoreConfirmation {
  readonly [recoveryRestoreConfirmationBrand]: true;
}

/**
 * Turn a user's answer into the token {@link applyRecoverySnapshot} requires.
 *
 * Call this with the result of an actual question put to the user. `false`
 * yields null, so a surface that passes an unanswered or declined prompt
 * straight through gets nothing to apply with.
 *
 * @param userSaidYes - What the user answered. Not a setting, not a default.
 */
export function confirmRecoveryRestore(userSaidYes: boolean): RecoveryRestoreConfirmation | null {
  return userSaidYes ? ({} as RecoveryRestoreConfirmation) : null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * What restoring needs a conversation to be able to do.
 *
 * `rebuildHistory` is optional: it is a rendering concern, and a headless
 * surface has nothing to re-lay-out.
 */
export type RestorableConversation =
  Pick<ConversationManager, 'resetAll' | 'toJSON' | 'fromJSON' | 'title' | 'getTitleSource' | 'getMessageCount'> & {
    rebuildHistory?: () => void;
  };

export interface ApplyRecoverySnapshotOptions {
  /** The surface that owns the session's storage, where the snapshot lives. */
  readonly surface: SessionSurface;
  /** The session whose recovery snapshot is being restored. */
  readonly sessionId: string;
  /** The live conversation to restore into. */
  readonly conversation: RestorableConversation;
  /**
   * Persist the restored conversation to the session store. A failure does not
   * fail the restore, but the snapshot is then kept on disk, since it is the
   * only durable copy of the restored messages.
   */
  readonly persistSnapshot: (messages: ConversationMessageSnapshot[]) => void;
  /** The user's answer, from {@link confirmRecoveryRestore}. */
  readonly confirmation: RecoveryRestoreConfirmation;
}

/** Why a restore did not happen. Each value is a fact a surface can report as-is. */
export type RecoveryApplyRefusal =
  /** Nothing was on disk to load, or the file could not be read. The snapshot, if any, was left alone. */
  | 'no-snapshot'
  /** A snapshot loaded but did not contain a conversation. It had nothing to restore, so it was retired. */
  | 'unusable-snapshot'
  /** The conversation rejected the restored state. The snapshot is still on disk and the live conversation was put back. */
  | 'apply-failed';

export interface ApplyRecoverySnapshotResult {
  /** True when the conversation now holds the recovered messages. */
  readonly applied: boolean;
  /** Set when `applied` is false. */
  readonly refusal?: RecoveryApplyRefusal | undefined;
  /**
   * True once the snapshot file is gone: after a successful apply whose result
   * was saved to the session store, and after an `unusable-snapshot` refusal.
   * False for `no-snapshot` and `apply-failed`, where the file is left on disk,
   * when the restored session could not be saved, and when the file could not
   * be deleted.
   */
  readonly retired: boolean;
  /** Messages the conversation holds once the snapshot is in place. 0 when nothing was applied. */
  readonly messageCount: number;
}

// ─── Content validation ─────────────────────────────────────────────────────

/**
 * What a loaded snapshot has to carry to be worth applying.
 *
 * The loader already guarantees the file parsed as JSON. This is the
 * next question: is what parsed actually a conversation? A snapshot truncated
 * mid-write parses into an object with no usable `messages`, and applying that
 * resets a live conversation to nothing, the restore would destroy exactly
 * what the user asked to get back.
 *
 * An EMPTY messages array counts as unusable, not as an empty conversation:
 * `writeRecoveryFile` refuses to write a snapshot with no messages, so zero
 * messages can only mean the file lost them, the parser yields `[]` for a
 * file too short to hold a meta line plus one message.
 */
function readRestorableMessages(snapshot: unknown): ConversationMessageSnapshot[] | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const messages = (snapshot as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  // Every element must be an object. A messages array holding strings or nulls
  // is a file that got corrupted into a shape that would pass a bare
  // Array.isArray check and then fail deep inside rendering.
  if (!messages.every((entry) => entry !== null && typeof entry === 'object')) return null;
  return messages as ConversationMessageSnapshot[];
}

function readOptionalString(snapshot: unknown, key: string): string | undefined {
  const value = (snapshot as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Restore the recovery snapshot the user asked for, retiring it in the process.
 *
 * The sequence is the one a normal resume runs, reset, fromJSON,
 * rebuildHistory, with the messages coming from the retired recovery file
 * instead of the session store.
 *
 * Never throws: a failed restore reports a refusal so the surface can say what
 * happened, because a crash-recovery path that itself crashes takes the boot
 * down with it.
 */
export function applyRecoverySnapshot(options: ApplyRecoverySnapshotOptions): ApplyRecoverySnapshotResult {
  const { surface, sessionId, conversation, persistSnapshot } = options;

  // Loading does not retire the file: it is deleted only once the conversation has
  // accepted it, so a snapshot the current build cannot restore is still on disk
  // for a later attempt instead of being the only copy lost with the refusal.
  const snapshot = loadRecoveryConversation({ surface }, sessionId);
  if (!snapshot) {
    return { applied: false, refusal: 'no-snapshot', retired: false, messageCount: 0 };
  }

  const retire = (): boolean => {
    try {
      return removeRecoveryPoint(surface, sessionId).removed;
    } catch (error) {
      logger.warn('[Recovery] Could not retire the recovery snapshot', { sessionId, error: summarizeError(error) });
      return false;
    }
  };

  const messages = readRestorableMessages(snapshot);
  if (!messages) {
    // Nothing in it can be restored, so keeping it would only re-offer an empty crash every launch.
    logger.warn('[Recovery] Snapshot loaded but carried no conversation, nothing was applied', { sessionId });
    return {
      applied: false,
      refusal: 'unusable-snapshot',
      retired: retire(),
      messageCount: 0,
    };
  }

  const before = conversation.toJSON();
  try {
    conversation.resetAll();
    conversation.fromJSON({
      messages: messages as never[],
      title: readOptionalString(snapshot, 'title'),
      titleSource: readOptionalString(snapshot, 'titleSource') as never,
    });
    conversation.rebuildHistory?.();
  } catch (error) {
    logger.warn('[Recovery] Conversation rejected the restored snapshot', { sessionId, error: summarizeError(error) });
    // Put back what the user was looking at; the snapshot stays on disk.
    try {
      conversation.resetAll();
      conversation.fromJSON(before as Parameters<RestorableConversation['fromJSON']>[0]);
      conversation.rebuildHistory?.();
    } catch (restoreError) {
      logger.warn('[Recovery] Could not put the live conversation back after a refused restore', { sessionId, error: summarizeError(restoreError) });
    }
    return {
      applied: false,
      refusal: 'apply-failed',
      retired: false,
      messageCount: 0,
    };
  }
  // The session store holds the restored messages before the snapshot goes:
  // until then the snapshot is the only durable copy of them.
  let persisted = false;
  try {
    persistSnapshot(messages);
    persisted = true;
  } catch (error) {
    logger.warn('[Recovery] The restored session could not be saved; the snapshot is kept for the next launch', { sessionId, error: summarizeError(error) });
  }
  const retired = persisted ? retire() : false;

  return {
    applied: true,
    retired,
    messageCount: conversation.getMessageCount(),
  };
}
