/**
 * The repl tool with local host execution as the only sandbox backend.
 *
 * Local execution runs a command directly on the host and does not isolate it,
 * so every eval path refuses before running anything, with one fixed message.
 * What still happens: the sandbox session for the runtime's eval profile starts
 * (and runs no command in it) and is stopped again, the attempt lands in the runtime-tagged history
 * with the refusal as its error, and history mode reads the file back. The
 * history lives in the host's project directory; a model-supplied workspaceRoot
 * is never honoured.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.ts';
import { createReplTool, REPL_NO_ISOLATING_BACKEND_ERROR } from '../platform/src/platform/tools/repl/index.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import type { Tool } from '../platform/src/platform/types/tools.ts';

const EXPECTED_REFUSAL =
  'REPL eval needs an isolating sandbox backend, and none is available: the only sandbox backend is local host execution (sandbox.vmBackend "local"), which does not isolate evaluated code.';

let workspaceRoot = '';
let registry: SandboxSessionRegistry;
let replTool: Tool;

function historyPath(): string {
  return join(workspaceRoot, '.goodvibes', 'tui', 'repl-history.json');
}

beforeEach(() => {
  workspaceRoot = makeProjectTempDir('goodvibes-repl-');
  const configManager = new ConfigManager({ configDir: join(workspaceRoot, 'config') });
  registry = new SandboxSessionRegistry(workspaceRoot);
  replTool = createReplTool(configManager, registry, { surfaceRoot: 'tui', workingDirectory: workspaceRoot });
});

const RUNTIMES = [
  { runtime: 'javascript', expression: '1 + 2', profileId: 'eval-js' },
  { runtime: 'typescript', expression: 'const value: number = 4; value * 2;', profileId: 'eval-ts' },
  { runtime: 'python', expression: '[x * 2 for x in range(3)]', profileId: 'eval-py' },
  { runtime: 'sql', expression: 'select value from sandbox_eval order by id;', profileId: 'eval-sql' },
  { runtime: 'graphql', expression: 'query Viewer { viewer { id name } }', profileId: 'eval-graphql' },
] as const;

describe('repl tool', () => {
  test('the refusal is the fixed message the tool exports', () => {
    expect(REPL_NO_ISOLATING_BACKEND_ERROR).toBe(EXPECTED_REFUSAL);
  });

  for (const { runtime, expression, profileId } of RUNTIMES) {
    test(`${runtime} eval refuses with the exact message and starts one ${profileId} session that runs nothing`, async () => {
      const result = await replTool.execute(({ mode: 'eval', runtime, expression }));
      expect(result.success).toBe(false);
      expect(result.error).toBe(EXPECTED_REFUSAL);
      const sessions = registry.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.profileId).toBe(profileId);
      expect(sessions[0]?.label).toBe(`repl:${runtime}`);
      expect(sessions[0]?.executionCount).toBeUndefined();
    });
  }

  test('eval defaults to javascript: one eval-js session labelled repl:javascript with no execution', async () => {
    const result = await replTool.execute(({ mode: 'eval', expression: '21 + 21' }));
    expect(result.error).toBe(EXPECTED_REFUSAL);
    const sessions = registry.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.profileId).toBe('eval-js');
    expect(sessions[0]?.label).toBe('repl:javascript');
    expect(sessions[0]?.executionCount).toBeUndefined();
  });

  test('a refused eval leaves no sandbox session running', async () => {
    await replTool.execute(({ mode: 'eval', runtime: 'javascript', expression: '1' }));
    await replTool.execute(({ mode: 'eval', runtime: 'python', expression: '1' }));
    expect(registry.list().filter((session) => session.state === 'running')).toHaveLength(0);
  });

  test('evaluated code never runs on the host', async () => {
    const jsMarker = join(workspaceRoot, 'js-ran');
    const pyMarker = join(workspaceRoot, 'py-ran');
    await replTool.execute(({
      mode: 'eval',
      runtime: 'javascript',
      expression: `require('node:fs').writeFileSync(${JSON.stringify(jsMarker)}, 'x')`,
    }));
    await replTool.execute(({
      mode: 'eval',
      runtime: 'python',
      expression: `open(${JSON.stringify(pyMarker)}, 'w').write('x')`,
    }));
    expect(existsSync(jsMarker)).toBe(false);
    expect(existsSync(pyMarker)).toBe(false);
  });

  test('records runtime-tagged history entries carrying the refusal', async () => {
    await replTool.execute(({ mode: 'eval', runtime: 'javascript', expression: '7 * 6' }));
    await replTool.execute(({ mode: 'eval', runtime: 'sql', expression: 'select 1;' }));
    expect(existsSync(historyPath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(historyPath(), 'utf-8')) as Array<Record<string, unknown>>;
    const sessionIds = registry.list().map((session) => session.id).sort();
    expect(onDisk.map((entry) => [entry.runtime, entry.expression, entry.error, entry.backend])).toEqual([
      ['javascript', '7 * 6', EXPECTED_REFUSAL, 'local'],
      ['sql', 'select 1;', EXPECTED_REFUSAL, 'local'],
    ]);
    expect(onDisk.every((entry) => entry.result === undefined)).toBe(true);
    expect(onDisk.map((entry) => entry.sessionId).sort()).toEqual(sessionIds);
  });

  test('history mode returns the recorded attempts', async () => {
    const empty = await replTool.execute(({ mode: 'history' }));
    expect(empty).toEqual({ success: true, output: JSON.stringify({ count: 0, history: [] }) });
    await replTool.execute(({ mode: 'eval', runtime: 'javascript', expression: '7 * 6' }));
    const history = await replTool.execute(({ mode: 'history' }));
    expect(history.success).toBe(true);
    const parsed = JSON.parse(history.output ?? '') as { count: number; history: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.history[0]).toMatchObject({ runtime: 'javascript', expression: '7 * 6', error: EXPECTED_REFUSAL });
    expect(history.output).toContain('"runtime":"javascript"');
  });

  test('history is answered from the host project directory, with no workspaceRoot argument', async () => {
    const result = await replTool.execute({ mode: 'history' });
    expect(result).toEqual({ success: true, output: JSON.stringify({ count: 0, history: [] }) });
  });

  test('a workspaceRoot argument is not honoured', async () => {
    const elsewhere = makeProjectTempDir('goodvibes-repl-elsewhere-');
    await replTool.execute({ mode: 'eval', expression: '1', workspaceRoot: elsewhere });
    expect(existsSync(join(elsewhere, '.goodvibes'))).toBe(false);
    expect(existsSync(historyPath())).toBe(true);
  });

  test('history pages with offset and limit', async () => {
    for (const expression of ['1', '2', '3']) await replTool.execute({ mode: 'eval', expression });
    const page = await replTool.execute({ mode: 'history', offset: 1, limit: 1 });
    const parsed = JSON.parse(page.output ?? '') as { count: number; history: Array<{ expression: string }>; has_more: boolean };
    expect(parsed.count).toBe(3);
    expect(parsed.history.map((entry) => entry.expression)).toEqual(['2']);
    expect(parsed.has_more).toBe(true);
  });

  test('a history file that cannot be parsed is reported and never overwritten', async () => {
    mkdirSync(join(workspaceRoot, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(historyPath(), '{ not json');
    const history = await replTool.execute({ mode: 'history' });
    expect(history.success).toBe(false);
    expect(history.error).toContain('cannot be read');
    const evaluation = await replTool.execute({ mode: 'eval', expression: '1' });
    expect(evaluation.success).toBe(false);
    expect(evaluation.error).toContain('cannot be read');
    expect(readFileSync(historyPath(), 'utf-8')).toBe('{ not json');
  });

  test('without a host project directory history says so and eval gives the backend refusal', async () => {
    const bare = createReplTool(new ConfigManager({ configDir: join(workspaceRoot, 'bare-config') }), registry, { surfaceRoot: 'tui' });
    const history = await bare.execute({ mode: 'history' });
    expect(history.success).toBe(false);
    expect(history.error).toContain('project directory');
    expect(await bare.execute({ mode: 'eval', expression: '1' })).toEqual({ success: false, error: EXPECTED_REFUSAL });
  });

  test('eval without an expression starts no session and records nothing', async () => {
    const result = await replTool.execute(({ mode: 'eval', runtime: 'javascript' }));
    expect(result).toEqual({ success: false, error: 'eval requires expression.' });
    expect(registry.list()).toHaveLength(0);
    expect(existsSync(historyPath())).toBe(false);
  });

  test('a registry hands the model a tool whose first call (history, no workspaceRoot) succeeds', async () => {
    const tools = new ToolRegistry();
    tools.register(replTool);
    expect(tools.getToolDefinitions().map((definition) => definition.name)).toContain('repl');
    const result = await tools.execute('call-1', 'repl', { mode: 'history' });
    expect(result).toMatchObject({ success: true, output: JSON.stringify({ count: 0, history: [] }) });
  });
});
