// Proves: A command the model runs inherits the owner's API keys and tokens from the app's environment.
// Red when: The exec runtime passes the app's environment to the command without scrubbing credential-named variables and URLs that carry a password.
/**
 * The app runs with the owner's API keys, tokens and database URLs in its
 * environment. A command the model runs through the real exec tool does not
 * see them, and its output (which goes straight back to the model and into the
 * transcript) does not carry them; an ordinary variable still reaches it.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../platform/src/platform/tools/exec/index.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings([], EXEC_GATE_TABLE);

const owners = {
  OPENAI_API_KEY: 'sk-owner-api-key-value',
  GITHUB_TOKEN: 'ghp_owner-github-token-value',
  DATABASE_MIRROR: 'postgres://owner:db-password-value@db.internal:5432/prod',
};
const ORDINARY = { GV_TEST_ORDINARY: 'ordinary-value-reaches-the-command' };
const roots: string[] = [];
afterEach(() => {
  for (const name of [...Object.keys(owners), ...Object.keys(ORDINARY)]) delete process.env[name];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a command the model runs sees no credential from the app environment; an ordinary variable reaches it', async () => {
  Object.assign(process.env, owners, ORDINARY);
  const root = mkdtempSync(join(tmpdir(), 'gv-exec-env-'));
  roots.push(root);
  const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }), defaultWorkingDirectory: root });
  const result = await tool.execute({ commands: [{ cmd: 'env' }] });
  const output = JSON.stringify(result);
  expect(result.success).toBe(true);
  expect({
    leaked: Object.values(owners).filter((value) => output.includes(value)),
    ordinary: output.includes(ORDINARY.GV_TEST_ORDINARY),
  }).toEqual({ leaked: [], ordinary: true });
});
