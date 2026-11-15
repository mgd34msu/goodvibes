import { expect, test } from 'bun:test';
import { isPinnedWorkspaceVersion } from '../toolchain/src/lib/workspace-version.ts';

test('build versions accept pinned development versions while rejecting ranges, invalid identifiers and leading zeros', () => {
  for (const version of ['3.0.0', '3.0.0-dev.0', '3.0.0-rc.1+build.7']) expect(isPinnedWorkspaceVersion(version)).toBe(true);
  for (const version of ['latest', '^3.0.0', 'v3.0.0', '03.0.0', '3.0.0-dev.01', '3.0.0-', '3.0', ' 3.0.0']) expect(isPinnedWorkspaceVersion(version)).toBe(false);
});
