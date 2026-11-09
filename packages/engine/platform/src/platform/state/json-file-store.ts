import { writeJsonFileAtomicAsync } from '../utils/atomic-json-write-async.js';
import { captureQuarantineSource, readCapturedQuarantineSourceAsync, QuarantineEncodingError, type QuarantineSource } from '../utils/atomic-json-store.js';

export class JsonFileStoreParseError extends Error { override readonly name = 'JsonFileStoreParseError'; constructor() { super('JsonFileStore original source is not valid JSON.'); } }
const parseSavedJson = JSON.parse;

/**
 * JsonFileStore, generic JSON file persistence with atomic writes.
 *
 * Handles lazy loading, atomic writes via a temporary file, and ensures the
 * directory hierarchy exists. Invalid JSON and write failures are thrown so
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
   * Atomically and durably persist data to disk.
   *
   * `rename(2)` alone only makes the swap atomic for concurrent readers; it
   * does not make it survive a power loss. Both fsyncs are what turn the
   * temp+rename into a crash-safe write: the first flushes the temp file's
   * bytes before it is ever named, the second flushes the directory entry so
   * the rename itself is durable. Without them a hard crash can leave the
   * renamed file with unwritten (zero-filled or truncated) contents, which the
   * next `load()` sees as unparseable JSON.
   */
  async save(data: T): Promise<void> {
    await writeJsonFileAtomicAsync(this.filePath, data);
  }
}
