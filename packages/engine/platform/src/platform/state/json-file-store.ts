import { captureQuarantineSource, readCapturedQuarantineSourceAsync, QuarantineEncodingError, writeJsonFileAtomic, type QuarantineSource } from '../utils/atomic-json-store.js';

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
   * or half-written file. Each save completes before the next one starts.
   */
  async save(data: T): Promise<void> {
    writeJsonFileAtomic(this.filePath, data, { durable: true });
  }
}
