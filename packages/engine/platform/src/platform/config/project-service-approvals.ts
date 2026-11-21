/**
 * project-service-approvals.ts, which services from a project's services file
 * the user has confirmed.
 *
 * A project's services file is repository content: an entry in it chooses
 * which stored key is sent, with which header, to which host. It is used only
 * after the user confirms it once (`/services trust <name>`). What is confirmed
 * is the entry's shape (auth type, the key names it reads, the provider whose
 * sign-in it may use, the header and the origin it sends to), so a later edit
 * of any of those in the repository needs a new confirmation. The record lives
 * beside the user's own services file, outside every checkout, keyed by the
 * project file's path, so a repository cannot confirm its own entries.
 *
 * Read once and kept; a later lookup costs one `stat` and re-reads only when
 * another process changed the file.
 */

import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { withSyncFileLock } from './sync-file-lock.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

interface ApprovalDocument {
  readonly version: 1;
  /** Project services file path -> service name -> confirmed fingerprint. */
  readonly files: Record<string, Record<string, string>>;
}

export class ProjectServiceApprovals {
  readonly #file: string;
  #identity: string | null = null;
  #files = new Map<string, Map<string, string>>();

  constructor(file: string) { this.#file = file; }

  /** Where the record is kept. */
  get path(): string { return this.#file; }

  /** True when `service` of the project file at `projectPath` was confirmed with this exact `fingerprint`. */
  isApproved(projectPath: string, service: string, fingerprint: string): boolean {
    this.#refresh();
    return this.#files.get(projectPath)?.get(service) === fingerprint;
  }

  /** Record `service` of the project file at `projectPath` as confirmed. Throws when the record cannot be written. */
  approve(projectPath: string, service: string, fingerprint: string): void {
    this.#refresh();
    if (this.#files.get(projectPath)?.get(service) === fingerprint) return;
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    // The daemon and a terminal may confirm at once: the record is read again
    // and written under the file's lock, so neither drops the other's entries.
    withSyncFileLock(this.#file, () => {
      this.#identity = null;
      this.#refresh();
      if (this.#files.get(projectPath)?.get(service) === fingerprint) return;
      const next = new Map([...this.#files].map(([path, entries]) => [path, new Map(entries)]));
      const entries = next.get(projectPath) ?? new Map<string, string>();
      entries.set(service, fingerprint);
      next.set(projectPath, entries);
      const document: ApprovalDocument = {
        version: 1,
        files: Object.fromEntries([...next].map(([path, approved]) => [path, Object.fromEntries([...approved].sort(([a], [b]) => a.localeCompare(b)))])),
      };
      writeJsonFileAtomic(this.#file, document, { mode: 0o600 });
      this.#files = next;
      this.#identity = this.#stat();
    });
  }

  #stat(): string | null {
    try {
      const stat = statSync(this.#file);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  #refresh(): void {
    const identity = this.#stat();
    if (identity === this.#identity) return;
    this.#identity = identity;
    this.#files = new Map();
    if (identity === null) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf-8')) as Partial<ApprovalDocument>;
      for (const [path, entries] of Object.entries(parsed.files ?? {})) {
        if (typeof entries !== 'object' || entries === null) continue;
        const approved = new Map<string, string>();
        for (const [service, fingerprint] of Object.entries(entries)) {
          if (typeof fingerprint === 'string') approved.set(service, fingerprint);
        }
        this.#files.set(path, approved);
      }
    } catch (error) {
      // An unreadable record confirms nothing; the entries stay unused until confirmed again.
      logger.warn('Project service approvals could not be read; project services stay unused until confirmed again', {
        path: this.#file, error: summarizeError(error),
      });
    }
  }
}
