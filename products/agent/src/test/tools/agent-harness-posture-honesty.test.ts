import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { MemoryUsageStatsStore } from '@goodvibes-jev/engine/platform/platform/state';
import type { McpApi, McpServerSecurityRecord } from '@goodvibes-jev/engine/platform/platform/mcp';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { isMemoryPromptEligible } from '../../tools/agent-harness-learning-curator-common.ts';
import { mcpServerSummary } from '../../tools/agent-harness-mcp-metadata.ts';
import { liveUsageSummary, memoryPostureSummary } from '../../tools/agent-harness-memory-posture.ts';
import { readTimestamp } from '../../tools/agent-harness-memory-external-providers.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createHarnessFixtureReadings, executeHarnessJson, makeFixture } from './agent-harness-tool-fixture.ts';

afterAll(cleanupResearchScreeningFixtures);
let previousPort: JudgmentPort | undefined;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), log));
});
afterEach(() => { setSystemTime(); installJudgmentPort(previousPort); log[Symbol.dispose](); });

describe('MCP server listing', () => {
  function mcpContext() {
    const servers: McpServerSecurityRecord[] = [{ name: 'files', connected: true, role: 'analytics', trustMode: 'constrained', schemaFreshness: 'fresh', allowedPaths: [], allowedHosts: [] }];
    const tools = [{ qualifiedName: 'mcp:files:read', serverName: 'files', toolName: 'read', description: 'Read a file. '.repeat(100) },
      { qualifiedName: 'mcp:files:list', serverName: 'files', toolName: 'list', description: 'List files.' }];
    const catalog = { async listAllTools() { return tools; }, assertCurrent() {} };
    const api = { listServerSecurity: () => servers, listAllTools: async () => tools, captureToolCatalog: () => Object.freeze(catalog) } as unknown as Pick<McpApi, 'listServerSecurity' | 'listAllTools' | 'captureToolCatalog'>;
    return { clients: { mcpApi: api }, extensions: {} };
  }
  const options = () => ({ sourceOwner: ordinaryResearchOwner() });

  test('the default listing does not claim a tool count it did not read', async () => {
    const result = await mcpServerSummary(mcpContext(), {}, options());
    expect(result.servers).toEqual([expect.not.objectContaining({ toolCount: expect.anything() })]);
  });

  test('a parameter listing counts the tools, shortens server text, and lists only real workspace actions', async () => {
    const result = await mcpServerSummary(mcpContext(), { includeParameters: true }, options());
    const server = (result.servers as Record<string, unknown>[])[0]!;
    expect(server.toolCount).toBe(2);
    const description = String((server.tools as { description: string }[])[0]!.description);
    expect(description.length).toBeLessThanOrEqual(240);
    const ids = (server.modelAccess as { workspaceActionIds: string[] }).workspaceActionIds;
    const known = new Set(AGENT_WORKSPACE_CATEGORIES.flatMap(category => category.actions.map(action => action.id)));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(known.has(id), id).toBe(true);
  });
});

describe('wake word posture', () => {
  test('a refusing row is reported with its written reason, and the next step claims no model download', async () => {
    const fixture = makeFixture();
    try {
      fixture.configManager.setDynamic('voice.wake.enabled', true);
      fixture.configManager.setDynamic('voice.wake.surfaces.agent', true);
      fixture.configManager.setDynamic('voice.wake.vadThreshold', 0.5);
      const posture = await executeHarnessJson<{ readonly voiceWorkflows: readonly { readonly evidence: { readonly blockedRowDetails: readonly { key: string; detail: string }[] }; readonly nextStep: string }[] }>(
        fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
      const wake = posture.voiceWorkflows[0]!;
      expect(wake.evidence.blockedRowDetails[0]).toMatchObject({ key: 'voice.wake.vadThreshold' });
      expect(wake.evidence.blockedRowDetails[0]!.detail.length).toBeGreaterThan(0);
      expect(wake.nextStep).toContain('blockedRowDetails');

      fixture.configManager.setDynamic('voice.wake.vadThreshold', 0);
      fixture.configManager.setDynamic('voice.wake.enabled', false);
      fixture.configManager.setDynamic('voice.wake.surfaces.agent', false);
      const off = await executeHarnessJson<{ readonly voiceWorkflows: readonly { readonly nextStep: string }[] }>(
        fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
      expect(off.voiceWorkflows[0]!.nextStep).toContain('Ask the user');
      expect(off.voiceWorkflows[0]!.nextStep).toContain('does not fetch models');
      expect(off.voiceWorkflows[0]!.nextStep).not.toContain('are fetched and verified');
    } finally { await fixture.cleanup(); }
  });
});

describe('memory posture inputs', () => {
  test('an out-of-range timestamp is dropped instead of throwing', () => {
    expect(readTimestamp(1e20)).toBeNull();
    expect(readTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(readTimestamp('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
  });

  test('usage counters of memories that no longer exist are not counted or sampled', () => {
    const root = makeProjectTempDir('memory-usage-live');
    const path = join(root, 'learning', 'memory-usage.json');
    mkdirSync(dirname(path), { recursive: true });
    const store = new MemoryUsageStatsStore(path);
    store.recordInjected(['mem-live', 'mem-deleted']);
    store.recordInjected(['mem-live', 'mem-deleted']);
    store.recordReferenced(['mem-live']);
    const summary = liveUsageSummary(store, new Set(['mem-live']), 'note');
    expect(summary.totalTracked).toBe(1);
    expect(summary.everInjected).toBe(1);
    expect(summary.neverReferenced).toBe(0);
    expect(summary.neverReferencedSample.map(entry => entry.id)).toEqual([]);
    expect(summary.mostReferenced.map(entry => entry.id)).toEqual(['mem-live']);
  });
});

describe('local registry workspace actions', () => {
  function registryTool(fixture: ReturnType<typeof makeFixture>): { readonly calls: Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const tool: Tool = {
      definition: { name: 'agent_local_registry', description: 'Records local registry writes for the test.', parameters: { type: 'object', properties: {}, additionalProperties: true } },
      execute: async (args) => {
        calls.push(args);
        AgentPersonaRegistry.fromShellPaths(fixture.paths).create({ name: String(args.name), description: String(args.description ?? ''), body: String(args.body ?? ''), source: 'agent', provenance: String(args.provenance) });
        return { success: true, output: 'created' };
      },
    };
    fixture.toolRegistry.register(tool);
    return { calls };
  }

  test('promoting the same note twice creates one record and says why the second did nothing', async () => {
    const fixture = makeFixture();
    try {
      const { calls } = registryTool(fixture);
      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).create({ title: 'Reviewer style', body: 'Be concise.', tags: [] });
      const args = { mode: 'run_workspace_action', actionId: 'notes-to-persona', recordId: note.id,
        fields: { name: 'Reviewer', description: 'Concise reviewer', body: 'Be concise.' }, explicitUserRequest: 'Promote this note.' };
      const first = await executeHarnessJson<{ readonly status: string }>(fixture, args);
      expect(first.status).toBe('executed_model_tool');
      const second = await executeHarnessJson<{ readonly status: string; readonly existing: { readonly domain: string } }>(fixture, args);
      expect(second.status).toBe('already_promoted');
      expect(second.existing.domain).toBe('persona');
      expect(calls).toHaveLength(1);
      expect(AgentPersonaRegistry.fromShellPaths(fixture.paths).list()).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test('an unknown note id is refused with a reason instead of a generic hand-off', async () => {
    const fixture = makeFixture();
    try {
      registryTool(fixture);
      const missing = await executeHarnessJson<{ readonly status: string; readonly reason: string }>(fixture,
        { mode: 'run_workspace_action', actionId: 'notes-to-memory', recordId: 'note-missing' });
      expect(missing.status).toBe('record_not_found');
    } finally { await fixture.cleanup(); }
  });
});

describe('memory posture stability', () => {
  test('a memory crossing its validity end during the read does not hold the whole posture', async () => {
    const fixture = makeFixture();
    try {
      const now = Date.now();
      setSystemTime(new Date(now));
      const record = { id: 'mem-expiring', scope: 'project', cls: 'fact', summary: 'Expires soon', detail: 'detail', tags: [], reviewState: 'reviewed',
        confidence: 90, provenance: [], createdAt: now - 1000, updatedAt: now - 1000, validUntil: now + 5000 };
      (fixture.context as unknown as { clients: { agentKnowledgeApi: unknown } }).clients.agentKnowledgeApi = { memory: { getAll: () => [record] } };
      let advanced = false, checks = 0;
      // The clock moves past validUntil once the read is under way and re-checking its source.
      const result = await memoryPostureSummary(fixture.context, {}, { sourceOwner: ordinaryResearchOwner(),
        assertCurrent: () => { if (++checks === 3 && !advanced) { advanced = true; setSystemTime(new Date(now + 10_000)); } } });
      expect(advanced).toBe(true);
      expect((result.localMemory as { total: number }).total).toBe(1);
    } finally { await fixture.cleanup(); }
  });
});

describe('curator prompt-recall eligibility', () => {
  const memory = (over: Record<string, unknown>) => ({ id: 'm', name: 'm', description: '', reviewState: 'fresh', source: 'Agent memory', tags: [], triggers: [], confidence: 65, temporalStatus: 'active', ...over });

  test('follows the platform floor, stale exclusion and validity window', () => {
    expect(isMemoryPromptEligible(memory({}) as never)).toBe(true);
    expect(isMemoryPromptEligible(memory({ confidence: 59 }) as never)).toBe(false);
    expect(isMemoryPromptEligible(memory({ reviewState: 'stale', confidence: 80 }) as never)).toBe(false);
    expect(isMemoryPromptEligible(memory({ temporalStatus: 'expired', confidence: 80 }) as never)).toBe(false);
  });
});

describe('failing status sources', () => {
  test('a voice registry that throws is reported, not shown as an empty list', async () => {
    const fixture = makeFixture();
    try {
      const registry = fixture.context.platform.voiceProviderRegistry as unknown as { status: () => Promise<never> };
      registry.status = async () => { throw new Error('status backend down'); };
      const posture = await executeHarnessJson<{ readonly readErrors?: readonly string[] }>(fixture, { mode: 'media_posture' });
      expect(posture.readErrors).toEqual(['voice provider status could not be read']);
    } finally { await fixture.cleanup(); }
  });
});
