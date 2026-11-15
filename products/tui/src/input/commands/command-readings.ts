/** The command readings that may be pending at once, one of each kind. */
export type CommandReadingKind = 'schedule' | 'share' | 'teamwork';

/** A submission that now owns its kind's reading until `finish`, a newer submission, Escape, a session change or shutdown. */
export interface CommandReading {
  readonly ok: true;
  readonly signal: AbortSignal;
  /** False once the reading was revoked; aborts the signal on the first false. */
  current(): boolean;
  assertCurrent(): void;
  finish(): void;
}

/**
 * Why no reading started: `pending` means the same submission is still being
 * read and will finish on its own (do not hand the text back, it would be sent
 * twice); `closed` means the terminal is shutting down or not active.
 */
export interface CommandReadingRefused {
  readonly ok: false;
  readonly reason: 'pending' | 'closed';
}

/**
 * The one owner of pending command readings (a natural-language schedule, a
 * gist upload's credential reading, a teamwork brief). The terminal creates,
 * cancels and disposes this one object; a command begins a reading of its kind.
 */
export class CommandReadings {
  private readonly active = new Map<CommandReadingKind, { key: string; controller: AbortController }>();
  private disposed = false;

  constructor(private readonly sessionId: () => string, private readonly isActive: () => boolean) {}

  begin(kind: CommandReadingKind, key: string): CommandReading | CommandReadingRefused {
    if (this.disposed || !this.isActive()) return { ok: false, reason: 'closed' };
    if (this.active.get(kind)?.key === key) return { ok: false, reason: 'pending' };
    this.cancel(kind);
    const entry = { key, controller: new AbortController() };
    const sessionId = this.sessionId();
    this.active.set(kind, entry);
    const current = () => {
      if (this.active.get(kind) !== entry || this.disposed || !this.isActive() || this.sessionId() !== sessionId) entry.controller.abort();
      return !entry.controller.signal.aborted;
    };
    return {
      ok: true,
      signal: entry.controller.signal,
      current,
      assertCurrent: () => { current(); entry.controller.signal.throwIfAborted(); },
      finish: () => { if (this.active.get(kind) === entry) this.active.delete(kind); },
    };
  }

  /** Revoke the pending reading of one kind; true when there was one. */
  cancel(kind: CommandReadingKind): boolean {
    const entry = this.active.get(kind);
    this.active.delete(kind);
    entry?.controller.abort();
    return entry !== undefined;
  }

  /** Revoke every pending reading (a new submission, recovery, a session change); true when there was one. */
  cancelAll(): boolean {
    let cancelled = false;
    for (const kind of [...this.active.keys()]) cancelled = this.cancel(kind) || cancelled;
    return cancelled;
  }

  /** Escape: cancel the turn and every pending reading; true when either was running. */
  withCancellation(cancelTurn: () => boolean): () => boolean {
    return () => { const cancelled = this.cancelAll(); return cancelTurn() || cancelled; };
  }

  dispose(): void { this.disposed = true; this.cancelAll(); }
}
