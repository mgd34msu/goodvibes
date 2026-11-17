import { captureQuarantineSource, readCapturedQuarantineSourceAsync, QuarantineEncodingError, writeFileAtomicAsync, AtomicWriteDurabilityError, type QuarantineSource } from '../utils/atomic-json-store.js';

export class JsonFileStoreParseError extends Error { override readonly name = 'JsonFileStoreParseError'; constructor() { super('JsonFileStore original source is not valid JSON.'); } }
const parseSavedJson = JSON.parse;

/**
 * JsonFileStore, a JSON file read through the quarantine reader and written
 * through the one atomic writer (utils/atomic-json-store.ts).
 *
 * Handles lazy loading, atomic durable writes, and ensures the directory
 * hierarchy exists. Invalid JSON and write failures are thrown so
 * callers do not mistake corrupted state for an empty store or persisted write.
 */
export class JsonFileStore<T> {
  /** The last save in flight: saves land in the order they were called. */
  private saveTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** Load JSON data from disk, or return null if the file does not exist. */
  async load(observed?: QuarantineSource): Promise<T | null> {
    const source = observed ?? captureQuarantineSource(this.filePath); if (!source) return null;
    try {
      let raw: string;
      try { raw = await readCapturedQuarantineSourceAsync(this.filePath, source); }
      catch (error) { if (error instanceof QuarantineEncodingError) throw new JsonFileStoreParseError(); throw error; }
      let value: T;
      try { value = parseSavedJson(raw) as T; } catch (error) { if (error instanceof SyntaxError) throw new JsonFileStoreParseError(); throw error; }
      source.assertCurrent(); return value;
    } finally { if (!observed) source.close(); }
  }

  /**
   * Atomically and durably persist data to disk through the one writer
   * (`writeFileAtomic`): the bytes are synced before the rename and the
   * directories after it, so neither a crash nor a power loss leaves an empty
   * or half-written file. The write and the syncs run off the event loop, and
   * each save completes before the next one starts.
   */
  async save(data: T): Promise<void> {
    // Serialized now, so a later change to `data` cannot reach this save.
    let contents: string;
    try {
      const serialized = JSON.stringify(data, null, 2) as string | undefined;
      if (serialized === undefined) throw new Error('JsonFileStore data did not serialize to a value');
      contents = `${serialized}\n`;
    } catch (error) { throw new AtomicWriteDurabilityError(this.filePath, 'before-publication', error); }
    const save = this.saveTail.then(() => writeFileAtomicAsync(this.filePath, contents, { durable: true }));
    this.saveTail = save.catch(() => undefined);
    await save;
  }
}
