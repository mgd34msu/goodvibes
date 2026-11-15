import type { JsonValue } from '@goodvibes-jev/judgment';
import type { SourceReadEvidence } from './evidence.js';
import { currentFileMatchesText, isCurrentNativeFileObservation } from './current-file-observations.js';

type Projected = SourceReadEvidence & {
  readonly referenceProjection: {
    readonly format: 'json-without-display-whitespace';
    readonly originalReturnedContentBytes: number;
    readonly currentFileObservationId: string;
    readonly currentFileBytes: number;
  };
};

const LINE_LABEL = /^[ \t]*(\d+) \|/;
/** One projection per read and current-file observation: the state builder and
 * the reference comparison of one check share it. A cached result is reused
 * only while its observation still reads current. */
const projections = new WeakMap<SourceReadEvidence, WeakMap<object, Projected | null>>();

/** JSON text without whitespace outside string literals, in one pass. Parsing
 * and re-serialising would collapse duplicate keys or round numbers. */
function withoutJsonWhitespace(text: string): string {
  let result = '', start = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      result += text.slice(start, index); start = index + 1;
    }
  }
  return result + text.slice(start);
}

function project(read: SourceReadEvidence, file: Record<string, JsonValue>, bytes: number): Projected | null {
  const rows = read.returnedContent!.split('\n');
  if (!rows.every((row, index) => Number(LINE_LABEL.exec(row)?.[1]) === index + 1)) return null;
  const text = rows.map(row => row.replace(/^[ \t]*\d+ \| ?/, '')).join('\n');
  // Only the candidate whose length is the file's byte count can match; the
  // byte comparison asserts the observation current before and after reading.
  const actual = [text, text + '\n', text.replace(/\n$/, '')].find(value => Buffer.byteLength(value) === bytes);
  if (actual === undefined || !currentFileMatchesText(file, actual)) return null;
  try { JSON.parse(actual); } catch { return null; }
  return { ...read, returnedContent: withoutJsonWhitespace(actual), referenceProjection: {
    format: 'json-without-display-whitespace',
    originalReturnedContentBytes: Buffer.byteLength(read.returnedContent!),
    currentFileObservationId: file['observationId'] as string, currentFileBytes: bytes } };
}

/** Preserve every JSON token and literal while removing display-only whitespace
 * from a complete reference already bound to actual current file bytes. What a
 * projection means is stated once per request in the source-read rules. */
export function compactJsonReference(read: SourceReadEvidence, currentFiles: readonly JsonValue[]): SourceReadEvidence | Projected {
  if (read.contentKind !== 'declared-reference' || read.returnedContent === undefined || !read.path.toLowerCase().endsWith('.json')) return read;
  const file = currentFiles.find(value => value && typeof value === 'object' && !Array.isArray(value)
    && value['path'] === read.path && value['operation'] === 'read-current-file' && value['source'] === 'native-host-filesystem'
    && value['success'] === true && value['binary'] === false);
  if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file['observationId'] !== 'string') return read;
  const bytes = file['bytes'];
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return read;
  const byFile = projections.get(read) ?? new WeakMap<object, Projected | null>();
  projections.set(read, byFile);
  let projected = byFile.get(file);
  if (projected === undefined) { projected = project(read, file, bytes); byFile.set(file, projected); }
  // One currentness check per use, after the work (or the cache hit).
  return projected && isCurrentNativeFileObservation(file) ? projected : read;
}
