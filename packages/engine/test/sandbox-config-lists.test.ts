import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { createSandboxRuntimeConfig, sandboxAbsolutePaths, sandboxCommandNames } from '../platform/src/platform/tools/exec/sandbox-config-lists.ts';

describe('sandbox lists read from a hand-edited settings file', () => {
  test('a bare string is not a list, so "*" cannot become an allow-all egress entry', () => {
    expect(sandboxCommandNames('*')).toEqual([]);
    expect(sandboxCommandNames(['curl', '', '  ', 3])).toEqual(['curl']);
  });

  test('a bare string or relative path is not a writable path', () => {
    expect(sandboxAbsolutePaths('/tmp/x')).toEqual([]);
    expect(sandboxAbsolutePaths(['/tmp/x', 'rel/path', 7])).toEqual(['/tmp/x']);
  });
});

describe('the sandbox runtime config built from a settings file', () => {
  test('a hand-edited "*" egress entry and a relative writable path reach the sandbox as empty lists', () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-config-lists-'));
    try {
      const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: join(root, 'project'), surfaceRoot: 'tui' });
      mkdirSync(dirname(config.getConfigPath()), { recursive: true });
      writeFileSync(config.getConfigPath(), JSON.stringify({ sandbox: { egressAllowlist: '*', workspaceWritable: 'rel/path' } }));
      config.load();
      const runtime = createSandboxRuntimeConfig(config);
      expect(runtime.egressAllowlist).toEqual([]);
      expect(runtime.workspaceWritable).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
