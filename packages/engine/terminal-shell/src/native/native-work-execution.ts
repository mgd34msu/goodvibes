import type { NativeWorkExecutionSnapshot } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client';

// The terminal's own controls over a run (start, status, stop, resume from a ledger view) were removed with that
// view: Work is read from the daemon's `work.list` and acted on through the Work capabilities (builtin/work.ts).
// What stays is the state a message you typed reports when it became a run (native-conversation-intake.ts).

export type NativeWorkExecutionAction = 'start' | 'status' | 'cancel' | 'resume';
export interface NativeWorkExecutionState {
  readonly workId: string;
  readonly action: NativeWorkExecutionAction;
  readonly busy: boolean;
  readonly message: string;
  readonly snapshot?: NativeWorkExecutionSnapshot;
}

/** Honest transport progress, separate from work verification and success evidence. */
export function nativeWorkExecutionLines(state: NativeWorkExecutionState | undefined): string[] {
  if (!state) return [];
  // Where the work stands, in the words of the Work place: its steps and its results, never its records' ids.
  const lines = [state.message];
  const progress = state.snapshot?.kind === 'execution' ? state.snapshot.progress : undefined;
  if (progress) {
    lines.push(`${progress.units.passed} of ${progress.units.total} steps done${progress.units.failed > 0 ? `, ${progress.units.failed} failed` : ''}; ${progress.criteria.met} of ${progress.criteria.total} results met.`);
  }
  return lines;
}
