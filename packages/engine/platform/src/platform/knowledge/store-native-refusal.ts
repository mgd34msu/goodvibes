import { NativeConversationStorageError } from '../workflow/work-ledger/native-intake-types.js';
import { NativeWorkExecutionError } from '../workflow/work-ledger/native-execution-types.js';

/** A refusal that keeps its code (callers branch on it) and says which moves the current state allows. */
export class NativeConversationMoveRefused extends NativeConversationStorageError {
  constructor(code: ConstructorParameters<typeof NativeConversationStorageError>[0], detail: string) {
    super(code, detail);
  }
}

export class NativeExecutionMoveRefused extends NativeWorkExecutionError {
  constructor(code: ConstructorParameters<typeof NativeWorkExecutionError>[0], detail: string) {
    super(code, undefined, detail);
  }
}

const INTAKE_MOVES: Readonly<Record<string, string>> = {
  captured: 'captured (more facts), processing (next generation) or cancelled (next generation)',
  processing: 'processing (same or next generation), turn, blocked, refused or associated (same generation), or cancelled (next generation)',
  blocked: 'unchanged, or cancelled (next generation); retry by cancelling and submitting again',
  refused: 'unchanged, or cancelled (next generation)',
  turn: 'unchanged, except that a dispatched turn may be marked settled',
  associated: 'unchanged',
  cancelled: 'unchanged; submit new work instead',
};

/** A write that keeps the state was refused for another field, so the text must not blame the state change. */
export function intakeMoveText(from: string | null, to: string): string {
  if (from === null) return `A new capture may only start as captured or cancelled at generation 1; it was proposed as ${to}.`;
  if (from === to) return `The capture is ${from} and the write keeps that state, but it changes a field that cannot change in ${from}; from ${from} the legal moves are ${INTAKE_MOVES[from] ?? 'none'}.`;
  return `The capture is ${from} and cannot become ${to} that way; from ${from} the legal moves are ${INTAKE_MOVES[from] ?? 'none'}.`;
}

const EXECUTION_INTENT_MOVES: Readonly<Record<string, string>> = {
  admitting: 'any state at the same generation, or admitting at the next generation',
  refused: 'refused, cancelled, or admitting at the next generation',
  associated: 'associated or cancelled',
  cancelled: 'none; it is final',
};

export function executionIntentMoveText(from: string | null, to: string, factsChanged = false): string {
  if (from === null) return `A new intent may only start as admitting or cancelled at generation 1; it was proposed as ${to}.`;
  if (factsChanged) return `The intent is ${from}; this write changes facts fixed when the intent was created, so it was refused whatever the state. Only the state may move; from ${from} the legal moves are ${EXECUTION_INTENT_MOVES[from] ?? 'none'}.`;
  return `The intent is ${from} and cannot become ${to} that way; from ${from} the legal moves are ${EXECUTION_INTENT_MOVES[from] ?? 'none'}.`;
}

const EXECUTION_RECORD_MOVES: Readonly<Record<string, string>> = {
  'launch-claimed': 'any state except prepared, because prepared is launchable and a claimed launch is never re-armed',
  cancelled: 'cancelled only',
};

export function executionRecordMoveText(from: string, to: string, factsChanged = false): string {
  if (factsChanged) return `The execution record is ${from}; this write changes facts fixed when the record was created, so it was refused whatever the state. Only the state may move; from ${from} the legal moves are ${EXECUTION_RECORD_MOVES[from] ?? 'unchanged facts with a later state'}.`;
  return `The execution record is ${from} and cannot become ${to}; from ${from} the legal moves are ${EXECUTION_RECORD_MOVES[from] ?? 'unchanged facts with a later state'}.`;
}
