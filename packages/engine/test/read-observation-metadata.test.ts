/** Source regressions; execution is deferred until coding is complete. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { clipReadContent, observeReadContent, returnedReadRows, validatedReadContent } from '../platform/src/platform/tools/read/observation.js';

test('fresh native line bookkeeping and repeated projection never hash returned text', () => {
  const hash = spyOn(crypto, 'createHash');
  try {
    const content = '    7 | first\n    8 | second';
    const file = { content, readObservation: observeReadContent(content, 7, 2, true) };
    expect(file.readObservation).toEqual({ schemaVersion: 2, startLine: 7, completeLines: 2, numbered: true, contentCharacters: content.length, truncated: false });
    expect(returnedReadRows(JSON.parse(JSON.stringify(file)))).toEqual(content.split('\n'));
    clipReadContent(file, content.indexOf('second') + 2);
    expect(file.readObservation.completeLines).toBe(1);
    expect(file.readObservation.contentCharacters).toBe(file.content.length);
    expect(returnedReadRows(file)).toEqual(['    7 | first']);
    expect(returnedReadRows(file)).toEqual(['    7 | first']);
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('old co-serialized checksum metadata grants no authenticity and needs no hashing', () => {
  const content = '    1 | saved source';
  const readObservation = { startLine: 1, completeLines: 1, numbered: true, truncated: false,
    contentSha256: 'a'.repeat(64) };
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(returnedReadRows({ content, readObservation })).toEqual([content]);
    expect(hash).not.toHaveBeenCalled();
    expect(returnedReadRows({ content: content.replace('saved', 'other'), readObservation })).toEqual([content.replace('saved', 'other')]);
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('unknown or mixed observation versions cannot fall back to unqualified numbered text', () => {
  const content = '    2 | actual row', current = observeReadContent(content, 2, 1, true);
  const hash = spyOn(crypto, 'createHash');
  try {
    for (const readObservation of [{ ...current, schemaVersion: 3 }, { ...current, contentSha256: 'a'.repeat(64) },
      { ...current, contentCharacters: current.contentCharacters + 1 }, { ...current, completeLines: 2 },
      { ...current, startLine: 3 }, { ...current, truncated: true }]) {
      expect(returnedReadRows({ content, readObservation })).toEqual([]);
    }
    expect(validatedReadContent({ content, readObservation: null })).toBeUndefined();
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});
