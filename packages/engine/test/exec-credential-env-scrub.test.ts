/**
 * exec-credential-env-scrub.test.ts
 *
 * The exec env scrub: credential-bearing environment variables are withheld
 * from spawned tool processes, with the withheld NAMES (never values) reported
 * on the exec result. A per-command env override and a config allowlist both
 * re-admit a variable explicitly.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../platform/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import {
  readCredentialEnvName,
  resolveCredentialEnvScrub,
  scrubCredentialEnv,
} from '../platform/src/platform/tools/exec/credential-env.ts';
import { EXEC_GATE_TABLE, useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings(EXEC_GATE_TABLE);

describe('scrubCredentialEnv', () => {
  test('withholds conventional credential variables, keeps the rest', async () => {
    const { env, withheld } = await scrubCredentialEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        AWS_REGION: 'us-east-1',
        AWS_SECRET_ACCESS_KEY: 'shh',
        AWS_ACCESS_KEY_ID: 'AKIA',
        GITHUB_TOKEN: 'ght',
        OPENAI_API_KEY: 'sk-x',
        DB_PASSWORD: 'pw',
      },
      resolveCredentialEnvScrub(),
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(withheld).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'GITHUB_TOKEN', 'OPENAI_API_KEY']);
  });

  test('the withheld list carries names, never values', async () => {
    const { withheld } = await scrubCredentialEnv({ GITHUB_TOKEN: 'ght-value-1234', PATH: '/usr/bin' }, resolveCredentialEnvScrub());
    expect(withheld).toEqual(['GITHUB_TOKEN']);
    expect(JSON.stringify(withheld)).not.toContain('ght-value-1234');
  });

  test('allowlist re-admits a named var case-insensitively', async () => {
    const { env, withheld } = await scrubCredentialEnv(
      { GITHUB_TOKEN: 'ght', NPM_TOKEN: 'npm' },
      resolveCredentialEnvScrub({ allowlist: ['github_token'] }),
    );
    expect(env.GITHUB_TOKEN).toBe('ght');
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(withheld).toEqual(['NPM_TOKEN']);
  });

  test('a variable whose value is a URL with an embedded password is withheld whatever its name', async () => {
    const { env, withheld } = await scrubCredentialEnv(
      { MIRROR: 'https://user:hunter2@example.com/repo', PLAIN_URL: 'https://example.com/repo' },
      resolveCredentialEnvScrub(),
    );
    expect(withheld).toEqual(['MIRROR']);
    expect(env.PLAIN_URL).toBe('https://example.com/repo');
  });

  test('disabled passes env through untouched', async () => {
    const { env, withheld } = await scrubCredentialEnv({ GITHUB_TOKEN: 'ght' }, resolveCredentialEnvScrub({ enabled: false }));
    expect(env.GITHUB_TOKEN).toBe('ght');
    expect(withheld).toEqual([]);
  });

  test('credential names are recognised case-insensitively', async () => {
    expect(readCredentialEnvName('GITHUB_TOKEN')).toBe(true);
    expect(readCredentialEnvName('github_token')).toBe(true);
    expect(readCredentialEnvName('AWS_REGION')).toBe(false);
  });
});

describe('exec tool: env scrub end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-exec-scrub-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a credential var in this process env is absent from the child and reported as withheld', async () => {
    process.env.SCRUB_TEST_API_KEY = 'super-secret';
    try {
      const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
      const result = await tool.execute({
        working_dir: root,
        commands: [{ cmd: 'echo "val=[${SCRUB_TEST_API_KEY}]"' }],
      });
      const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
      expect(output.stdout).toContain('val=[]');
      expect(output.stdout).not.toContain('super-secret');
      expect(output.withheld_env).toContain('SCRUB_TEST_API_KEY');
    } finally {
      delete process.env.SCRUB_TEST_API_KEY;
    }
  });

  test('a per-command env override re-admits the value and it is not listed as withheld', async () => {
    process.env.SCRUB_TEST_API_KEY = 'super-secret';
    try {
      const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
      const result = await tool.execute({
        working_dir: root,
        commands: [{ cmd: 'echo "val=[${SCRUB_TEST_API_KEY}]"', env: { SCRUB_TEST_API_KEY: 'explicit' } }],
      });
      const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
      expect(output.stdout).toContain('val=[explicit]');
      expect(output.withheld_env ?? []).not.toContain('SCRUB_TEST_API_KEY');
    } finally {
      delete process.env.SCRUB_TEST_API_KEY;
    }
  });

  test('withheld_env, when present, is a name-only list (never values)', async () => {
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo hi' }] });
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
    expect(output.stdout).toContain('hi');
    // The list (if any) carries variable NAMES only, no '=' value payloads.
    for (const name of output.withheld_env ?? []) expect(name).not.toContain('=');
  });

  test('scrub can be disabled per exec tool instance', async () => {
    process.env.SCRUB_TEST_API_KEY = 'super-secret';
    try {
      const tool = createExecTool(new ProcessManager(), {
        overflowHandler: new OverflowHandler({ baseDir: root }),
        credentialEnvScrub: { enabled: false },
      });
      const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo "val=[${SCRUB_TEST_API_KEY}]"' }] });
      const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
      expect(output.stdout).toContain('val=[super-secret]');
      expect(output.withheld_env).toBeUndefined();
    } finally {
      delete process.env.SCRUB_TEST_API_KEY;
    }
  });
});
