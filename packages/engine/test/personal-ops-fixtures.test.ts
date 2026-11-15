import { describe, expect, test } from 'bun:test';
import { nativeMethodFixture } from '../platform/src/platform/routing/batteries/personal-ops.ts';

describe('personal operations fixtures built from the operator contract', () => {
  test('a method that is not in the contract gives a marked candidate instead of throwing at import', () => {
    const candidate = nativeMethodFixture('no.such.method.anywhere');
    expect(candidate.content.name).toBe('no.such.method.anywhere');
    expect(candidate.content.description).toContain('not in the contract');
  });

  test('a method that is in the contract carries its description and complete contract', () => {
    const candidate = nativeMethodFixture('approvals.list');
    expect(candidate.content.name).toBe('approvals.list');
    expect(candidate.content).toHaveProperty('evidenceJson');
  });
});
