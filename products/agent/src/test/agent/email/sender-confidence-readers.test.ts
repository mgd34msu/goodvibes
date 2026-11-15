/**
 * Sender confidence must stay a display concern on the Agent surface too.
 *
 * This walks the non-test source of `products/agent/src` and fails when a file
 * that is not a declared display site reads `displayedConfidence`. Adding a
 * reader is a review decision: does the new code DISPLAY the value or BRANCH
 * on it? Branching on it is the boundary failing. This is a tripwire on the
 * property name only; the behavioural guard is in sender-claim-wiring.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_ROOT = join(import.meta.dir, '..', '..', '..');
const TEST_ROOT = join(SRC_ROOT, 'test');

/** Files that declare the claim or render it for the owner. */
const CONFIDENCE_READERS = new Set([
  'agent/untrusted-content.ts',
  'input/commands/email-runtime.ts',
]);

function walkSource(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (full === TEST_ROOT) continue;
      walkSource(full, found);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

describe('sender confidence is only read by declared display sites in the agent tree', () => {
  const files = walkSource(SRC_ROOT);

  test('the walk found the source tree and both declared readers', () => {
    const relatives = new Set(files.map((file) => relative(SRC_ROOT, file).split(sep).join('/')));
    expect(files.length).toBeGreaterThan(50);
    for (const reader of CONFIDENCE_READERS) expect(relatives.has(reader)).toBe(true);
  });

  test('no other source file reads displayedConfidence', () => {
    const readers = files
      .filter((file) => readFileSync(file, 'utf-8').includes('displayedConfidence'))
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'));
    const unexpected = readers.filter((reader) => !CONFIDENCE_READERS.has(reader));
    expect(
      unexpected,
      `these files read sender confidence but are not declared display sites. ` +
      `If the new reader DISPLAYS it, add it to CONFIDENCE_READERS. If it BRANCHES on it, ` +
      `the change should not land: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });
});
