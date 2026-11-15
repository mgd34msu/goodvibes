const MAX_ALLOCATION_ATTEMPTS = 3;

/** Allocation failures do not establish that a persisted database is corrupt. */
export class SqlJsDatabaseAllocationError extends Error {
  constructor(cause: unknown) {
    super('The private SQLite database could not be allocated.', { cause });
    this.name = 'SqlJsDatabaseAllocationError';
  }
}

/** sql.js names each database it opens with a random file in its private WASM
 * filesystem; a name collision fails the open with an ErrnoError. Retry a few
 * times, then report an allocation failure rather than a corrupt database. */
export function createSqlJsDatabase<T>(Constructor: new (data?: Uint8Array) => T, data?: Uint8Array): T {
  const image = data ?? new Uint8Array();
  for (let attempt = 0; ; attempt++) {
    try { return new Constructor(image); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'ErrnoError') throw error;
      if (attempt + 1 < MAX_ALLOCATION_ATTEMPTS) continue;
      throw new SqlJsDatabaseAllocationError(error);
    }
  }
}
