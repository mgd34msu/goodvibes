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
 * A confirmation is bound to the value the user confirmed (a digest of the
 * stored text), so a pull that changes the value, or turns it into a pointer
 * at another credential, is unconfirmed again until the user confirms the new one.
 *
 * Read once and kept; a later lookup costs one `stat` and re-reads only when
 * another process changed the file.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

interface ApprovalDocument {
  readonly version: 2;
  /** Store file path -> key -> digest of the stored value the user confirmed. */
  readonly stores: Record<string, Record<string, string>>;
}

/** The digest a confirmation is bound to: the stored text, as stored. */
function valueDigest(storedValue: string): string {
  return createHash('sha256').update(storedValue).digest('hex');
}

export class ProjectSecretApprovals {
  readonly #file: string;
  #identity: string | null = null;
  #stores = new Map<string, Map<string, string>>();

  constructor(file: string) { this.#file = file; }

  /** True when `key` in the project store at `storePath` was confirmed by the user with this stored value. */
  isApproved(storePath: string, key: string, storedValue: string): boolean {
    this.#refresh();
    const digest = this.#stores.get(storePath)?.get(key);
    return digest !== undefined && digest === valueDigest(storedValue);
  }

  /** Record the keys of the store at `storePath` as confirmed, each with its stored value. Throws when the record cannot be written. */
  approve(storePath: string, values: Readonly<Record<string, string>>): void {
    this.#refresh();
    const current = this.#stores.get(storePath) ?? new Map<string, string>();
    const digests = Object.entries(values).map(([key, value]) => [key, valueDigest(value)] as const);
    if (digests.every(([key, digest]) => current.get(key) === digest)) return;
    const next = new Map(this.#stores);
    next.set(storePath, new Map([...current, ...digests]));
    const document: ApprovalDocument = {
      version: 2,
      stores: Object.fromEntries([...next].map(([path, approved]) => [path, Object.fromEntries([...approved].sort(([a], [b]) => a.localeCompare(b)))])),
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
      const parsed = JSON.parse(readFileSync(this.#file, 'utf-8')) as { readonly version?: unknown; readonly stores?: Record<string, unknown> };
      if (parsed.version !== 2) {
        // An earlier record named keys without their values: it cannot say what
        // the user confirmed, so those keys are confirmed again before use.
        logger.warn('Project secret confirmations from an earlier version are not bound to a value; confirm the keys again with /secrets trust', { path: this.#file });
        return;
      }
      for (const [path, keys] of Object.entries(parsed.stores ?? {})) {
        if (!keys || typeof keys !== 'object' || Array.isArray(keys)) continue;
        this.#stores.set(path, new Map(Object.entries(keys as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
      }
    } catch (error) {
      // An unreadable record approves nothing; the keys stay unused until confirmed again.
      logger.warn('Project secret approvals could not be read; project-store keys stay unused until confirmed again', {
        path: this.#file, error: summarizeError(error),
      });
    }
  }
}
