import { createHash } from 'node:crypto';

/** Longest file-name stem kept whole, in bytes; a longer one is cut and keeps a digest of the whole, so it stays distinct. */
const MAX_STEM_BYTES = 180;

/**
 * The file-name stem a user-chosen name is stored under (saved sessions,
 * config profiles): lower case, spaces as `-`, letters and digits of any
 * script kept with `-` and `_`, everything else dropped. Names in different
 * scripts or with different accents give different stems ("Встреча",
 * "会議メモ", "café" and "cafe" are four files). Empty when nothing of the
 * name can be stored; each caller decides what that means.
 */
export function storedNameStem(name: string): string {
  const stem = name
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (Buffer.byteLength(stem, 'utf8') <= MAX_STEM_BYTES) return stem;
  const digest = createHash('sha256').update(stem).digest('hex').slice(0, 12);
  let cut = '';
  for (const char of stem) {
    if (Buffer.byteLength(cut + char, 'utf8') > MAX_STEM_BYTES - digest.length - 1) break;
    cut += char;
  }
  return `${cut}-${digest}`;
}

/** A digest stem for a name with nothing storable (only symbols or emoji), so two such names still get two files. */
export function digestNameStem(prefix: string, name: string): string {
  return `${prefix}-${createHash('sha256').update(name.normalize('NFC')).digest('hex').slice(0, 12)}`;
}
