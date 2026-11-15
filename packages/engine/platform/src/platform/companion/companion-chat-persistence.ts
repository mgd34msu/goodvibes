/**
 * companion-chat-persistence.ts
 *
 * Disk-backed session store for CompanionChatManager.
 *
 * Design:
 * - Sessions and their messages are stored as individual JSON files under
 *   `<sessionsDir>/<sessionId>.json` using atomic tmp-file + rename writes.
 * - The store is loaded eagerly at construction time (async init()) and
 *   thereafter kept in sync with every createSession / updateSession /
 *   appendMessage / closeSession mutation.
 * - Default storage root: ~/.goodvibes/companion-chat/sessions/
 */

import { existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { prepareAtomicPublicationDirectory, writeFileAtomic } from '../utils/atomic-json-store.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CompanionChatMessage, CompanionChatSession } from './companion-chat-types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// On-disk shape
// ---------------------------------------------------------------------------

/** A saved chat file that could not be loaded and was set aside, with why. */
export interface RejectedChatFile {
  /** File name as found in the sessions directory. */
  readonly file: string;
  readonly reason: string;
  /** Where the file now lives; absent when it could not be moved. */
  readonly movedTo?: string | undefined;
}

export interface PersistedChatSession {
  readonly meta: CompanionChatSession;
  readonly messages: CompanionChatMessage[];
}

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

/**
 * Resolve the companion-chat sessions directory.
 *
 * Pass the runtime's INJECTED home directory so an isolated-home daemon never
 * reads or writes the real `~/.goodvibes/companion-chat`, the rest of the
 * runtime resolves paths from the injected home, and this must agree. The
 * OS `homedir()` is used only as a last resort when nothing is injected.
 */
export function defaultSessionsDir(homeDirectory?: string): string {
  return join(homeDirectory ?? homedir(), '.goodvibes', 'companion-chat', 'sessions');
}

// ---------------------------------------------------------------------------
// CompanionChatPersistence
// ---------------------------------------------------------------------------

export class CompanionChatPersistence {
  private readonly sessionsDir: string;
  private directoryOwner: ReturnType<typeof prepareAtomicPublicationDirectory> | undefined;
  #rejected: RejectedChatFile[] = [];

  /** Files the most recent loadAll() set aside because their content is unusable. */
  rejectedOnLoad(): readonly RejectedChatFile[] { return this.#rejected; }

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? defaultSessionsDir();
  }

  /** Ensure the sessions directory exists. */
  private ensureDir(): void {
    if (!this.directoryOwner) this.directoryOwner = prepareAtomicPublicationDirectory(this.sessionsDir);
    this.directoryOwner.assertCurrent();
  }

  private filePath(sessionId: string): string {
    if (!safeSessionId(sessionId)) throw new Error('Invalid saved chat identifier');
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  /** Load all persisted sessions from disk. Returns an empty array on directory failure. */
  async loadAll(): Promise<PersistedChatSession[]> {
    const results: PersistedChatSession[] = [];
    const rejected: RejectedChatFile[] = [];
    this.#rejected = rejected;
    let entries: string[];

    try {
      this.ensureDir();
      entries = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      logger.warn('CompanionChatPersistence: failed to read sessions directory', {
        dir: this.sessionsDir,
        error: summarizeError(err),
      });
      return results;
    }

    await Promise.all(
      entries.map(async (filename) => {
        const filePath = join(this.sessionsDir, filename);
        try {
          this.directoryOwner!.assertCurrent();
          const raw = await fs.readFile(filePath, 'utf-8');
          this.directoryOwner!.assertCurrent();
          let parsed: unknown;
          try { parsed = JSON.parse(raw) as unknown; }
          catch (parseError) { rejected.push(this.setAside(filename, `not valid JSON (${summarizeError(parseError)})`)); return; }
          if (!isPersistedChatSession(parsed)) {
            // A file that parses but is not a chat this build understands (torn,
            // hand-edited, or written by a newer build) is moved aside, never
            // deleted: left under its own name, a later save of the same id would
            // overwrite it, and it would vanish from every listing unexplained.
            rejected.push(this.setAside(filename, 'content is not a saved chat this version understands'));
          } else if (safeSessionId(parsed.meta.id) && filename === `${parsed.meta.id}.json`) {
            results.push(parsed);
          } else {
            // A well-formed chat under another name is not ours to rename: it is
            // reported and left exactly where it is.
            rejected.push({ file: filename, reason: 'file name does not match the chat id inside it' });
          }
        } catch (err) {
          logger.warn('CompanionChatPersistence: failed to load session', {
            file: filePath,
            error: summarizeError(err),
          });
        }
      }),
    );

    this.directoryOwner!.assertCurrent();
    return results;
  }

  /** Rename an unusable chat file to `<name>.rejected` (a numbered name if that is taken). */
  private setAside(filename: string, reason: string): RejectedChatFile {
    try {
      this.directoryOwner!.assertCurrent();
      const dir = this.directoryOwner!.canonical;
      let target = join(dir, `${filename}.rejected`);
      for (let n = 2; existsSync(target); n++) target = join(dir, `${filename}.rejected.${n}`);
      renameSync(join(dir, filename), target);
      logger.warn('CompanionChatPersistence: set aside an unusable saved chat', { file: filename, movedTo: target, reason });
      return { file: filename, reason, movedTo: target };
    } catch (err) {
      logger.warn('CompanionChatPersistence: could not set aside an unusable saved chat', { file: filename, reason, error: summarizeError(err) });
      return { file: filename, reason };
    }
  }

  /** One native synchronous publication lets metadata commit its in-memory
   * state only after the exact file is durable, without an async adoption gap. */
  saveSync(session: PersistedChatSession): void {
    const filePath = this.filePath(session.meta.id);
    this.ensureDir();
    const content = JSON.stringify(session, null, 2) + '\n';
    writeFileAtomic(filePath, content, { durable: true, mode: 0o600, mkdirp: false, assertCurrent: () => this.directoryOwner!.assertCurrent() });
  }

  /** The queued background-save API preserves its existing async contract. */
  async save(session: PersistedChatSession): Promise<void> { this.saveSync(session); }

  /** Delete a session file from disk (called when a closed session is GC'd). Rejects on unlink failure. */
  async delete(sessionId: string): Promise<void> {
    this.filePath(sessionId);
    this.ensureDir();

    try {
      this.directoryOwner!.assertCurrent();
      unlinkSync(join(this.directoryOwner!.canonical, `${sessionId}.json`));
    } catch (err) {
      if (isNodeErrorCode(err, 'ENOENT')) return;
      throw new Error(`Companion chat session delete failed for ${sessionId}: ${summarizeError(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function safeSessionId(id: string): boolean { return id.length > 0 && !/[\\/\0]/.test(id); }

function isPersistedChatSession(value: unknown): value is PersistedChatSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['meta'] === 'object' &&
    v['meta'] !== null &&
    typeof (v['meta'] as Record<string, unknown>)['id'] === 'string' &&
    Array.isArray(v['messages'])
  );
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === code
  );
}
