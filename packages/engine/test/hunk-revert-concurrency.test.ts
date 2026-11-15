/** A hunk revert must not overwrite an edit saved while its safety snapshot ran, and must name the undo point even when the snapshot was a no-op. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { applyHunkRevert, HunkRevertConflictError, type HunkRevertWorkspace } from '../platform/src/platform/workspace/hunk-revert.js';
import type { WorkspaceCheckpoint } from '../platform/src/platform/workspace/checkpoint/types.js';

const HUNK = ['@@ -1,3 +1,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 20;', '+const c = 3;', ' const d = 4;'].join('\n');
const NEW_CONTENT = ['const a = 1;', 'const b = 20;', 'const c = 3;', 'const d = 4;', ''].join('\n');
const checkpoint = (id: string): WorkspaceCheckpoint => ({ id, kind: 'manual', label: '', createdAt: 1, parentId: null, retentionClass: 'standard', commit: 'c', sizeBytes: 1 });

describe('applyHunkRevert while the workspace changes', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hunk-revert-race-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('an edit saved during the snapshot is kept and the revert is refused', async () => {
    writeFileSync(join(root, 'f.ts'), NEW_CONTENT, 'utf8');
    const edited = `${NEW_CONTENT}// saved while the snapshot ran\n`;
    const workspace: HunkRevertWorkspace = {
      resolveRoot: async () => root,
      create: async () => { writeFileSync(join(root, 'f.ts'), edited, 'utf8'); return checkpoint('wcp_safety'); },
    };
    await expect(applyHunkRevert(workspace, 'f.ts', HUNK)).rejects.toBeInstanceOf(HunkRevertConflictError);
    expect(readFileSync(join(root, 'f.ts'), 'utf8')).toBe(edited);
  });

  test('a no-op snapshot still reports the latest checkpoint as the undo point', async () => {
    writeFileSync(join(root, 'f.ts'), NEW_CONTENT, 'utf8');
    const workspace: HunkRevertWorkspace = {
      resolveRoot: async () => root,
      create: async () => null,
      list: async () => [checkpoint('wcp_latest')],
    };
    const receipt = await applyHunkRevert(workspace, 'f.ts', HUNK);
    expect(receipt.safetyCheckpointId).toBeNull();
    expect(receipt.undo).toEqual({ restoreCheckpointId: 'wcp_latest' });
  });
});
