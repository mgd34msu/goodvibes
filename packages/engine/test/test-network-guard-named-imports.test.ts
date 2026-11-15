import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bun fixes a builtin's named exports when it is first imported, so this has to
// run in a fresh process where the preload is the first to touch node:http.
test('named imports of node:http and node:https clients are refused for a non-loopback host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-named-'));
  try {
    const script = join(dir, 'probe.ts');
    writeFileSync(script, [
      "import { request, get } from 'node:http';",
      "import { request as secureRequest } from 'node:https';",
      "import { connect } from 'node:tls';",
      'const outcomes: string[] = [];',
      'for (const attempt of [() => request("http://192.0.2.1/"), () => get("http://192.0.2.1/"),',
      '  () => secureRequest("https://192.0.2.1/"), () => connect({ host: "192.0.2.1", port: 443 })]) {',
      '  try { attempt(); outcomes.push("allowed"); } catch (error) { outcomes.push((error as Error).name); }',
      '}',
      'console.log(JSON.stringify(outcomes));',
      'process.exit(0);',
    ].join('\n'));
    const preload = join(import.meta.dir, '../toolchain/src/test-runner/test-network-preload.ts');
    const run = Bun.spawnSync([process.execPath, '--preload', preload, script], { env: { PATH: process.env.PATH ?? '', HOME: dir }, stdout: 'pipe', stderr: 'pipe' });
    expect(run.stderr.toString()).toBe('');
    expect(JSON.parse(run.stdout.toString())).toEqual(Array(4).fill('TestExternalNetworkError'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
