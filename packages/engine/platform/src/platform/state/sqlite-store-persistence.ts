/**
 * Errors of the former whole-image writer. SQLiteStore now commits rows to a
 * real SQLite file, whose commit is atomic and never half-published, so
 * nothing in the store throws these any more. They remain only for code that
 * still names them in a catch.
 */

/** Another writer published first and this writer's image was not saved. */
export class SQLitePersistedStateChangedError extends Error {
  constructor(message = 'SQLiteStore: persisted state changed; pending local changes were not saved') {
    super(message);
    this.name = 'SQLitePersistedStateChangedError';
  }
}

/** A whole-image publication failed before or during the rename. */
export class SQLitePublicationError extends Error {
  constructor(readonly phase: 'before-publication' | 'indeterminate', cause: unknown) {
    super(`SQLiteStore: ${phase} persistence failure`, { cause });
    this.name = 'SQLitePublicationError';
  }
}
