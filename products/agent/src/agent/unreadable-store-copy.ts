import { copyFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * Keep the bytes of a store file whose next write would drop something.
 *
 * The stores that read leniently drop an entry their parser rejects, and one
 * that is not valid JSON reads as empty, then write the result back. That makes
 * one damaged byte, or one entry a newer build wrote, vanish on the next
 * unrelated write. Before such a write, if any raw entry fails `parseEntry` or
 * the file does not parse, a verbatim copy is left beside it so nothing is
 * erased without a record. Returns the copy's path when one was made.
 */
export function keepUnreadableStoreCopy(
  path: string,
  entriesKey: string,
  parseEntry: (entry: unknown) => unknown,
): string | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return undefined; }
  let lossy = false;
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[entriesKey] : undefined;
    lossy = !Array.isArray(entries) || entries.some((entry) => parseEntry(entry) === null);
  } catch {
    lossy = true;
  }
  if (!lossy) return undefined;
  const copy = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { copyFileSync(path, copy); } catch { return undefined; }
  return copy;
}
