/**
 * project-secret-approvals.ts, which keys found in a project's secret store the
 * user has confirmed.
 *
 * A project store sits inside a checkout that may have come from anywhere, so a
 * key in it is used only after the user confirms it once (`/secrets trust`), or
 * because the user stored it there through this program. The record lives beside
 * the user's own store, outside every checkout, keyed by the store file's path,
 * so a repository cannot approve its own keys.
 *
 * Read once and kept; a later lookup costs one `stat` and re-reads only when
 * another process changed the file.
 */

import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

interface ApprovalDocument {
  readonly version: 1;
  readonly stores: Record<string, readonly string[]>;
}

export class ProjectSecretApprovals {
  readonly #file: string;
  #identity: string | null = null;
  #stores = new Map<string, Set<string>>();

  constructor(file: string) { this.#file = file; }

  /** True when `key` in the project store at `storePath` was confirmed by the user. */
  isApproved(storePath: string, key: string): boolean {
    this.#refresh();
    return this.#stores.get(storePath)?.has(key) ?? false;
  }

  /** Record `keys` of the store at `storePath` as confirmed. Throws when the record cannot be written. */
  approve(storePath: string, keys: readonly string[]): void {
    this.#refresh();
    const current = this.#stores.get(storePath) ?? new Set<string>();
    if (keys.every((key) => current.has(key))) return;
    const next = new Map(this.#stores);
    next.set(storePath, new Set([...current, ...keys]));
    const document: ApprovalDocument = {
      version: 1,
      stores: Object.fromEntries([...next].map(([path, approved]) => [path, [...approved].sort()])),
    };
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(this.#file, document, { mode: 0o600 });
    this.#stores = next;
    this.#identity = this.#stat();
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
    this.#stores = new Map();
    if (identity === null) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf-8')) as Partial<ApprovalDocument>;
      for (const [path, keys] of Object.entries(parsed.stores ?? {})) {
        if (Array.isArray(keys)) this.#stores.set(path, new Set(keys.filter((key): key is string => typeof key === 'string')));
      }
    } catch (error) {
      // An unreadable record approves nothing; the keys stay unused until confirmed again.
      logger.warn('Project secret approvals could not be read; project-store keys stay unused until confirmed again', {
        path: this.#file, error: summarizeError(error),
      });
    }
  }
}
