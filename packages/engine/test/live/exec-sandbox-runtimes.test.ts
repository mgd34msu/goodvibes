/**
 * Inside real bubblewrap, a project's own test run (here `bun test`, the
 * runtime an agent most often starts) cannot see a private file outside the
 * workspace, cannot replace the interpreter, and has no network route; the
 * private file is unchanged afterwards.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecTool } from '../../platform/src/platform/tools/exec/runtime.js';
import { detectSandboxAvailability, probeSandboxHost } from '../../platform/src/platform/tools/exec/sandbox.js';
import { ProcessManager } from '../../platform/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../../platform/src/platform/tools/shared/overflow.js';
import { useToolReadings } from '../_helpers/tool-readings.js';
import { requireLiveHost } from '../_helpers/exec-containment-proof.ts';

useToolReadings();
const availability = detectSandboxAvailability(probeSandboxHost());
requireLiveHost('ordinary runtime containment backend', availability.available);

test('ordinary sandbox runs Bun tests while keeping home, runtime writes and host networking unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-js-runtime-'));
  const workspace = join(root, 'project'), home = join(root, 'private-home');
  mkdirSync(workspace); mkdirSync(home);
  const privatePath = join(home, 'private.txt'); writeFileSync(privatePath, 'PRIVATE_RUNTIME_SENTINEL');
  writeFileSync(join(workspace, 'runtime.test.ts'), `import { expect, test } from 'bun:test';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
test('real contained Bun execution', () => {
  expect(2 + 2).toBe(4);
  expect(existsSync(${JSON.stringify(privatePath)})).toBe(false);
  expect(() => writeFileSync(process.execPath, 'must not replace the interpreter')).toThrow();
  expect(readFileSync('/proc/net/route', 'utf8').trim().split('\\n')).toHaveLength(1);
});\n`);
  const manager = new ProcessManager();
  const tool = createExecTool(manager, { defaultWorkingDirectory: workspace,
    overflowHandler: new OverflowHandler({ baseDir: workspace }), credentialEnvScrub: { enabled: false },
    sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true, homeDir: home } });
  try {
    const result = await tool.execute({ commands: [{ cmd: 'bun test', progress: false, timeout_ms: 10_000 }] });
    expect(result.success, result.output ?? result.error).toBe(true);
    const output = JSON.parse(result.output!);
    expect(output).toMatchObject({ sandboxed: true, sandbox_network: 'disabled', exit_code: 0 });
    expect(readFileSync(privatePath, 'utf8')).toBe('PRIVATE_RUNTIME_SENTINEL');
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
