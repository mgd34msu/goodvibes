import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { CommandContext } from '../../input/command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { OPERATOR_ACTION_IDS } from '../../agent/operator-actions.ts';
import { describeCliCommandPolicy } from '../../tools/agent-harness-cli-command-policy.ts';
import {
  CONNECTED_HOST_LIFECYCLE_STATEMENT,
  blockedConnectedHostCapabilities,
  connectedHostCapabilityMap,
  connectedHostSummary,
} from '../../tools/agent-harness-connected-host-capabilities.ts';
import { SOURCE_KINDS } from '../../tools/agent-knowledge-ingest-tool.ts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { connectedHostStatusSummary } from '../../tools/agent-harness-connected-host-status.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

function stubTool(name: string): Tool {
  return { definition: { name, description: `Synthetic ${name}`, parameters: { type: 'object', properties: {} } }, execute: async () => ({ success: true }) };
}
function capability(registry: ToolRegistry, id: string): Record<string, unknown> {
  const found = connectedHostCapabilityMap(registry).find((entry) => entry.id === id);
  if (!found) throw new Error(`capability ${id} is not in the map`);
  return found;
}

describe('connected-host capability map', () => {
  test('ingest source kinds and operator actions come from their owners', () => {
    const registry = new ToolRegistry();
    expect(capability(registry, 'agent-knowledge-ingest').sourceKinds).toEqual([...SOURCE_KINDS]);
    expect(capability(registry, 'agent-knowledge-ingest').sourceKinds).toContain('artifact');
    expect(capability(registry, 'operator-actions').allowedActions).toEqual([...OPERATOR_ACTION_IDS]);
  });

  test('every workspace category a capability names exists in the category table', () => {
    const known = new Set<string>(AGENT_WORKSPACE_CATEGORIES.map((category) => category.id));
    const registry = new ToolRegistry();
    const named = [...connectedHostCapabilityMap(registry), ...blockedConnectedHostCapabilities()]
      .flatMap((entry) => Array.isArray(entry.workspaceCategories) ? entry.workspaceCategories : []);
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(known.has(String(id))).toBe(true);
  });

  test('alternative tools make a capability available when any one is registered', () => {
    // schedule-edit lists `schedule` and `agent_schedule_edit` and joins them with "or".
    const none = new ToolRegistry();
    expect(capability(none, 'schedule-edit').available).toBe(false);
    const second = new ToolRegistry();
    second.register(stubTool('agent_schedule_edit'));
    expect(capability(second, 'schedule-edit')).toMatchObject({ available: true, modelRoute: 'schedule or agent_schedule_edit' });
    const first = new ToolRegistry();
    first.register(stubTool('schedule'));
    expect(capability(first, 'schedule-edit').available).toBe(true);
  });

  test('the CLI mirror and the host summary state the same lifecycle rule, and no absolute path is shown', () => {
    const home = makeProjectTempDir('connected-host-summary');
    const config = { get: () => undefined, getHomeDirectory: () => home };
    const context = { workspace: { shellPaths: { homeDirectory: home } }, platform: { configManager: config } } as unknown as CommandContext;
    const summary = connectedHostSummary(context, new ToolRegistry());
    expect(summary.lifecycle).toBe(CONNECTED_HOST_LIFECYCLE_STATEMENT);
    expect(describeCliCommandPolicy('daemon').boundary).toContain(CONNECTED_HOST_LIFECYCLE_STATEMENT);
    expect(String(summary.tokenPath).startsWith('~')).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(home);
  });

  test('the live status states the same lifecycle rule and shows no absolute path when the host is unreachable', async () => {
    const home = makeProjectTempDir('connected-host-status'), working = join(home, 'work');
    mkdirSync(working);
    const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(home, '.goodvibes', 'agent'), workingDir: working, homeDir: home });
    const context = { workspace: { shellPaths: { homeDirectory: home, workingDirectory: working } }, platform: { configManager } } as unknown as CommandContext;
    const fetchOwner: { fetch: typeof fetch } = globalThis;
    const spy = spyOn(fetchOwner, 'fetch').mockImplementation(mockFetch(async () => { throw new Error('connection refused'); }));
    try {
      const status = await connectedHostStatusSummary(context, new ToolRegistry());
      expect(status.lifecycle).toBe(CONNECTED_HOST_LIFECYCLE_STATEMENT);
      expect(JSON.stringify(status)).not.toContain(home);
      expect(status.paths).toMatchObject({ homeDirectory: '~' });
      const findings = JSON.stringify(status.findings);
      expect(findings).toContain('connected-host-unreachable');
      expect(findings).toContain('connected-host-token-missing');
    } finally { spy.mockRestore(); }
  });
});
