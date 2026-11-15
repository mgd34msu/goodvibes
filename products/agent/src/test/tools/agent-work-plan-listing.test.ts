import { describe, expect, test } from 'bun:test';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { WorkPlanStore } from '@goodvibes-jev/engine/platform/platform/workflow';
import { createAgentWorkPlanTool, registerAgentWorkPlanTool } from '../../tools/agent-work-plan-tool.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';

function makeStore(): WorkPlanStore {
  const home = makeProjectTempDir('goodvibes-agent-work-plan-listing');
  return new WorkPlanStore({ homeDirectory: home, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, projectId: 'project:agent-work-plan-listing', projectRoot: home });
}

function admitted(store: WorkPlanStore): Tool {
  const tool = createAgentWorkPlanTool(store);
  return { ...tool, execute: args => admitLocalState(registry => registerAgentWorkPlanTool(registry, store), 'agent_work_plan', args, { directory: store.homeDirectory }) };
}

async function seed(tool: Tool, count: number, failed: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const created = await tool.execute({ action: 'create', title: `item ${String(index).padStart(2, '0')}`, ...(index <= failed ? { status: 'failed' } : {}) });
    expect(created.success).toBe(true);
  }
}

describe('agent_work_plan listing', () => {
  test('the summary counts every status, so the totals add up to the items', async () => {
    const tool = admitted(makeStore());
    await seed(tool, 25, 3);
    const listed = await tool.execute({ action: 'list' });
    expect(listed.output).toContain('items 25');
    expect(listed.output).toContain('pending 22');
    expect(listed.output).toContain('failed 3');
    expect(listed.output).toContain('cancelled 0');
  });

  test('an item past the first twenty is reachable by a limit or a status filter', async () => {
    const tool = admitted(makeStore());
    await seed(tool, 25, 3);
    const first = await tool.execute({ action: 'list' });
    expect(first.output).toContain('5 more item(s) omitted');
    expect(first.output).toContain('raise limit');
    expect(first.output).not.toContain('item 25');
    const all = await tool.execute({ action: 'list', limit: 50 });
    expect(all.output).toContain('item 25');
    expect(all.output).not.toContain('omitted');
    const failedOnly = await tool.execute({ action: 'list', status: 'failed' });
    expect(failedOnly.output).toContain('item 01');
    expect(failedOnly.output).not.toContain('item 25');
  });

  test('an update that changes nothing is refused', async () => {
    const tool = admitted(makeStore());
    await seed(tool, 1, 0);
    const listed = await tool.execute({ action: 'list' });
    const id = /^(\S+)\s+pending/m.exec(listed.output!)![1]!;
    const result = await tool.execute({ action: 'update', id });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Nothing to update');
  });

  test('a write with no recorded admission says it was held and not to retry it', async () => {
    const result = await createAgentWorkPlanTool(makeStore()).execute({ action: 'create', title: 'Unadmitted' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not caused by your arguments');
  });

  test('the description says clear_completed leaves failed items', () => {
    expect(createAgentWorkPlanTool(makeStore()).definition.description).toContain('failed items stay');
  });
});
