/**
 * The write and edit tools hand the call's cancel signal to the validator
 * runner, so a cancelled call stops the validator process it started.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool } from '../platform/src/platform/tools/edit/core.ts';
import { createWriteTool } from '../platform/src/platform/tools/write/index.ts';
import type { ValidatorName, ValidatorResult, ValidatorRunner } from '../platform/src/platform/tools/shared/validators.ts';
import { FileStateCache } from '../platform/src/platform/state/file-cache.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = (): string => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-validator-signal-'))); roots.push(root); return root; };

function recordingRunner(): { runner: ValidatorRunner; seen: Array<{ name: ValidatorName; signal: AbortSignal | undefined }> } {
  const seen: Array<{ name: ValidatorName; signal: AbortSignal | undefined }> = [];
  const runner: ValidatorRunner = async (name, _cwd, execution): Promise<ValidatorResult> => {
    seen.push({ name, signal: execution?.signal });
    return { validator: name, passed: true, stdout: '', stderr: '', exitCode: 0 };
  };
  return { runner, seen };
}

test('write passes the call signal to the post-write validator', async () => {
  const root = project();
  const { runner, seen } = recordingRunner();
  const controller = new AbortController();
  const result = await createWriteTool({ projectRoot: root, validatorRunner: runner }).execute(
    { files: [{ path: 'a.txt', content: 'x' }], validate: { after: ['lint'] } },
    { signal: controller.signal },
  );
  expect(result.success).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.signal).toBe(controller.signal);
});

test('edit passes the call signal to the pre-edit and post-edit validators', async () => {
  const root = project();
  writeFileSync(join(root, 'a.ts'), 'const x = 1;\n', 'utf-8');
  const { runner, seen } = recordingRunner();
  const controller = new AbortController();
  const tool = createEditTool(new FileStateCache(), { cwd: root, validatorRunner: runner });
  const result = await tool.execute(
    { edits: [{ path: 'a.ts', find: 'const x = 1;', replace: 'const x = 2;' }], validate: { before: ['lint'], after: ['test'] } },
    { signal: controller.signal },
  );
  expect(result.success).toBe(true);
  expect(seen.map((entry) => entry.name)).toEqual(['lint', 'test']);
  for (const entry of seen) expect(entry.signal).toBe(controller.signal);
});
