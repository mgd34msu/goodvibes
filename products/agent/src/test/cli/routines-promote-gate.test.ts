/** `goodvibes-agent routines promote` holds the same review gate as the terminal command. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { handleRoutinesCommand } from '../../cli/routines-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const roots: string[] = [];
const originalFetch = globalThis.fetch;

function setup(args: readonly string[]) {
  const root = makeProjectTempDir('gv-agent-routines-gate');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'routine-cli-token' }));
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, workingDir: workingDirectory, homeDir: homeDirectory });
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  // An imported routine: disabled and unreviewed.
  AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name: 'Imported Sweep',
    description: 'Imported from a project file.',
    steps: 'Do something unattended.',
    enabled: false,
    tags: [],
    triggers: [],
    source: 'imported',
    provenance: 'discovered:project:routines.md',
  });
  return { cli: parseGoodVibesCli([...args]), configManager, workingDirectory, homeDirectory };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('routines promote review gate', () => {
  test('--yes on a disabled, unreviewed routine is refused and nothing reaches the host', async () => {
    const methods: string[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return Response.json({});
    });
    const result = await handleRoutinesCommand(setup(['routines', 'promote', 'imported-sweep', '--cron', '0 8 * * *', '--yes', '--json']));
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.output);
    expect(body).toMatchObject({ ok: false, kind: 'routine_not_ready' });
    expect(body.error).toContain('disabled');
    expect(body.error).toContain('not been reviewed');
    expect(methods).toEqual([]);
  });

  test('the preview without --yes names what is missing', async () => {
    const result = await handleRoutinesCommand(setup(['routines', 'promote', 'imported-sweep', '--cron', '0 8 * * *']));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Not ready to promote imported-sweep');
  });
});
