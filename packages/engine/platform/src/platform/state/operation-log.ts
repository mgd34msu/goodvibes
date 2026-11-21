/**
 * Operation log: accept and settle an outward operation as lines in a record log.
 *
 * For an operation whose path writes no record of its own (a GitHub reply owed,
 * a Cloudflare token provision): `accept` appends the `accepted` line, with
 * what recovery needs to finish it, and resolves once it is synced; only then
 * may the caller say "accepted". `note` adds the far side's id as soon as it is
 * known; `settle` appends the end. A line whose newest state is still
 * `accepted` after a restart is listed by `open`, so it is finished with its
 * effect key or reported `unknown`, never lost and never read as done.
 *
 * Most paths need no operation log: their durable record is a line they
 * already write (a session input row, a companion chat message line, a run's
 * settle write). Use this only where nothing else records the operation.
 *
 * Cost per request: accept = one write plus the log's batch fdatasync, shared
 * with every line appended since the last; note and settle = one write each,
 * synced in the same batch, not awaited. Opening reads the log once. Settled
 * operations are dropped by a rewrite (one temp file, one rename) when they
 * outnumber the open ones 4 to 1 and number at least 64.
 */
import type { EffectOutcome } from '@goodvibes/engine/errors';
import { openRecordLog, type RecordLog } from './record-log.js';
import { durableAfter, type Durable, type EffectKey, type OperationId } from './operation.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type OperationState = 'accepted' | 'done' | 'failed' | 'unknown' | 'cancelled';

export interface OperationLine<P = unknown> {
  readonly op: OperationId;
  /** What the operation is: 'github.reply', 'cloudflare.token', ... */
  readonly kind: string;
  readonly state: OperationState;
  readonly at: number;
  readonly effect?: EffectKey | undefined;
  /** On 'accepted' only: what recovery needs to finish it. Kept on the merged view until the operation ends. */
  readonly payload?: P | undefined;
  /** The far side's id once known (token id, task id, event id). */
  readonly external?: string | undefined;
  readonly reason?: string | undefined;
}

export interface OperationLog<P> {
  readonly path: string;
  /** Appends 'accepted' and resolves after the log's batch sync (one fdatasync shared with every line appended since the last). */
  accept(line: Omit<OperationLine<P>, 'state' | 'at'>): Promise<Durable<OperationLine<P>>>;
  /** Appends the far side's id; batch sync, not awaited. Throws when the operation is not open or the line was not written. */
  note(op: OperationId, external: string): void;
  /**
   * Appends the end the outcome names (done, failed, unknown); batch sync, not
   * awaited. `pending` keeps the operation open with the check that will tell.
   * Returns false, appending nothing, for an operation that is not open (never
   * accepted, or already ended): one end per operation.
   */
  settle(op: OperationId, outcome: EffectOutcome<unknown>): boolean;
  /** Ends an open operation as cancelled; false when it is not open. */
  cancel(op: OperationId, reason: string): boolean;
  /** The operation as its lines merged (payload from 'accepted', the newest state, effect, external and reason). */
  get(op: OperationId): OperationLine<P> | undefined;
  /** Operations whose newest state is 'accepted': read once at start-up; each is finished with its effect key or reported 'unknown'. */
  open(kind?: string): Iterable<OperationLine<P>>;
  /** Resolves once every line appended so far is synced. */
  flush(): Promise<void>;
  close(): void;
}

const COMPACT_RATIO = 4;
const COMPACT_FLOOR = 64;

function merge<P>(previous: OperationLine<P> | undefined, line: OperationLine<P>): OperationLine<P> {
  if (!previous) return line;
  const ended = line.state !== 'accepted';
  return {
    op: line.op,
    kind: line.kind,
    state: line.state,
    at: line.at,
    effect: line.effect ?? previous.effect,
    // What recovery needs is kept only while the operation is open.
    payload: ended ? undefined : line.payload ?? previous.payload,
    external: line.external ?? previous.external,
    reason: line.reason ?? previous.reason,
  };
}

function isLine(value: unknown): value is OperationLine {
  if (!value || typeof value !== 'object') return false;
  const line = value as Record<string, unknown>;
  return typeof line['op'] === 'string' && typeof line['kind'] === 'string' && typeof line['state'] === 'string' && typeof line['at'] === 'number';
}

/** Drops undefined fields so a line is written as short as it can be. */
function compactLine<P>(line: OperationLine<P>): OperationLine<P> {
  return Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined)) as unknown as OperationLine<P>;
}

class FileOperationLog<P> implements OperationLog<P> {
  readonly path: string;
  readonly #log: RecordLog<OperationLine<P>>;
  readonly #ops = new Map<string, OperationLine<P>>();
  #openCount = 0;
  #compacting = false;

  constructor(path: string) {
    this.path = path;
    this.#log = openRecordLog<OperationLine<P>>(path, { fsync: 'batch' });
    for (const line of this.#log.scan()) {
      if (!isLine(line)) continue;
      this.#apply(line as OperationLine<P>);
    }
  }

  async accept(line: Omit<OperationLine<P>, 'state' | 'at'>): Promise<Durable<OperationLine<P>>> {
    const existing = this.#ops.get(line.op);
    // The same operation accepted again: the first record answers. Only an
    // operation still open, or settled and not yet compacted away, is known
    // here; a client-keyed retry of settled work is answered by
    // control-plane/idempotent-replay.ts, not by this log.
    if (existing) return durableAfter(existing, this.#log.flush());
    const accepted = compactLine<P>({ ...line, state: 'accepted', at: Date.now() });
    this.#append(accepted);
    try {
      return await durableAfter(this.#ops.get(line.op)!, this.#log.flush());
    } catch (error) {
      // Not synced, so not accepted: the caller is refused, and a restart must not finish what it was told failed.
      try {
        this.#append(compactLine<P>({ op: line.op, kind: line.kind, state: 'failed', at: Date.now(), reason: `the accept record could not be synced (${summarizeError(error)})` }));
      } catch { /* the log is failing; the open line stays for the next start to report */ }
      throw error;
    }
  }

  note(op: OperationId, external: string): void {
    const current = this.#requireOpen(op);
    this.#append(compactLine<P>({ op, kind: current.kind, state: 'accepted', at: Date.now(), external }));
  }

  settle(op: OperationId, outcome: EffectOutcome<unknown>): boolean {
    const current = this.#ops.get(op);
    if (!current || current.state !== 'accepted') return false;
    const at = Date.now();
    switch (outcome.state) {
      case 'done':
        this.#append(compactLine<P>({ op, kind: current.kind, state: 'done', at }));
        break;
      case 'pending':
        this.#append(compactLine<P>({ op, kind: current.kind, state: 'accepted', at, reason: `pending: ${outcome.check}` }));
        return true;
      case 'unknown':
        this.#append(compactLine<P>({
          op, kind: current.kind, state: 'unknown', at, reason: outcome.refusal.reason,
          ...(outcome.effect !== undefined ? { effect: outcome.effect as EffectKey } : {}),
        }));
        break;
      case 'failed':
        this.#append(compactLine<P>({ op, kind: current.kind, state: 'failed', at, reason: outcome.refusal.reason }));
        break;
    }
    this.#maybeCompact();
    return true;
  }

  cancel(op: OperationId, reason: string): boolean {
    const current = this.#ops.get(op);
    if (!current || current.state !== 'accepted') return false;
    this.#append(compactLine<P>({ op, kind: current.kind, state: 'cancelled', at: Date.now(), reason }));
    this.#maybeCompact();
    return true;
  }

  get(op: OperationId): OperationLine<P> | undefined {
    return this.#ops.get(op);
  }

  *open(kind?: string): Iterable<OperationLine<P>> {
    for (const line of [...this.#ops.values()]) {
      if (line.state === 'accepted' && (kind === undefined || line.kind === kind)) yield line;
    }
  }

  flush(): Promise<void> {
    return this.#log.flush();
  }

  close(): void {
    this.#log.close();
  }

  #requireOpen(op: OperationId): OperationLine<P> {
    const current = this.#ops.get(op);
    if (!current || current.state !== 'accepted') throw new Error(`operation ${op} is not open in ${this.path}`);
    return current;
  }

  /** Writes the line, then applies it: a line that was not written changes nothing in memory. */
  #append(line: OperationLine<P>): void {
    this.#log.append(line);
    this.#apply(line);
  }

  #apply(line: OperationLine<P>): void {
    const previous = this.#ops.get(line.op);
    const wasOpen = previous?.state === 'accepted';
    const next = merge(previous, line);
    this.#ops.set(line.op, next);
    const isOpen = next.state === 'accepted';
    if (isOpen && !wasOpen) this.#openCount += 1;
    else if (!isOpen && wasOpen) this.#openCount -= 1;
  }

  /** Rewrites the log with the open operations only, once settled ones dominate. Runs without yielding, so no append falls between its read and its rename. */
  #maybeCompact(): void {
    const settled = this.#ops.size - this.#openCount;
    if (this.#compacting || settled < COMPACT_FLOOR || settled < this.#openCount * COMPACT_RATIO) return;
    this.#compacting = true;
    const open = new Set<string>();
    for (const [op, line] of this.#ops) if (line.state === 'accepted') open.add(op);
    void this.#log.compact((line) => open.has(line.op)).then(() => {
      for (const [op, line] of [...this.#ops]) if (line.state !== 'accepted') this.#ops.delete(op);
    }, (error: unknown) => {
      logger.warn('[operation-log] dropping settled operations failed; the log keeps them', { path: this.path, error: summarizeError(error) });
    }).finally(() => { this.#compacting = false; });
  }
}

/** Open (creating when absent) the operation log at `path`. Reads it once. */
export function openOperationLog<P>(path: string): OperationLog<P> {
  return new FileOperationLog<P>(path);
}
