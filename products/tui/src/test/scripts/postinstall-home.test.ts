import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../../scripts/postinstall.js');

async function provisioningHome(env: Record<string, string>): Promise<string> {
  const child = Bun.spawn([process.execPath, '--eval', `import(${JSON.stringify(script)}).then((m) => console.log(m.provisioningHome))`], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdout: 'pipe', stderr: 'pipe',
  });
  const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return out.trim();
}

test('provisioned skills and agents land under the tree the runtime reads when GOODVIBES_HOME is set', async () => {
  const redirected = mkdtempSync(join(tmpdir(), 'gv-postinstall-home-'));
  try {
    expect(await provisioningHome({ GOODVIBES_HOME: redirected })).toBe(redirected);
  } finally { rmSync(redirected, { recursive: true, force: true }); }
});
