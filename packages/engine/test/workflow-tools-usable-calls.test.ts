/**
 * Schema-valid calls to the team, worklist, state and task tools either work
 * or are refused with the current state and the allowed next step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamTool } from '../platform/src/platform/tools/team/index.js';
import { createWorklistTool } from '../platform/src/platform/tools/worklist/index.js';
import { createStateTool } from '../platform/src/platform/tools/state/index.js';
import { createTaskTool } from '../platform/src/platform/tools/task/index.js';
import { KVState } from '../platform/src/platform/state/kv-state.js';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { CrossSessionTaskRegistry } from '../platform/src/platform/sessions/orchestration/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-workflow-tools-'));
  roots.push(root);
  return root;
}

describe('team and worklist store under the host working directory', () => {
  test('a schema-valid team create succeeds without a storageRoot argument', async () => {
    const tool = createTeamTool({ workingDirectory: tempRoot() });
    const result = await tool.execute({ mode: 'create', teamId: 't', name: 'Team', summary: 'S' });
    expect(result.success).toBe(true);
    expect((await tool.execute({ mode: 'list' })).output).toContain('"t"');
  });

  test('a schema-valid worklist list succeeds without a storageRoot argument', async () => {
    const tool = createWorklistTool({ workingDirectory: tempRoot() });
    expect((await tool.execute({ mode: 'list' })).success).toBe(true);
  });

  test('without any root the refusal says not to retry', async () => {
    const result = await createTeamTool().execute({ mode: 'list' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('do not retry');
  });
});

describe('state modes that need missing services', () => {
  function stateTool() {
    const root = tempRoot();
    mkdirSync(join(root, 'state'));
    return createStateTool(new KVState({ stateDir: join(root, 'state') }), new ProjectIndex(root), { memoryDir: join(root, 'memory') });
  }

  test('hooks and analytics are not advertised and are refused with the available modes', async () => {
    const tool = stateTool();
    const modes = ((tool.definition.parameters as { properties: { mode: { enum: string[] } } }).properties.mode.enum);
    expect(modes).not.toContain('hooks');
    expect(modes).not.toContain('analytics');
    expect(tool.definition.description).not.toContain('mode=hooks');
    const result = await tool.execute({ mode: 'hooks', hookAction: 'add', hookDefinition: { eventPattern: 'x', type: 'command', match: 'y' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available in this session');
    expect(result.error).toContain('Available modes: get, set');
  });
});

describe('task refs', () => {
  function taskTool(sessionId: string, registry: CrossSessionTaskRegistry) {
    return createTaskTool(registry, { resolveSessionId: () => sessionId });
  }
  function registry(): CrossSessionTaskRegistry {
    return new CrossSessionTaskRegistry(join(tempRoot(), 'task-graph.json'), { sweepIntervalMs: 0 });
  }

  test('create does not overwrite an existing ref, including a final one', async () => {
    const reg = registry();
    const tool = taskTool('s1', reg);
    await tool.execute({ mode: 'create', taskId: 'a', title: 'A' });
    await tool.execute({ mode: 'status', taskId: 'a', status: 'running' });
    await tool.execute({ mode: 'status', taskId: 'a', status: 'completed' });
    const again = await tool.execute({ mode: 'create', taskId: 'a', title: 'A', status: 'queued' });
    expect(again.success).toBe(false);
    expect(again.error).toContain('already exists (status completed)');
    expect(reg.getRef('s1', 'a')?.status).toBe('completed');
  });

  test('a refused status move names the lifecycle reason; an unknown ref says to create it', async () => {
    const tool = taskTool('s1', registry());
    expect((await tool.execute({ mode: 'status', taskId: 'nope', status: 'running' })).error).toContain('Create it with mode=create first');
    await tool.execute({ mode: 'create', taskId: 'b', title: 'B' });
    await tool.execute({ mode: 'status', taskId: 'b', status: 'cancelled' });
    const refused = await tool.execute({ mode: 'status', taskId: 'b', status: 'running' });
    expect(refused.error).toContain('cancelled');
    expect(refused.error).toContain('cannot become running');
  });

  test('the destination session can acknowledge a handoff; other sessions cannot', async () => {
    const reg = registry();
    const source = taskTool('src', reg);
    await source.execute({ mode: 'create', taskId: 'h', title: 'H' });
    const handoff = await source.execute({ mode: 'handoff', taskId: 'h', toSessionId: 'dst' });
    const { handoffId } = JSON.parse(handoff.output ?? '{}') as { handoffId: string };
    expect((await taskTool('other', reg).execute({ mode: 'acknowledge', handoffId })).success).toBe(false);
    const ack = await taskTool('dst', reg).execute({ mode: 'acknowledge', handoffId });
    expect(ack.success).toBe(true);
    expect(reg.getHandoffs().find((record) => record.handoffId === handoffId)?.acknowledged).toBe(true);
  });
});
