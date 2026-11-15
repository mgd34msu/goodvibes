import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function runRelayCli(args: readonly string[], workingDirectory: string, homeDirectory: string) {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory,
      homeDirectory,
    });
    return { result, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('relay CLI command', () => {
  test('parses the relay command', () => {
    expect(parseGoodVibesCli(['relay', 'status']).command).toBe('relay');
  });

  test('status and pair ask the connected host and, with none to ask, say so as JSON', async () => {
    const home = makeProjectTempDir('goodvibes-agent-relay-cli');
    const work = makeProjectTempDir('goodvibes-agent-relay-cli-work');
    for (const sub of ['status', 'pair']) {
      const { result, output } = await runRelayCli(['relay', sub, '--output-format=json'], work, home);
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(output) as { ok: boolean; kind: string; next: readonly string[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('connected_host_unavailable');
      expect(parsed.next.length).toBeGreaterThan(0);
    }
  });

  test('unknown relay subcommand is a usage error, not a silent success', async () => {
    const home = makeProjectTempDir('goodvibes-agent-relay-cli');
    const work = makeProjectTempDir('goodvibes-agent-relay-cli-work');

    const { result, output } = await runRelayCli(['relay', 'bogus'], work, home);
    expect(result.exitCode).toBe(2);
    expect(output).toContain('Unknown relay subcommand');
  });

});
