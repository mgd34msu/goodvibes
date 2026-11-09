import type { JsonValue } from '@goodvibes-jev/judgment';
import type { SourceReadEvidence } from './evidence.js';
import { currentFileMatchesText, isCurrentNativeFileObservation } from './current-file-observations.js';

/** Preserve every JSON token and literal while removing display-only whitespace
 * from a complete reference already bound to actual current file bytes. */
export function compactJsonReference(read: SourceReadEvidence, currentFiles: readonly JsonValue[]) {
  if (read.contentKind !== 'declared-reference' || read.returnedContent === undefined || !read.path.toLowerCase().endsWith('.json')) return read;
  const file = currentFiles.find(value => value && typeof value === 'object' && !Array.isArray(value)
    && value['path'] === read.path && value['operation'] === 'read-current-file' && value['source'] === 'native-host-filesystem'
    && value['success'] === true && value['binary'] === false);
  if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file['observationId'] !== 'string' || !isCurrentNativeFileObservation(file)) return read;
  const bytes = file['bytes'];
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return read;
  const rows = read.returnedContent.split('\n');
  if (!rows.every((row, index) => Number(/^[ \t]*(\d+) \|/.exec(row)?.[1]) === index + 1)) return read;
  const text = rows.map(row => row.replace(/^[ \t]*\d+ \| ?/, '')).join('\n');
  const actual = [text, text + '\n', text.replace(/\n$/, '')].find(value => currentFileMatchesText(file, value));
  if (actual === undefined) return read;
  try { JSON.parse(actual); } catch { return read; }
  // Do not parse/stringify: that would collapse duplicate keys or round numbers.
  const tokens: string[] = [];
  let quoted = false, escaped = false;
  for (const character of actual) {
    if (quoted) {
      tokens.push(character);
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') { quoted = true; tokens.push(character); }
    else if (![' ', '\t', '\r', '\n'].includes(character)) tokens.push(character);
  }
  if (!isCurrentNativeFileObservation(file)) return read;
  return { ...read, returnedContent: tokens.join(''), referenceProjection: {
    format: 'json-without-display-whitespace',
    originalReturnedContentBytes: Buffer.byteLength(read.returnedContent), currentFileObservationId: file['observationId'], currentFileBytes: bytes,
    meaning: 'Complete actual returned reference text matches this current host file identity. Only display line labels and JSON whitespace outside string literals are removed from this check view. Every original JSON token, duplicate key, numeric literal, string value and ordering is preserved. Exact original returned text remains retained in the owned read evidence. Ranges establish returned scope only; this projection neither proves review quality nor changes acceptance. It is not a view of the original whitespace or proof of a formatting requirement.' } };
}
