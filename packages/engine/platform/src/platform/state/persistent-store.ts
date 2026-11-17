import { randomUUID } from 'node:crypto';
import { promises as fs, constants, existsSync, mkdirSync } from 'fs';
import { logger } from '../utils/logger.js';
import { basename, dirname, join } from 'path';
import { summarizeError } from '../utils/error-display.js';
import { CORRUPT_QUARANTINE_MAX_FILES, writeFileAtomicAsync } from '../utils/atomic-json-store.js';
import { publishFileMutation, type MutationPublication } from '../utils/file-mutation.js';

/**
 * PersistentStore, a JSON document store over the one atomic file writer
 * (utils/atomic-json-store.ts `writeFileAtomic`).
 *
 * Handles lazy loading and atomic replacement. Invalid JSON and write failures
 * are thrown so callers do not mistake corrupted state for an empty store or a
 * persisted write. The file is owner-only (0600) and its directory, when this
 * store creates it, 0700. The writer syncs the file's bytes before the rename,
 * so a crash never leaves the path naming an empty file; `durable: true`
 * (authority-bearing state) also syncs the directories, so the rename itself
 * survives a power loss. Temp files a dead writer left are removed by the
 * writer, once per file per process.
 *
 * NOT here: cross-process mutual exclusion. `persist()` is one atomic
 * replacement, so two writers cannot tear a file, but a read-modify-write
 * spanning `load()` and `persist()` can still lose the other writer's record,
 * and that window belongs to the caller that owns the read (see `lockPath`).
 *
 * `loadOrDiscard()` is the second reading, for state whose OWNER has a rule for
 * a torn record: discard it, record the fact, disclose it. The throwing
 * `load()` stays the default, because "empty" and "corrupt" must not be the
 * same answer by accident; asking for the discard is explicit.
 */

/** What was unreadable, for a caller that discards rather than fails. */
export interface PersistentStoreCorruption {
  readonly filePath: string;
  /** Why it could not be read. Never the file's contents. */
  readonly detail: string;
  readonly detectedAt: number;
  /** Where a copy of the unreadable bytes was kept, when one could be made. */
  readonly quarantinedTo?: string | undefined;
}

/** The result of a read that discards rather than throws. */
export interface PersistentStoreRead<T> {
  /** The parsed data, or null when the file was absent OR unreadable. */
  readonly data: T | null;
  /** Non-null only when the file existed and could not be read. */
  readonly corruption: PersistentStoreCorruption | null;
}

/** Owner-only directory, when this store creates it. */
const DIR_MODE = 0o700;

/** The file state last copied aside per store path, so a repeated read of the same corrupt file copies once. */
const quarantinedSignatures = new Map<string, { readonly signature: string; readonly path: string }>();

export class PersistentStore<T extends Record<string, unknown>> {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly inMemory: boolean;
  private memoryData: T | null = null;
  /** The directory was made (or found) by this store's first write. */
  private directoryReady = false;
  /** The last write in flight: writes land in the order persist() was called. */
  private writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.dir = dirname(filePath);
    this.inMemory = filePath === ':memory:';
  }

  /**
   * The advisory-lock path for this store, or null when there is no file to
   * contend on.
   *
   * Exposed so a store that does read-modify-write can serialize the WHOLE
   * cycle across processes without having to be told its own path a second
   * time, the inbound-mail stores accept either a path or an injected
   * `PersistentStore`, and a lock derived from a constructor argument they may
   * not have been given is a lock that silently is not taken.
   */
  get lockPath(): string | null {
    return this.inMemory ? null : `${this.filePath}.lock`;
  }

  /** Load JSON data from disk, or return null if the file does not exist. */
  async load(): Promise<T | null> {
    if (this.inMemory) return this.memoryData;
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`PersistentStore failed to load ${this.filePath}: ${summarizeError(err)}`);
    }
  }

  /**
   * Load, treating an unreadable file as ABSENT rather than as an error.
   *
   * For state whose owner already rules that a torn record is discarded and
   * disclosed (docs/decisions/2026-07-27-inbound-email-design.md §9): the same rule applied to the whole
   * file. The next `persist()` replaces the unreadable file, so before reporting
   * it a copy is kept at `<file>.corrupt-<time>-<id>` (the newest few, see
   * CORRUPT_QUARANTINE_MAX_FILES): the evidence survives that write, and one
   * unreadable byte is not a permanent hard failure across every reader of
   * every store.
   *
   * A file that parses to something that is not an object is corrupt too: it
   * would otherwise read as an empty store, which is the exact "corrupted state
   * mistaken for empty" this class was written to prevent.
   */
  async loadOrDiscard(): Promise<PersistentStoreRead<T>> {
    if (this.inMemory) return { data: this.memoryData, corruption: null };
    if (!existsSync(this.filePath)) return { data: null, corruption: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
    } catch (err) {
      return { data: null, corruption: await this.corruption(summarizeError(err)) };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        data: null,
        corruption: await this.corruption('the file did not contain a JSON object'),
      };
    }
    return { data: parsed as T, corruption: null };
  }

  private async corruption(detail: string): Promise<PersistentStoreCorruption> {
    const quarantinedTo = await this.quarantineCorruptCopy();
    return { filePath: this.filePath, detail, detectedAt: Date.now(), ...(quarantinedTo ? { quarantinedTo } : {}) };
  }

  /**
   * Keep a copy of the unreadable file, once per distinct file state (a store
   * read on every wake must not make a copy per read), and drop the oldest
   * copies past the bound. Best effort: a failure is logged, never thrown, the
   * caller still gets its corruption report.
   */
  private async quarantineCorruptCopy(): Promise<string | undefined> {
    try {
      const stat = await fs.stat(this.filePath);
      const signature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
      const known = quarantinedSignatures.get(this.filePath);
      if (known?.signature === signature) return known.path;
      const destination = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      await fs.copyFile(this.filePath, destination, constants.COPYFILE_EXCL);
      quarantinedSignatures.set(this.filePath, { signature, path: destination });
      const prefix = `${basename(this.filePath)}.corrupt-`;
      const copies = (await fs.readdir(this.dir)).filter((name) => name.startsWith(prefix)).sort();
      for (const old of copies.slice(0, Math.max(0, copies.length - CORRUPT_QUARANTINE_MAX_FILES))) {
        await fs.rm(join(this.dir, old), { force: true }).catch(() => undefined);
      }
      return destination;
    } catch (error) {
      logger.warn('PersistentStore: could not keep a copy of an unreadable file', { filePath: this.filePath, error: summarizeError(error) });
      return undefined;
    }
  }

  /**
   * Atomically persist data to disk, owner-only, through the one writer.
   *
   * `durable: true` for authority-bearing writes: the file and every directory
   * up to the root are synced before this resolves, and a failure after the
   * rename rejects with AtomicWriteDurabilityError ('published-indeterminate');
   * new bytes are never rolled back. `assertCurrent` is checked once before the
   * file is staged and once immediately before the rename, `beforePublish` runs
   * immediately before the rename and `afterPublish` right after it. The
   * rename is always synchronous with those hooks (`synchronousPublish` is
   * accepted for callers that still ask for it). The bytes and the syncs are
   * written off the event loop; this store's writes land in call order.
   */
  async persist(data: T, options: {
    readonly durable?: boolean;
    readonly synchronousPublish?: boolean;
    readonly withPublication?: MutationPublication | undefined;
    readonly beforePublish?: (() => void) | undefined;
    readonly afterPublish?: (() => void) | undefined;
    readonly assertCurrent?: (() => void) | undefined;
    readonly onEffect?: ((published?: boolean) => void) | undefined;
  } = {}): Promise<void> {
    if (this.inMemory) {
      await publishFileMutation(options.withPublication, assertPublicationCurrent => {
        options.assertCurrent?.(); options.beforePublish?.(); assertPublicationCurrent();
        this.memoryData = structuredClone(data);
        options.afterPublish?.();
      });
      return;
    }
    const content = JSON.stringify(data, null, 2) + '\n';
    if (!this.directoryReady) {
      mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
      this.directoryReady = true;
    }
    const write = this.writeTail.then(() => this.write(content, options));
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private async write(content: string, options: NonNullable<Parameters<PersistentStore<T>['persist']>[1]>): Promise<void> {
    await publishFileMutation(options.withPublication, async assertPublicationCurrent => {
      // The writer checks its guard before staging and again just before the
      // rename; once the file is staged, that second check is the publish point.
      let staged = false;
      await writeFileAtomicAsync(this.filePath, content, {
        durable: options.durable === true,
        assertCurrent: () => {
          options.assertCurrent?.(); assertPublicationCurrent();
          if (staged) options.beforePublish?.();
        },
        onEffect: (published) => {
          if (!published) { staged = true; options.onEffect?.(false); return; }
          options.onEffect?.(true); options.afterPublish?.();
        },
      });
    });
  }
}
