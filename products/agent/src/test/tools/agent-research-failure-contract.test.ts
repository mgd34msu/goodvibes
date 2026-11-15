import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { createAgentResearchReportProjector } from '../../agent/protected-research-report.ts';
import { createAgentResearchRunsTool } from '../../tools/agent-research-runs-tool.ts';
import { createAgentResearchReportTool } from '../../tools/agent-research-report-tool.ts';
import { createAgentResearchTool, registerAgentResearchTool } from '../../tools/agent-research-tool.ts';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { effectAdmissionFixture } from '../helpers/effect-admission.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function paths() { const root = mkdtempSync(join(tmpdir(), 'research-failure-contract-')); roots.push(root); return { resolveProjectPath: (...parts: string[]) => join(root, ...parts) }; }
const webSearch = (execute: Tool['execute']): Tool => ({ definition: { name: 'web_search', description: 'Synthetic search', parameters: { type: 'object', additionalProperties: true } }, execute });
const researchTool = (shell: ReturnType<typeof paths>, search: Tool) => {
  const admitted = effectAdmissionFixture();
  return admitted.tool(createAgentResearchTool({ toolRegistry: admitted.registry, commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: { shellPaths: shell }, platform: {} } as CommandContext, webSearchTool: search }));
};

describe('research action routing', () => {
  test('an unknown action names the valid actions and is not reported as a protected-input refusal', async () => {
    const tool = createAgentResearchTool({ commandRegistry: {} as CommandRegistry, commandContext: { workspace: {}, platform: {} } as CommandContext, toolRegistry: new ToolRegistry() });
    const result = await tool.execute({ action: 'list_sources' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown research action 'list_sources'");
    expect(result.error).toContain('checkpoint');
    expect(result.error).not.toContain('protected-input');
  });

  test('through the registry an unknown action reaches the valid-action message, not a projection failure', async () => {
    const registry = new ToolRegistry();
    registerAgentResearchTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);
    const result = await registry.execute('c1', 'research', { action: 'list_sources' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown research action 'list_sources'");
    expect(result.error).not.toContain('projection');
  });
});

describe('research run checkpoints', () => {
  test('a terminal status or an unknown phase is refused instead of reported as checkpointed', async () => {
    const shell = paths(); const admitted = effectAdmissionFixture();
    const tool = admitted.tool(createAgentResearchRunsTool(shell));
    const run = AgentResearchRunRegistry.fromShellPaths(shell).create({ title: 'Run', question: 'Question' });
    const terminal = await tool.execute({ mode: 'checkpoint', id: run.id, status: 'completed' });
    expect(terminal.success).toBe(false); expect(terminal.error).toContain('mode:"complete"');
    const phase = await tool.execute({ mode: 'checkpoint', id: run.id, phase: 'researching' });
    expect(phase.success).toBe(false); expect(phase.error).toContain('searching');
    expect(AgentResearchRunRegistry.fromShellPaths(shell).get(run.id)?.status).toBe('planned');
  });
});

describe('research runner failures', () => {
  test('a failure after the run was created names the run, the saved count and blocks the run', async () => {
    const shell = paths();
    const tool = researchTool(shell, webSearch(async () => { throw new Error('transport exploded'); }));
    const result = await tool.execute({ action: 'runner', query: 'what is new' });
    const run = AgentResearchRunRegistry.fromShellPaths(shell).list()[0]!;
    expect(result.success).toBe(false);
    expect(result.error).toContain(run.id); expect(result.error).toContain('transport exploded');
    expect(result.error).toContain('No sources were saved'); expect(result.error).toContain('Retry with runId');
    expect(AgentResearchRunRegistry.fromShellPaths(shell).get(run.id)?.status).toBe('blocked');
  });
  test('a result whose URL cannot be screened is counted as omitted and does not discard the others', async () => {
    const shell = paths();
    const tool = researchTool(shell, webSearch(async () => ({ success: true, output: JSON.stringify({ results: [
      { url: 'https://example.test/a?id=1', title: 'Needs an owner', snippet: 'one' },
      { url: 'https://example.test/b', title: 'Plain', snippet: 'two' },
      { title: 'No url', snippet: 'three' },
    ] }) })));
    const result = await tool.execute({ action: 'runner', query: 'what is new' });
    expect(result.success, result.error).toBe(true);
    const packet = JSON.parse(result.output as string) as { resultCount: number; sourceCandidateCount: number; omittedCount: number; omitted: Record<string, number>; savedSourceCount: number };
    expect(packet).toMatchObject({ resultCount: 3, sourceCandidateCount: 1, omittedCount: 2, savedSourceCount: 1, omitted: { withoutUrl: 1, withheldBeforeTransmission: 1 } });
  });
});

class Store implements Pick<ArtifactStore, 'create'> {
  readonly records: ArtifactRecord[] = [];
  async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
    const record: ArtifactRecord = { id: `artifact-${this.records.length + 1}`, kind: input.kind ?? 'document', mimeType: input.mimeType ?? 'text/plain', sizeBytes: 1, sha256: 'x',
      createdAt: Date.now(), acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: input.metadata ?? {}, contentPath: '/tmp/a', metadataPath: '/tmp/b' };
    this.records.push(record); return record;
  }
}
function reportTool(store: Store) {
  const owner = ordinaryResearchOwner(); const admitted = effectAdmissionFixture();
  return admitted.tool(createAgentResearchReportTool(store, owner), { inputProjection: createAgentResearchReportProjector(owner) });
}
const SOURCES = [{ title: 'Doc one', url: 'https://example.test/one', credibility: 'high' }, { title: 'Doc two', url: 'https://example.test/two', credibility: 'high' }];

describe('research report preview predicts the save', () => {
  test('a preview with no summary, report body or findings fails with the save message', async () => {
    const store = new Store();
    const result = await reportTool(store).execute({ title: 'T', question: 'Q', sources: SOURCES, preview: true });
    expect(result.success).toBe(false); expect(result.error).toContain('summary, reportMarkdown, or findings are required.'); expect(store.records).toHaveLength(0);
  });
  test('a preview fails on missing citations when coverage is required', async () => {
    const result = await reportTool(new Store()).execute({ title: 'T', question: 'Q', summary: 'Only [S1] cited.', sources: SOURCES, requireCitationCoverage: true, preview: true });
    expect(result.success).toBe(false); expect(result.error).toContain('Citation coverage check failed');
  });
  test('a clean preview reports coverage and saves nothing', async () => {
    const store = new Store();
    const result = await reportTool(store).execute({ title: 'T', question: 'Q', summary: 'Both [S1] and [S2].', sources: SOURCES, requireCitationCoverage: true, preview: true });
    expect(result.success, result.error).toBe(true); expect(result.output).toContain('citationCoverage 2/2'); expect(result.output).toContain('nothing saved'); expect(store.records).toHaveLength(0);
  });
  test('saving with a runId says the run stays open', async () => {
    const result = await reportTool(new Store()).execute({ runId: 'run-9', title: 'T', question: 'Q', summary: 'Both [S1] and [S2].', sources: SOURCES });
    expect(result.success, result.error).toBe(true); expect(result.output).toContain('run run-9 is still open');
  });
});
