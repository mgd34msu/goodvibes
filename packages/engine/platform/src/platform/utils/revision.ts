/**
 * Revision contract for owners of facts.
 *
 * One owner holds each fact (the configuration, the permission rules, the tool
 * registry, a conversation, ...) and exposes one integer that only moves up: it
 * moves on every change of that fact, including a write by another process the
 * owner noticed through its own watcher or stat. Everyone else captures the
 * integers once, at the start of a step, and compares them again only before an
 * effect that cannot be undone and at commit. A compare is N integer reads; no
 * I/O happens here and nothing is allocated after capture.
 *
 * Whether a call is still wanted is its AbortSignal, never a revision.
 */
import { AppError } from '../types/error-values.js';

export interface RevisionSource {
  /** Names the owner in a stale refusal. */
  readonly id: string;
  /** Moves up on every change of the owner's fact; never moves down. */
  revision(): number;
}

export interface RevisionToken {
  readonly sources: readonly RevisionSource[];
  readonly values: readonly number[];
}

/** A source an owner hands out: its id and a reader of its counter. */
export function revisionSource(id: string, revision: () => number): RevisionSource {
  return Object.freeze({ id, revision });
}

/** Read every source once. */
export function captureRevisions(sources: readonly RevisionSource[]): RevisionToken {
  const owned = Object.freeze([...sources]);
  const values = new Array<number>(owned.length);
  for (let index = 0; index < owned.length; index++) values[index] = owned[index]!.revision();
  return Object.freeze({ sources: owned, values: Object.freeze(values) });
}

/** The first source that moved since capture, or undefined when none did. */
function movedIndex(token: RevisionToken): number {
  const { sources, values } = token;
  for (let index = 0; index < sources.length; index++) {
    if (sources[index]!.revision() !== values[index]) return index;
  }
  return -1;
}

/** True when no source moved since the token was captured. */
export function isCurrent(token: RevisionToken): boolean {
  return movedIndex(token) === -1;
}

/** A fact a step depended on changed after the step read it. */
export class StaleError extends AppError {
  readonly sourceId: string;
  readonly capturedRevision: number;
  readonly currentRevision: number;

  constructor(source: RevisionSource, captured: number, current: number) {
    super(`${source.id} changed while this step was running (revision ${captured} is now ${current}).`, 'CONFLICT', true, {
      statusCode: 409,
      source: 'runtime',
      guidance: `Read ${source.id} again and retry the step.`,
    });
    this.name = 'StaleError';
    this.sourceId = source.id;
    this.capturedRevision = captured;
    this.currentRevision = current;
  }
}

/**
 * Refuse when the call was cancelled or any source moved since capture. The
 * error names the first source that moved.
 */
export function assertCurrent(token: RevisionToken, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  const index = movedIndex(token);
  if (index === -1) return;
  const source = token.sources[index]!;
  throw new StaleError(source, token.values[index]!, source.revision());
}
