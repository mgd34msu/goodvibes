import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import { AgentWorkspace, handleAgentWorkspaceToken } from '../../input/agent-workspace.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function feedKey(workspace: AgentWorkspace, logicalName: string): void {
  const token: InputToken = { type: 'key', name: logicalName, logicalName, ctrl: false, shift: false, meta: false };
  handleAgentWorkspaceToken(workspace, token, () => undefined, () => undefined);
}

function feedText(workspace: AgentWorkspace, value: string): void {
  handleAgentWorkspaceToken(workspace, { type: 'text', value }, () => undefined, () => undefined);
}

describe('Agent workspace memory editor', () => {
  test('a second Enter while the first save is still being written does not add a second record', async () => {
    const records: MemoryRecord[] = [];
    let adds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const memory = {
      add: async (input: { summary: string; detail: string; cls: MemoryRecord['cls'] }) => {
        adds += 1;
        await gate;
        const record = { id: `mem-${adds}`, scope: 'project', cls: input.cls, summary: input.summary, detail: input.detail, tags: [], provenance: [], reviewState: 'fresh', confidence: 80, createdAt: 1, updatedAt: 1 } as MemoryRecord;
        records.unshift(record);
        return record;
      },
      getAll: () => records,
      reviewQueue: async () => [],
      get: () => null,
      search: async () => records,
    } as unknown as MemoryApi;
    const ctx = {
      executeCommand: async () => true,
      print: () => {},
      workspace: {
        shellPaths: createShellPathService({
          workingDirectory: makeProjectTempDir('goodvibes-agent-memory-save'),
          homeDirectory: makeProjectTempDir('goodvibes-agent-memory-save-home'),
        }),
      },
      clients: { agentKnowledgeApi: { memory } },
    } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-create');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Prefers concise briefings');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Summarize before action.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'preference');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    await Promise.resolve();
    expect(adds).toBe(1);

    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    await Promise.resolve();
    expect(adds).toBe(1);

    release();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(workspace.lastActionResult?.title).toBe('Created memory');
  });
});
