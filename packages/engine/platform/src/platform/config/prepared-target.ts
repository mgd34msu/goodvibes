/** A prepared settings change's hold on its target files; unrelated keys in the same file may still change. */
import { readFileSync, statSync } from 'node:fs';
import { readDotPath } from './shared-config-tier.js';

/**
 * A settings file's identity: device, inode, modification time and size, or
 * `absent`. Every settings writer replaces the file by rename or rewrites it,
 * so a write by anyone moves at least one of them. One `stat`.
 */
export function settingsFileIdentity(path: string): string {
  const entry = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (!entry) return 'absent';
  if (!entry.isFile()) throw new Error('Prepared settings target is unavailable.');
  return `${entry.dev}:${entry.ino}:${entry.mtimeNs}:${entry.size}`;
}

function keyProjections(path: string, keys: Iterable<string>): Map<string, string> {
  let parsed: unknown = {};
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Prepared settings target is unavailable.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Prepared settings target is unavailable.');
  return new Map([...keys].map(key => [key, JSON.stringify(readDotPath(parsed, key))]));
}

/**
 * The file's identity and the protected keys' values, read once when the hold
 * is taken. A check is one `stat`; only when the file changed is it read again,
 * and the hold survives a change that left the protected keys as they were.
 */
export class PreparedSettingsTarget {
  #identity: string;
  #keys: Map<string, string>;
  constructor(readonly path: string, keys: readonly string[]) {
    this.#identity = settingsFileIdentity(path);
    this.#keys = keyProjections(path, keys);
  }
  assertCurrent(): void {
    const identity = settingsFileIdentity(this.path);
    if (identity === this.#identity) return;
    const current = keyProjections(this.path, this.#keys.keys());
    for (const [key, expected] of this.#keys) if (current.get(key) !== expected) throw new Error('Prepared settings source key changed.');
    this.#identity = identity;
  }
  /** This manager just wrote `key`: hold the file as written. */
  acceptPublication(key: string, present: boolean, value: unknown): void {
    this.#keys.set(key, JSON.stringify(present ? { present: true, value } : { present: false, value: undefined }));
    this.#identity = settingsFileIdentity(this.path);
  }
}
