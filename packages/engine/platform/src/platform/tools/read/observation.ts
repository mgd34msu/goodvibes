interface ReadLineObservation {
  startLine: number;
  completeLines: number;
  numbered: boolean;
  truncated: boolean;
}

/** Line coordinates travel with the actual native returned text. They are
 * bookkeeping, not an authenticity claim or a substitute for that original. */
export interface ReadObservation extends ReadLineObservation {
  schemaVersion: 2;
  contentCharacters: number;
}
interface SavedReadObservation extends ReadLineObservation {
  contentSha256: string;
}

/** Describes actual formatted text, never credits the requested end or file total. */
export function observeReadContent(content: string, startLine: number, completeLines: number, numbered: boolean): ReadObservation {
  return { schemaVersion: 2, startLine, completeLines, numbered, contentCharacters: content.length, truncated: false };
}

/** A clipped final row is not a complete source line, even if its number survived. */
export function clipReadContent(file: { content?: string | undefined; readObservation?: ReadObservation | undefined }, characters: number): void {
  if (file.content === undefined || file.content.length <= characters) return;
  file.content = file.content.slice(0, characters);
  if (file.readObservation) file.readObservation = { ...file.readObservation, truncated: true,
    completeLines: Math.min(file.readObservation.completeLines, file.content.split('\n').length - 1), contentCharacters: file.content.length };
}

/** Validate serialized line bookkeeping and extract complete rows in one pass.
 * The existing native execution owner establishes provenance; these fields
 * cannot authenticate supplied text. Owner-input qualification independently
 * compares the actual rows against the immutable Git input. Fresh observations
 * never hash the text already retained in their original tool result.
 */
export function validatedReadContent(file: { content: string; readObservation?: unknown }): {
  readonly observation: ReadObservation | SavedReadObservation;
  readonly rows: string[];
} | undefined {
  const value = file.readObservation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const observed = value as ReadLineObservation & { schemaVersion?: unknown; contentCharacters?: unknown; contentSha256?: unknown };
  if (!Number.isSafeInteger(observed.startLine) || observed.startLine < 1 || !Number.isSafeInteger(observed.completeLines)
    || observed.completeLines < 0 || !Number.isSafeInteger(observed.startLine + observed.completeLines)
    || typeof observed.numbered !== 'boolean' || typeof observed.truncated !== 'boolean') return undefined;
  if (observed.schemaVersion === 2) {
    if (observed.contentCharacters !== file.content.length || Object.hasOwn(observed, 'contentSha256')) return undefined;
  } else if (observed.schemaVersion === undefined && Object.hasOwn(observed, 'contentSha256')) {
    // This checksum rode alongside the same serialized text; it was never an
    // independent expected original. Keep its saved shape as line metadata,
    // without hashing. The native owner still qualifies each returned row
    // against the immutable input before crediting it as source evidence.
    if (typeof observed.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(observed.contentSha256)) return undefined;
  } else return undefined;
  const rows = file.content.split('\n');
  let complete: string[] = [];
  if (observed.completeLines <= rows.length && (!observed.truncated || observed.completeLines < rows.length)) {
    const selected = rows.slice(0, observed.completeLines);
    if (!observed.numbered) complete = selected.map((row, index) => `${String(observed.startLine + index).padStart(5)} | ${row}`);
    else if (selected.every((row, index) => Number(/^[ \t]*(\d+) \|/.exec(row)?.[1]) === observed.startLine + index)) complete = selected;
  }
  return { observation: observed as ReadObservation | SavedReadObservation, rows: complete };
}

/** Normalize host-bound complete rows for evidence and immutable-input checking. */
export function returnedReadRows(file: { content: string; readObservation?: unknown }): string[] {
  if (file.readObservation === undefined) return file.content.split('\n').filter(row => /^[ \t]*\d+ \|/.test(row));
  return validatedReadContent(file)?.rows ?? [];
}
