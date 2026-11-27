// ---------------------------------------------------------------------------
// The owner's file recovery steps, shared by the terminal app and the Agent:
// `/undo file` and `/redo file` over the per-call file undo stack, and the
// checkpoint restore `/checkpoint restore` (checkpoint-command.ts) runs over
// the workspace checkpoint store. Each app supplies its own command context;
// the questions and the refusals are the same in both.
// ---------------------------------------------------------------------------

import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { othersUndoneLines, type OtherSessionChanges, type WorkspaceCheckpoint, type WorkspaceCheckpointManager } from '@goodvibes/engine/platform/platform/workspace';
import type { FileUndoManager } from '@goodvibes/engine/platform/platform/state';
import { commandRefusal, type ConfirmationHost } from './command-confirmation.js';

/** The file undo stack calls the two lines use; `discard` backs `/undo set-aside` and `/redo set-aside`. */
export type FileUndoControls = Pick<FileUndoManager, 'undo' | 'redo'> & Partial<Pick<FileUndoManager, 'discard'>>;

/**
 * `/undo set-aside` and `/redo set-aside`: set aside the newest entry, which a
 * later change to one of its files keeps from applying, without touching any
 * file, so the next one is the one before it.
 */
export function dropFileChange(manager: FileUndoControls | undefined, direction: 'undo' | 'redo', print: (text: string) => void): void {
  if (!manager?.discard) throw commandRefusal(`File ${direction} is not available in this session.`, undefined, 'UNAVAILABLE');
  const dropped = manager.discard(direction);
  print(dropped
    ? `Dropped the newest ${direction} entry (${dropped.tool} call) without changing any file:\n${dropped.paths.map((path) => `  ${path}`).join('\n')}\nThe next /${direction} file acts on the one before it.`
    : `Nothing to drop: no ${direction} entries are recorded.`);
}

/** `/undo file`: reverts every file the newest recorded write or edit call changed. */
export function undoLastFileChange(manager: FileUndoControls | undefined, print: (text: string) => void): void {
  if (!manager) throw commandRefusal('File undo is not available in this session.', undefined, 'UNAVAILABLE');
  let result: ReturnType<FileUndoControls['undo']>;
  try {
    result = manager.undo();
  } catch (error) {
    throw commandRefusal(`File undo failed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  print(result
    ? `${result.paths.length === 1 ? 'File' : `${result.paths.length} files`} reverted (last ${result.tool} call):\n${result.paths.map((path) => `  ${path}`).join('\n')}\nUse /redo file to re-apply.`
    : 'Nothing to undo. No file operations recorded.');
}

/** `/redo file`: re-applies the newest reverted write or edit call. */
export function redoLastFileChange(manager: FileUndoControls | undefined, print: (text: string) => void): void {
  if (!manager) throw commandRefusal('File redo is not available in this session.', undefined, 'UNAVAILABLE');
  let result: ReturnType<FileUndoControls['redo']>;
  try {
    result = manager.redo();
  } catch (error) {
    throw commandRefusal(`File redo failed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  print(result
    ? `${result.paths.length === 1 ? 'File' : `${result.paths.length} files`} re-applied (${result.tool} call):\n${result.paths.map((path) => `  ${path}`).join('\n')}`
    : 'Nothing to redo.');
}

/** The checkpoint store calls listing and restoring use. */
export type CheckpointControls = Pick<WorkspaceCheckpointManager, 'list' | 'diff' | 'restore' | 'historyTrimmed' | 'retentionFailure'>
  & Partial<Pick<WorkspaceCheckpointManager, 'othersUndoneBy' | 'noteTakenBack'>>;

/**
 * Asks before a restore that would take back other sessions' or agents' changes, whoever asked for it, opening on
 * the choice that changes nothing; answers what to do after the restore (tell those sessions). Returns null when the
 * restore touches only `sessionId`'s own changes (it then runs as before), 'cancelled' when the person kept things.
 */
export async function askBeforeTakingBackOthers(
  context: CheckpointCommandContext,
  manager: CheckpointControls,
  checkpoint: WorkspaceCheckpoint,
  sessionId: string | undefined,
  what: string,
): Promise<{ readonly others: readonly OtherSessionChanges[]; readonly tell: (keptAs: string | null) => Promise<void> } | null | 'cancelled'> {
  if (!manager.othersUndoneBy) return null;
  let others: OtherSessionChanges[];
  try {
    others = await manager.othersUndoneBy(checkpoint.id, { sessionId });
  } catch (error) {
    throw commandRefusal(`${what}: not done. Whose changes it would take back could not be read: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  if (others.length === 0) return null;
  const sessions = others.length === 1 ? 'another session' : `${others.length} other sessions`;
  const body = [
    `This takes back changes ${sessions} made after "${checkpoint.label}":`,
    ...othersUndoneLines(others),
    '',
    `${others.length === 1 ? 'That session is told in its conversation' : 'Those sessions are told in their conversations'} that the change was taken back. The state it replaces is kept as a checkpoint first, so the change can be put back.`,
  ].join('\n');
  if (!context.confirm) {
    throw commandRefusal(`${what}: not done. It would take back changes ${sessions} made:\n${othersUndoneLines(others).join('\n')}`,
      'Run it where you can be asked (the terminal app), or restore a later checkpoint that keeps their changes.', 'CONFIRMATION_REQUIRED');
  }
  const confirmed = await context.confirm({ title: `Take back ${others.length === 1 ? 'another session\'s change' : `${others.length} sessions' changes`}?`, body: `${what}.\n${body}`, confirmLabel: 'Take them back', cancelLabel: 'Keep them', tone: 'warning' });
  if (!confirmed) {
    context.print(`${what}: not done; nothing changed, and the other sessions' changes are kept.`);
    return 'cancelled';
  }
  return {
    others,
    tell: async (keptAs) => {
      try { await manager.noteTakenBack?.(others, sessionId ?? 'unknown', checkpoint.id, keptAs); }
      catch (error) { context.print(`The other sessions could not be told: ${summarizeError(error)}. Tell them their change was taken back.`); }
    },
  };
}

/** A Changes preview with a question, where the app has one (the terminal app). */
export type CheckpointPreview = (options: {
  readonly title: string;
  readonly diff?: string;
  readonly note?: string;
  readonly question?: { readonly text: string; readonly confirmLabel: string; readonly tone?: 'danger' | 'warning' | 'primary' };
}) => Promise<boolean>;

export interface CheckpointCommandContext extends ConfirmationHost {
  readonly renderRequest: () => void;
  readonly isGenerating?: (() => boolean) | undefined;
  readonly previewChanges?: CheckpointPreview | undefined;
}

/** Drop the redundant 'wcp_' prefix and cap the length for a compact listing; the full id and any unambiguous prefix are accepted. */
export function shortCheckpointId(id: string): string {
  const stripped = id.startsWith('wcp_') ? id.slice(4) : id;
  return stripped.length > 12 ? stripped.slice(0, 12) : stripped;
}

export function formatCheckpointAge(createdAtMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.floor(Math.max(0, nowMs - createdAtMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Resolve a ref ('1'..'N' newest first, or a checkpoint id or id prefix) against the newest-first list. */
export function resolveCheckpointRef(checkpoints: readonly WorkspaceCheckpoint[], ref: string, listLine: string): WorkspaceCheckpoint | { readonly error: string } {
  if (/^\d+$/.test(ref)) {
    const checkpoint = checkpoints[Number(ref) - 1];
    return checkpoint ?? { error: `No checkpoint #${ref}. Run ${listLine} to list checkpoints (1–${checkpoints.length}).` };
  }
  const exact = checkpoints.find((checkpoint) => checkpoint.id === ref);
  if (exact) return exact;
  const prefix = checkpoints.filter((checkpoint) => checkpoint.id.startsWith(ref) || shortCheckpointId(checkpoint.id).startsWith(ref));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return { error: `Checkpoint ref "${ref}" is ambiguous (${prefix.length} matches). Use the list number instead.` };
  return { error: `Unknown checkpoint ref "${ref}". Run ${listLine} to list checkpoints.` };
}

const BUSY = 'A turn is still running, so restoring the checkpoint was not started and nothing changed. Stop it with Esc or let it finish, then retry.';

/**
 * Restores the files of one checkpoint. The owner's own command restores at
 * once: a checkpoint of the current files is taken first, and the answer names
 * it with the line that brings it back. A restore the model runs is put to the
 * owner first, on a Changes preview where the app has one, otherwise in a
 * question naming the changed files (`--yes` from the model is ignored). Files
 * only: the conversation is not touched.
 */
export async function restoreCheckpointFiles(
  context: CheckpointCommandContext,
  manager: CheckpointControls,
  checkpoint: WorkspaceCheckpoint,
  options: { readonly yes: boolean; readonly record: (text: string) => void; readonly sessionId?: string | undefined },
): Promise<void> {
  if (context.isGenerating?.()) throw commandRefusal(BUSY, undefined, 'BUSY');
  // Another session's or agent's change is never taken back without asking, whoever asked for the restore.
  const takingBack = await askBeforeTakingBackOthers(context, manager, checkpoint, options.sessionId, `Restore "${checkpoint.label}"`);
  if (takingBack === 'cancelled') { context.renderRequest(); return; }
  let diff: string | undefined;
  let files: readonly string[] = [];
  let note: string | undefined;
  try {
    const result = await manager.diff(checkpoint.id);
    files = result.files;
    if (result.unifiedDiff.trim()) diff = result.unifiedDiff;
    else note = 'The working tree already matches this checkpoint.';
  } catch (error) {
    note = `Could not load the checkpoint diff: ${summarizeError(error)}`;
  }
  const question = `Restore the files of "${checkpoint.label}"? Files only: the conversation is unchanged, and the current files are kept in a safety checkpoint first.`;
  // The owner's own command is the request: it restores at once, the state before it kept as a checkpoint
  // they can restore. A restore the model asks for is put to them first, in every mode (as released).
  if (context.invokedByModel === true) {
    let confirmed: boolean;
    if (context.previewChanges) {
      context.print(`Previewing checkpoint restore: "${checkpoint.label}" (files only). Enter or y restores, n or Esc cancels.`);
      context.renderRequest();
      confirmed = await context.previewChanges({
        title: checkpoint.label,
        ...(diff !== undefined ? { diff } : {}),
        ...(note !== undefined ? { note } : {}),
        question: { text: question, confirmLabel: 'Restore', tone: 'warning' },
      });
    } else if (context.confirm) {
      const listed = files.slice(0, 20).map((file) => `  ${file}`);
      const body = [
        note ?? `${files.length} file${files.length === 1 ? '' : 's'} change:`,
        ...listed,
        ...(files.length > listed.length ? [`  ... and ${files.length - listed.length} more`] : []),
        '',
        'Files only: the conversation is unchanged. The current files are kept in a safety checkpoint first, so /checkpoint restore can bring them back.',
      ].join('\n');
      confirmed = await context.confirm({ title: `Restore checkpoint "${checkpoint.label}"?`, body, confirmLabel: 'Restore', tone: 'warning' });
    } else {
      throw commandRefusal(`Restore checkpoint "${checkpoint.label}": not done. ${files.length} file${files.length === 1 ? '' : 's'} would change.`,
        context.invokedByModel === true ? 'Ask the owner to type the same line with --yes.' : 'This surface cannot ask; type the same line with --yes to confirm it.',
        'CONFIRMATION_REQUIRED');
    }
    if (!confirmed) {
      context.print('Restore cancelled: nothing changed.');
      context.renderRequest();
      return;
    }
    // The question waits on the owner; a turn may have started meanwhile.
    if (context.isGenerating?.()) throw commandRefusal(BUSY, undefined, 'BUSY');
  }
  let restored: Awaited<ReturnType<CheckpointControls['restore']>>;
  try {
    restored = await manager.restore(checkpoint.id, { safetyCheckpoint: true });
  } catch (error) {
    throw commandRefusal(`Checkpoint restore failed: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  const failed = restored.failedPaths ?? [];
  if (failed.length > 0) {
    const names = failed.map((entry) => `${entry.path}: ${entry.reason}`).join('; ');
    context.renderRequest();
    throw commandRefusal(`Checkpoint only partly restored (${failed.length} path${failed.length === 1 ? '' : 's'} failed): ${names}. Files only; the conversation is unchanged.`, undefined, 'PARTIAL');
  }
  const before = restored.safetyCheckpointId;
  await takingBack?.tell(before);
  const beforeLabel = before ? (await manager.list().catch(() => [])).find((entry) => entry.id === before)?.label : undefined;
  options.record([
    `[Checkpoint] Restored "${checkpoint.label}" (${shortCheckpointId(checkpoint.id)}). Files only: the conversation is unchanged.`,
    ...(takingBack ? [`${takingBack.others.length === 1 ? 'The other session was' : `The ${takingBack.others.length} other sessions were`} told their change was taken back.`] : []),
    ...(before ? [`The state before this is kept as "${beforeLabel ?? shortCheckpointId(before)}" (${shortCheckpointId(before)}): /checkpoint restore ${shortCheckpointId(before)} brings it back.`] : []),
  ].join(' '));
  context.renderRequest();
}
