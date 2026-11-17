/**
 * Validators run only through the exec tool's path: in a session that
 * requires the exec boundary and has none, an edit's `validate` runs nothing
 * on the host.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateCache } from '../../platform/src/platform/state/file-cache.ts';
import { createEditTool } from '../../platform/src/platform/tools/edit/core.ts';
import { createExecValidatorRunner } from '../../platform/src/platform/tools/exec/runtime.ts';
import { OverflowHandler } from '../../platform/src/platform/tools/shared/overflow.ts';
import { ProcessManager } from '../../platform/src/platform/tools/shared/process-manager.ts';

test('a project build script named by validate does not run on the host when the session requires containment', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-validate-contained-')));
  try {
    const marker = join(root, 'build-ran');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: `touch ${marker}` } }));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const validatorRunner = createExecValidatorRunner(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      containment: { posture: 'required', reason: 'a hosted conversational turn' },
    });
    const tool = createEditTool(new FileStateCache(), { cwd: root, validatorRunner });
    const result = await tool.execute({ edits: [{ path: 'a.ts', find: 'a = 1', replace: 'a = 2' }], validate: { after: ['build'] } });
    expect(result.success).toBe(false);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
