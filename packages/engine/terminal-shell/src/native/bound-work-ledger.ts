import { NativeWorkExecutionControls, type NativeWorkExecutionAction, type NativeWorkExecutionState } from './native-work-execution.js';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import type { WorkLedgerReadEvent } from '@goodvibes/engine/platform/platform/workflow/work-ledger';

import { projectWorkLedgerHistory, nextWorkLedgerCursor, type NativeWorkLedgerBinding } from './work-ledger-projection.js';

/** How many of the most recent history events a view keeps and shows; older ones are counted. */
export const NATIVE_WORK_LEDGER_HISTORY_TAIL = 20;
/** Shown while the host does not answer a read; transport errors can carry addresses or credentials. */
const READ_UNANSWERED = 'The host did not answer the work ledger read. These rows are the last ones read; it is retried automatically.';
const RETRY_AFTER_FAILED_READ_MS = 5_000;
/** A refused read is retried at the reader's own refusal back-off; the reader's resume re-reads sooner. */
const RETRY_AFTER_REFUSED_READ_MS = 60_000;

/** The HTTP status a failed operator read carries, when it carries one. */
function statusOf(value: unknown): number | undefined {
  try {
    const status: unknown = value !== null && typeof value === 'object' && 'status' in value ? value.status : undefined;
    return typeof status === 'number' ? status : undefined;
  } catch {
    return undefined;
  }
}

/** A fixed sentence for a refusal (the error text can carry the host address or a credential). */
function refusedRead(status: number): string {
  return `The host refused the work ledger read (HTTP ${status}). These rows are the last ones read; it is retried every minute. Restore this device's access to the host to resume.`;
}

/** A fact this view established about the ledger itself (a gap, a stale snapshot): reopening is the fix. */
class LedgerViewError extends Error {}

export type NativeWorkLedgerState =
  | { readonly status: 'closed' | 'loading' | 'unavailable'; readonly reason: string }
  | {
      readonly status: 'ready';
      readonly snapshot: WorkLedgerReadSnapshot;
      /** The most recent events, at most {@link NATIVE_WORK_LEDGER_HISTORY_TAIL}. */
      readonly history: readonly WorkLedgerReadEvent[];
      /** How many durable events came before `history` and are not kept here (absent: none). */
      readonly earlierEvents?: number | undefined;
      readonly cursor: number;
      readonly execution?: NativeWorkExecutionState | undefined;
      /** The host binding offers start/status/cancel/resume for this project. */
      readonly executionAvailable: boolean;
      /** The reader cannot reach the host right now; these rows are the last ones read. */
      readonly reason?: string | undefined;
    };

/** One view owns one reader and its durable history cursor. It never owns a store. */
export class BoundWorkLedgerModel {
  private epoch = 0;
  private client: WorkLedgerReadClient | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending: WorkLedgerReadSnapshot | undefined;
  private draining = false;
  private cursor = 0;
  private highestSnapshotCursor = -1;
  private history: WorkLedgerReadEvent[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private provenance: WorkLedgerReadSnapshot['provenance'];
  private projectionEpoch = 0;
  private executionBound = false;
  private protect(events: readonly WorkLedgerReadEvent[]): WorkLedgerReadEvent[] {
    return projectWorkLedgerHistory(events, this.provenance);
  }
  state: NativeWorkLedgerState = { status: 'closed', reason: 'Native work ledger view is closed.' };
  private readonly execution = new NativeWorkExecutionControls(() => {
    if (this.state.status === 'ready') this.publish(this.state);
  });
  /** The snapshot this view shows: execution controls read their attempt from it, never from a fresh fetch. */
  private shownSnapshot(): WorkLedgerReadSnapshot | undefined {
    return this.state.status === 'ready' ? this.state.snapshot : undefined;
  }
  /** Keep the newest events only; the cursor, not the events, keeps history contiguous. */
  private keepTail(): void {
    if (this.history.length > NATIVE_WORK_LEDGER_HISTORY_TAIL) this.history.splice(0, this.history.length - NATIVE_WORK_LEDGER_HISTORY_TAIL);
  }
  private earlier(cursor: number): number {
    return Math.max(0, cursor - this.history.length);
  }
  constructor(
    private readonly changed: () => void = () => {},
    private readonly current: () => boolean = () => true,
  ) {}
  private publish(state: NativeWorkLedgerState): void {
    this.state = state.status === 'ready' ? { ...state, execution: this.execution.state, executionAvailable: this.executionBound } : state;
    this.changed();
  }
  execute(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined> {
    return this.execution.run(action, workId);
  }
  /** The attempt status/cancel act on for this work: the one last observed, not a newer one. */
  observedExecutionAttempt(workId: string): string | undefined {
    return this.execution.observedAttempt(workId);
  }
  private release(): number {
    const epoch = ++this.epoch;
    const unsubscribe = this.unsubscribe;
    const client = this.client;
    this.unsubscribe = undefined;
    this.client = undefined;
    this.pending = undefined;
    this.provenance = undefined;
    this.projectionEpoch += 1;
    this.draining = false;
    this.cursor = 0;
    this.highestSnapshotCursor = -1;
    this.history = [];
    this.executionBound = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    // Revoke local references before any external cleanup can reenter.
    this.execution.clear();
    // Independent cleanup: a throwing observer must not retain the reader.
    try {
      unsubscribe?.();
    } catch {
      /* best effort */
    }
    try {
      client?.dispose();
    } catch {
      /* best effort */
    }
    return epoch;
  }
  loading(reason: string): void {
    const epoch = this.release();
    if (epoch === this.epoch) this.publish({ status: 'loading', reason });
  }
  close(): void {
    const epoch = this.release();
    if (epoch === this.epoch) this.publish({ status: 'closed', reason: 'Native work ledger view is closed.' });
  }
  unavailable(reason: string): void {
    const epoch = this.release();
    if (epoch === this.epoch) this.publish({ status: 'unavailable', reason });
  }
  open(binding: NativeWorkLedgerBinding): void {
    const released = this.release();
    if (released !== this.epoch) {
      if (binding.available && binding.client !== this.client) {
        try {
          binding.execution?.dispose();
        } catch {}
        try {
          binding.client.dispose();
        } catch {}
      }
      return;
    }
    if (!binding.available) {
      this.publish({ status: 'unavailable', reason: binding.reason });
      return;
    }
    const client = binding.client;
    this.client = client;
    const epoch = this.epoch;
    if (binding.execution) {
      this.execution.bind(binding.execution, client.projectId, () => this.shownSnapshot(), () => client.readSnapshot(), () => this.current() && epoch === this.epoch && this.client === client);
      this.executionBound = true;
    }
    this.publish({ status: 'loading', reason: 'Reading native work ledger and durable history…' });
    if (epoch !== this.epoch) return;
    try {
      // A failed read keeps this binding and the rows already read: the reader keeps
      // polling, says why, and says when it resumes, when the snapshot is read again.
      const unsubscribe = client.subscribe(
        (snapshot) => this.accept(snapshot, epoch, true),
        (reason) => {
          if (epoch !== this.epoch || this.client !== client) return;
          this.publish(this.state.status === 'ready' ? { ...this.state, reason } : { status: 'unavailable', reason });
        },
        () => {
          if (epoch !== this.epoch || this.client !== client) return;
          void client.readSnapshot().then((snapshot) => this.accept(snapshot, epoch), (error) => this.fail(error, epoch));
        },
      );
      if (epoch !== this.epoch) {
        try {
          unsubscribe();
        } catch {}
        return;
      }
      this.unsubscribe = unsubscribe;
      const projectionEpoch = this.projectionEpoch;
      void client.readSnapshot().then(
        (snapshot) => {
          // The reader can notify a newer projection before an older snapshot's
          // promise continuation runs. Keep that notification's provenance while
          // still accepting durable snapshot contents through the cursor fence.
          this.accept(
            projectionEpoch === this.projectionEpoch || this.provenance === undefined
              ? snapshot
              : { ...snapshot, provenance: this.provenance },
            epoch,
          );
        },
        (error) => this.fail(error, epoch),
      );
    } catch {
      // The reader refused to observe at all (it was disposed): nothing will retry this binding.
      if (epoch === this.epoch) this.unavailable('The work ledger reader is closed. Reopen /work to read it again.');
    }
  }
  /**
   * A read the host did not answer keeps this binding and the rows already read: the reader
   * keeps polling and the view catches up when a read succeeds. Only a fact about the ledger
   * itself (a history gap, a snapshot behind history, another project) ends the binding.
   */
  private fail(error: unknown, epoch: number, retry?: WorkLedgerReadSnapshot): void {
    if (epoch !== this.epoch) return;
    if (error instanceof LedgerViewError) {
      this.unavailable(error.message);
      return;
    }
    // A refusal (revoked device, missing read scope, gone) is not an unanswered host: it says so
    // with the fix and is not retried at the fast pace. The reader's resume re-reads when access returns.
    const status = statusOf(error);
    const refused = status === 401 || status === 403 || status === 404 || status === 410;
    const reason = refused ? refusedRead(status) : READ_UNANSWERED;
    this.publish(this.state.status === 'ready' ? { ...this.state, reason } : { status: 'unavailable', reason });
    if (!retry || this.retryTimer !== undefined) return;
    if (!this.pending || this.pending.cursor < retry.cursor) this.pending = retry;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (epoch === this.epoch && this.pending && !this.draining) void this.drain(epoch);
    }, refused ? RETRY_AFTER_REFUSED_READ_MS : RETRY_AFTER_FAILED_READ_MS);
    this.retryTimer.unref?.();
  }
  /** `fromReader`: the reader's own ordered notification, not the answer to a read this view made. */
  private accept(snapshot: WorkLedgerReadSnapshot, epoch: number, fromReader = false): void {
    if (epoch !== this.epoch || !this.client) return;
    if (snapshot.projectId !== this.client.projectId) {
      this.fail(new LedgerViewError('Host project binding changed.'), epoch);
      return;
    }
    if (snapshot.cursor < this.highestSnapshotCursor) {
      // A read this view made that a newer one overtook is dropped. The reader announcing a
      // lower cursor means the host ledger was restored or replaced: the rows read so far
      // describe a ledger that no longer exists, so the view starts over from the new one
      // (the bump discards a page an in-flight read brings back for the old one).
      if (!fromReader) return;
      this.history = [];
      this.cursor = 0;
      this.highestSnapshotCursor = 0;
      this.pending = undefined;
      this.projectionEpoch += 1;
    }
    if (snapshot.provenance !== undefined && snapshot.provenance !== this.provenance) {
      const prior = this.provenance;
      this.provenance = snapshot.provenance;
      this.projectionEpoch += 1;
      if (this.provenance === 'requires_read_knowledge') {
        this.history = this.protect(this.history);
        if (this.state.status === 'ready')
          this.publish({ ...this.state, snapshot: { ...this.state.snapshot, provenance: this.provenance }, history: [...this.history], earlierEvents: this.earlier(this.state.cursor) });
      } else if (prior === 'requires_read_knowledge') {
        this.history = [];
        this.cursor = 0;
      }
      if (epoch !== this.epoch || !this.client) return;
    }
    this.highestSnapshotCursor = snapshot.cursor;
    this.pending = snapshot;
    if (!this.draining) void this.drain(epoch);
  }
  private enqueue(snapshot: WorkLedgerReadSnapshot): void {
    this.highestSnapshotCursor = Math.max(this.highestSnapshotCursor, snapshot.cursor);
    if (!this.pending || this.pending.cursor < snapshot.cursor) this.pending = snapshot;
  }
  private async drain(epoch: number): Promise<void> {
    this.draining = true;
    let reading: WorkLedgerReadSnapshot | undefined;
    try {
      while (epoch === this.epoch && this.pending && this.client) {
        let snapshot = this.pending;
        reading = snapshot;
        this.pending = undefined;
        const projectionEpoch = this.projectionEpoch;
        // A view shows only the newest events, so a fresh one reads history from there, not from the
        // first event: the read stays the same size however old the project is.
        if (this.cursor === 0 && this.history.length === 0) this.cursor = Math.max(0, snapshot.cursor - NATIVE_WORK_LEDGER_HISTORY_TAIL);
        const events = await this.client.history(this.cursor);
        if (epoch !== this.epoch) return;
        if (projectionEpoch !== this.projectionEpoch) continue;
        let cursor: number;
        try { cursor = nextWorkLedgerCursor(events, this.cursor, 'Native ledger history has a sequence gap. Reopen to reload.'); }
        catch (error) { throw new LedgerViewError(error instanceof Error ? error.message : String(error)); }
        if (cursor < snapshot.cursor) throw new LedgerViewError('Native ledger history is behind its snapshot. Reopen to reload.');
        // A loop, not push(...page): a very large page would exceed the engine's argument limit and fail the view.
        for (const event of this.protect(events)) this.history.push(event);
        this.keepTail();
        this.cursor = cursor;
        if (cursor > snapshot.cursor) {
          snapshot = await this.client.readSnapshot();
          if (epoch !== this.epoch) return;
          if (projectionEpoch !== this.projectionEpoch) continue;
          if (snapshot.projectId !== this.client.projectId || snapshot.cursor < cursor)
            throw new LedgerViewError('Native ledger snapshot is behind durable history. Reopen to reload.');
          if (snapshot.cursor > cursor) {
            this.enqueue(snapshot);
            continue;
          }
        }
        reading = undefined;
        this.execution.observe(snapshot);
        this.publish({ status: 'ready', snapshot, history: [...this.history], earlierEvents: this.earlier(cursor), cursor, executionAvailable: this.executionBound });
        // The first snapshot and every ledger change read the execution status shown, with no key.
        if (this.executionBound && epoch === this.epoch) this.execution.refresh(snapshot);
      }
    } catch (error) {
      this.fail(error, epoch, reading);
    } finally {
      if (epoch === this.epoch) this.draining = false;
    }
  }
}
