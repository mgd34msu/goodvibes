// ---------------------------------------------------------------------------
// SessionChangeTracker, tracks files written/edited during the current session
// ---------------------------------------------------------------------------

/**
 * Tracks files written or edited during the current runtime session.
 *
 * Ownership is explicit: the runtime creates one tracker and shares it with
 * write/edit tools plus diff-oriented command surfaces that need to inspect it.
 */
export class SessionChangeTracker {
  private readonly changed = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /**
   * Told when a file joins the session's changed files: a list of the project's changed files (Code and changes) reads
   * again on it, also in a folder where no checkpoint is taken after the turn. Returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  recordChange(filePath: string): void {
    const added = !this.changed.has(filePath);
    this.changed.add(filePath);
    if (!added) return;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* A listener cannot fail the write that recorded the change. */ }
    }
  }

  getChangedFiles(): string[] {
    return Array.from(this.changed);
  }

  clear(): void {
    this.changed.clear();
  }

  count(): number {
    return this.changed.size;
  }
}
