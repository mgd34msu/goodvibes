import { createHash } from 'node:crypto';

export interface ReadObservation {
  startLine: number;
  completeLines: number;
  numbered: boolean;
  contentSha256: string;
  truncated: boolean;
}

const digest = (content: string) => createHash('sha256').update(content).digest('hex');

/** Describes actual formatted text, never credits the requested end or file total. */
export function observeReadContent(content: string, startLine: number, completeLines: number, numbered: boolean): ReadObservation {
  return { startLine, completeLines, numbered, contentSha256: digest(content), truncated: false };
}

/** A clipped final row is not a complete source line, even if its number survived. */
export function clipReadContent(file: { content?: string | undefined; readObservation?: ReadObservation | undefined }, characters: number): void {
  if (file.content === undefined || file.content.length <= characters) return;
  file.content = file.content.slice(0, characters);
  if (file.readObservation) file.readObservation = { ...file.readObservation, truncated: true,
    completeLines: Math.min(file.readObservation.completeLines, file.content.split('\n').length - 1), contentSha256: digest(file.content) };
}

/** Validate the existing serialized observation and extract its complete rows
 * in one pass. A checksum binds these fields to text; the native execution
 * owner, not this unkeyed checksum, establishes where the observation came from.
 */
export function validatedReadContent(file: { content: string; readObservation?: unknown }): {
  readonly observation: ReadObservation;
  readonly rows: string[];
} | undefined {
  const value = file.readObservation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const observed = value as ReadObservation;
  if (!Number.isSafeInteger(observed.startLine) || observed.startLine < 1 || !Number.isSafeInteger(observed.completeLines)
    || observed.completeLines < 0 || !Number.isSafeInteger(observed.startLine + observed.completeLines)
    || typeof observed.numbered !== 'boolean' || typeof observed.truncated !== 'boolean'
    || typeof observed.contentSha256 !== 'string' || observed.contentSha256 !== digest(file.content)) return undefined;
  const rows = file.content.split('\n');
  let complete: string[] = [];
  if (observed.completeLines <= rows.length) {
    const selected = rows.slice(0, observed.completeLines);
    if (!observed.numbered) complete = selected.map((row, index) => `${String(observed.startLine + index).padStart(5)} | ${row}`);
    else if (selected.every((row, index) => Number(/^[ \t]*(\d+) \|/.exec(row)?.[1]) === observed.startLine + index)) complete = selected;
  }
  return { observation: observed, rows: complete };
}

/** Normalize host-bound complete rows for evidence and immutable-input checking. */
export function returnedReadRows(file: { content: string; readObservation?: unknown }): string[] {
  if (file.readObservation === undefined) return file.content.split('\n').filter(row => /^[ \t]*\d+ \|/.test(row));
  return validatedReadContent(file)?.rows ?? [];
}
