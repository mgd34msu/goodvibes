/**
 * The set of remembered captured roots stays small in a daemon that outlives many contracts: the
 * product-owned view layout is denied by its shape, and only a path outside it is remembered.
 */
import { expect, test } from 'bun:test';
import { capturedInputRootCount, isCapturedInputPath, markCapturedInputPath } from '../../platform/src/platform/contract/input-authority.js';

test('views and worktrees in the product layout are denied without being remembered one by one', () => {
  const before = capturedInputRootCount();
  for (let index = 0; index < 500; index += 1) {
    markCapturedInputPath(`/work/project/.goodvibes/.worktrees/contract-input/gen-${index}`);
    markCapturedInputPath(`/work/project/.goodvibes/.worktrees/contract/ctr-${index}`);
  }
  expect(capturedInputRootCount()).toBe(before);
  expect(isCapturedInputPath('/work/project/.goodvibes/.worktrees/contract-input/gen-7/src/index.ts')).toBe(true);
  expect(isCapturedInputPath('/work/project/.goodvibes/.worktrees/contract/ctr-499')).toBe(true);
});

test('a captured root outside the layout is remembered, and only that root and what is under it is denied', () => {
  const root = '/elsewhere/custom-view-7f3a';
  expect(isCapturedInputPath(`${root}/file.ts`)).toBe(false);
  markCapturedInputPath(root);
  expect(isCapturedInputPath(root)).toBe(true);
  expect(isCapturedInputPath(`${root}/file.ts`)).toBe(true);
  expect(isCapturedInputPath(`${root}-sibling/file.ts`)).toBe(false);
});
