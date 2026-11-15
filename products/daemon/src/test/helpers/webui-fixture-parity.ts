import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'bun:test';

/**
 * The browser end-to-end suite replays JSON captured from real HTTP by these
 * producer tests. Ids, clocks, ports and temp directories differ on every run,
 * so both sides are compared with those values replaced by a placeholder; any
 * other difference (a field added, removed, renamed or re-typed) fails the
 * producer, which means a stale committed capture cannot pass unnoticed.
 */
const VOLATILE: readonly (readonly [RegExp, string])[] = [
  // Ids come from random generators; some are re-lettered UUIDs (a-z), so the class is wider than hex.
  [/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/gi, '<uuid>'],
  // device:inode[:mode:size:mtime:ctime] file identities.
  [/\b\d{1,4}:\d{6,}(?::\d+){0,5}\b/g, '<file-identity>'],
  [/\b[0-9a-f]{64}\b/g, '<sha256>'],
  [/\b[0-9a-f]{40}\b/g, '<sha1>'],
  [/\bwcp_[0-9a-z]+_[0-9a-f]{8}\b/g, 'wcp_<id>'],
  [/\d+\.\d{4,}/g, '<measured>'],
  [/\bcommitted [0-9a-f]{8}\b/g, 'committed <sha>'],
  [/\b([a-z]{2,12})-(?:[0-9a-f]{8,10}|\d{6,})\b/g, '$1-<id>'],
  [/\b1[5-9]\d{11}\b/g, '<epoch-ms>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<iso>'],
  [/(127\.0\.0\.1|localhost):\d+/g, '$1:<port>'],
  [/(?:\/tmp|\/var\/folders|\/private\/var)\/[^\s"'\\,)]+/g, '<tmp>'],
];

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return VOLATILE.reduce((text, [pattern, token]) => text.replace(pattern, token), value);
  // Fractional numbers are measured durations.
  if (typeof value === 'number') return !Number.isInteger(value) ? '<measured>' : value >= 1e12 && value < 1e13 ? '<epoch-ms>' : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [normalize(key) as string, normalize(entry)]));
  }
  return value;
}

/** Fails unless `capture` has the committed fixture's shape and fixed values. */
export function expectMatchesCommittedFixture(capture: unknown, fixture: URL): void {
  const recorded: unknown = JSON.parse(readFileSync(fixture, 'utf8'));
  expect(normalize(JSON.parse(JSON.stringify(capture)))).toEqual(normalize(recorded));
}

/**
 * Writes `content` to `directory` when a refresh is requested, then always
 * checks it against the committed file `name` under `fixtureDir`. `content` is
 * the exact JSON text the producer would write.
 */
export function exportAndCompareFixture(directory: string | undefined, name: string, content: string, fixtureDir: URL): void {
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  expectMatchesCommittedFixture(JSON.parse(content), new URL(name, fixtureDir));
}
