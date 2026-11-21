// Proves: A project test run inside the sandbox reads a private file in home, replaces the interpreter, or has a network route.
// Red when: Home is bound into the sandbox, a secret inside a cache folder shown through the home mask is not covered again, the runtime becomes writable, or the network namespace is shared: the inner run exits non-zero.
// Proves: A contained command names a working directory outside the project and can write there.
// Red when: The exec runtime stops refusing a contained command whose working directory is outside the project root, or a link inside the project that leads out of it.
/**
 * Inside real bubblewrap, a project's own test run (here `bun test`, the
 * runtime an agent most often starts) cannot see a private file outside the
 * workspace, cannot replace the interpreter, and has no network route; the
 * private file is unchanged afterwards.
 *
 * The boundary binds the command's working directory writable, so a contained
 * command may not move it out of the project: a working directory outside the
 * project root, or a link in the project that leads out, is refused before
 * anything runs.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('a folder shown through the home mask does not show the browser profile, registry token or git credential store inside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-home-cache-'));
  const workspace = join(root, 'project'), home = join(root, 'private-home');
  const cache = join(home, '.cache'), cargo = join(cache, 'cargo');
  const cookies = join(cache, 'chromium', 'Default', 'Cookies'), token = join(cargo, 'credentials.toml'), built = join(cache, 'go-build', 'object');
  // Git's configuration folder is shown read-only; the credential store git keeps beside it is not.
  const gitConfig = join(home, '.config', 'git'), gitCredentials = join(gitConfig, 'credentials'), gitSettings = join(gitConfig, 'config');
  for (const dir of [workspace, join(cache, 'chromium', 'Default'), join(cache, 'go-build'), join(cargo, 'registry'), gitConfig]) mkdirSync(dir, { recursive: true });
  writeFileSync(cookies, 'BROWSER_COOKIE_SENTINEL');
  writeFileSync(token, 'REGISTRY_TOKEN_SENTINEL');
  writeFileSync(gitCredentials, 'GIT_CREDENTIAL_SENTINEL');
  writeFileSync(gitSettings, 'GIT_SETTINGS_SHOWN');
  // The folders the view reads come from these variables; pinned to this home so the case does not depend on the caller's.
  const saved = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, CARGO_HOME: process.env.CARGO_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.XDG_CACHE_HOME = cache;
  process.env.CARGO_HOME = cargo;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  writeFileSync(join(workspace, 'home.test.ts'), `import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const read = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
test('caches are writable, the secrets inside them are not there', () => {
  writeFileSync(${JSON.stringify(built)}, 'built');
  expect({ cookies: existsSync(${JSON.stringify(cookies)}), token: read(${JSON.stringify(token)}).includes('SENTINEL'), gitCredentials: read(${JSON.stringify(gitCredentials)}).includes('SENTINEL'), gitSettings: read(${JSON.stringify(gitSettings)}) })
    .toEqual({ cookies: false, token: false, gitCredentials: false, gitSettings: 'GIT_SETTINGS_SHOWN' });
});\n`);
  const manager = new ProcessManager();
  const tool = createExecTool(manager, { defaultWorkingDirectory: workspace,
    overflowHandler: new OverflowHandler({ baseDir: workspace }), credentialEnvScrub: { enabled: false },
    sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true, homeDir: home } });
  try {
    const result = await tool.execute({ commands: [{ cmd: 'bun test', progress: false, timeout_ms: 10_000 }] });
    expect(result.success, result.output ?? result.error).toBe(true);
    expect(JSON.parse(result.output!)).toMatchObject({ sandboxed: true, exit_code: 0 });
    // The control: the cache write reached the host, so the cache folder really was shown.
    expect(readFileSync(built, 'utf8')).toBe('built');
    expect([readFileSync(cookies, 'utf8'), readFileSync(token, 'utf8')]).toEqual(['BROWSER_COOKIE_SENTINEL', 'REGISTRY_TOKEN_SENTINEL']);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await manager.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('a contained command cannot move its working directory out of the project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-working-dir-'));
  const workspace = join(root, 'project'), outside = join(root, 'elsewhere');
  mkdirSync(workspace); mkdirSync(outside);
  symlinkSync(outside, join(workspace, 'out'));
  const manager = new ProcessManager();
  const tool = createExecTool(manager, { defaultWorkingDirectory: workspace,
    overflowHandler: new OverflowHandler({ baseDir: workspace }), credentialEnvScrub: { enabled: false },
    sandbox: { config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability, featureEnabled: true } });
  try {
    const wrote: Record<string, boolean> = {};
    for (const [row, dir, marker] of [['outside the root', outside, 'first'], ['a link that leads out', join(workspace, 'out'), 'second'], ['inside the root', workspace, 'third']] as const) {
      await tool.execute({ working_dir: dir, commands: [{ cmd: `touch ${marker}`, progress: false }] });
      wrote[row] = existsSync(join(outside, marker)) || existsSync(join(workspace, marker));
    }
    expect(wrote).toEqual({ 'outside the root': false, 'a link that leads out': false, 'inside the root': true });
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
