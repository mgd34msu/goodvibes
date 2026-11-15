/**
 * Native evidence references: work that touched more files than a ledger
 * evidence record has reference slots is still verifiable, by one reference to
 * the whole set.
 */
import { describe, expect, test } from 'bun:test';
import { artifactReferences } from '../platform/src/platform/workflow/work-ledger/native-execution-verifier.js';
import { evidenceReferenceSchema } from '../platform/src/platform/workflow/work-ledger/types.js';

const paths = (count: number): string[] => Array.from({ length: count }, (_, i) => `src/file-${i}.ts`);

describe('artifactReferences', () => {
  test('lists every path while they fit', () => {
    const refs = artifactReferences('c1', paths(94));
    expect(refs).toHaveLength(94);
    expect(refs[0]).toEqual({ kind: 'artifact', ref: 'artifact:c1:src/file-0.ts' });
  });

  test('past the slots, one reference names the set and its digest, whatever the path order', () => {
    const forward = artifactReferences('c1', paths(500));
    const reversed = artifactReferences('c1', paths(500).reverse());
    expect(forward).toHaveLength(1);
    expect(forward[0]?.ref).toBe('artifact-set:c1:500 files');
    expect(forward[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(reversed).toEqual(forward);
    expect(artifactReferences('c1', paths(499))[0]?.digest).not.toBe(forward[0]?.digest);
    for (const ref of forward) expect(evidenceReferenceSchema.safeParse(ref).success).toBe(true);
  });
});
