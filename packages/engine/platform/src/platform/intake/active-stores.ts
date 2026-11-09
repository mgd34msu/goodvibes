/** Process-local storage ownership, including reads retained through source close.
 * Native cross-process mirror/triage locks remain a separate required fence. */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const active = new Map<string, number>();
function canonical(path: string): string {
  let current = resolve(path); const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(current); if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
    }
  }
}
export function retainActiveInboxStore(path: string): () => void {
  const key = canonical(path); active.set(key, (active.get(key) ?? 0) + 1); let released = false;
  return () => { if (released) return; released = true; const count = active.get(key) ?? 0; if (count <= 1) active.delete(key); else active.set(key, count - 1); };
}
export function isActiveInboxStore(path: string): boolean { return active.has(canonical(path)); }
