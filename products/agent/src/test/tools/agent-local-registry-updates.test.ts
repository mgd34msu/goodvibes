import { memoryReadingsPort } from '../helpers/memory-readings.ts';
import { describe, expect, test } from 'bun:test';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { readActivation } from '../../tools/agent-local-registry-args.ts';
import { handleMemory } from '../../tools/agent-local-registry-memory.ts';
import type { MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { createAgentLocalRegistryTool, registerAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/platform/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ReturnType<typeof shellPaths>;

function shellPaths() {
  const root = makeProjectTempDir('goodvibes-agent-local-registry-tool');
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

async function createMemoryRegistry(paths: ShellPaths): Promise<MemoryRegistry> {
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return new MemoryRegistry(store);
}

function admittedLocalTool(paths: ShellPaths, memoryRegistry: MemoryRegistry) {
  let mode: PermissionMode = 'prompt', sequence = 0;
  let beforeExecution: (() => void) | undefined;
  const spine = createLocalMemoryAccess(memoryRegistry);
  const rawTool = createAgentLocalRegistryTool(paths, memoryRegistry, spine);
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), directory: paths.workingDirectory, autoApprove: false }),
    getSnapshot: () => ({ permissions: permissions() }), getWorkingDirectory: () => paths.workingDirectory, isAutoApproveEnabled: () => false,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  registerAgentLocalRegistryTool(registry, paths, memoryRegistry, spine);
  const tool: Tool = { ...rawTool, async execute(args, options) {
    const memory = memoryReadingsPort();
    const answers = fakePort((name, question) => question.type === 'noul' ? noulAnswer(0.001)
      : choiceAnswer(question, name === 'disposition' ? 'act' : name.replace(/^(effect|risk|edge)__/, '') === 'kind' ? 'read' : 'generic', 0.999));
    using log = new SqliteDecisionLog(':memory:');
    const port = withDecisionLog({ ...answers.port, ask: request => request.context?.battery?.includes('memory')
      ? memory.port.ask(request) : answers.port.ask(request) }, log);
    const previous = installJudgmentPort(port);
    try {
      const id = `local-registry-${++sequence}`;
      const call = await registry.prepareCall(id, rawTool.definition.name, args, { signal: options?.signal });
      const admission = await manager.admitAutonomous(id, rawTool.definition.name, call.args, {
        sourceOf: () => ({ goal: 'Exercise isolated Agent-local record behavior', criteria: ['Temporary local stores only'] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call }, signal: options?.signal,
      });
      expect(admission.result.approved).toBe(true);
      beforeExecution?.();
      return await registry.executePrepared(call, admission);
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { if (judgmentPort('local-registry-test') === port) installJudgmentPort(previous); }
  } };
  return { tool, rawTool, registry, setMode(next: PermissionMode) { mode = next; }, beforeExecution(callback: () => void) { beforeExecution = callback; } };
}

async function toolFixture() {
  const paths = shellPaths();
  const memoryRegistry = await createMemoryRegistry(paths);
  return {
    paths,
    memoryRegistry,
    ...admittedLocalTool(paths, memoryRegistry),
  };
}


describe('agent_local_registry updates and limits', () => {
  test('updating only the required environment of a skill keeps its required commands', async () => {
    const { paths, tool } = await toolFixture();
    const skill = AgentSkillRegistry.fromShellPaths(paths).create({ name: 'Deploy', description: 'Deploy it.', procedure: 'Run deploy.',
      requirements: [{ kind: 'command', name: 'kubectl' }, { kind: 'env', name: 'OLD_TOKEN' }], source: 'agent' });
    const result = await tool.execute({ domain: 'skill', action: 'update', id: skill.id, requiresEnv: ['NEW_TOKEN'] });
    expect(result.success, result.error).toBe(true);
    expect(AgentSkillRegistry.fromShellPaths(paths).get(skill.id)?.requirements).toEqual([
      { kind: 'env', name: 'NEW_TOKEN' }, { kind: 'command', name: 'kubectl' },
    ]);
  });

  test('enabled on a skill update is applied once the owner reviewed it, and refused before', async () => {
    const { paths, tool } = await toolFixture();
    const registry = AgentSkillRegistry.fromShellPaths(paths);
    const skill = registry.create({ name: 'Deploy', description: 'Deploy it.', procedure: 'Run deploy.', source: 'agent' });
    expect(skill.enabled).toBe(false);
    const refused = await tool.execute({ domain: 'skill', action: 'update', id: skill.id, enabled: true });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain(`/skills review ${skill.id}`);
    expect(AgentSkillRegistry.fromShellPaths(paths).get(skill.id)?.enabled).toBe(false);
    registry.markReviewed(skill.id);
    const result = await tool.execute({ domain: 'skill', action: 'update', id: skill.id, enabled: true });
    expect(result.success, result.error).toBe(true);
    expect(AgentSkillRegistry.fromShellPaths(paths).get(skill.id)?.enabled).toBe(true);
  });

  test('an update that carries nothing to change is a failure, not "Updated"', async () => {
    const { paths, tool } = await toolFixture();
    const skill = AgentSkillRegistry.fromShellPaths(paths).create({ name: 'Deploy', description: 'Deploy it.', procedure: 'Run deploy.', source: 'agent' });
    const result = await tool.execute({ domain: 'skill', action: 'update', id: skill.id, description: '  ' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('update changed nothing');
  });

  test('a memory update naming a confidence is refused with the action that does it', async () => {
    const { tool } = await toolFixture();
    const created = await tool.execute({ domain: 'memory', action: 'create', cls: 'fact', summary: 'Release day is Thursday.' });
    const id = /id (\S+)/.exec(created.output ?? '')?.[1];
    if (!id) throw new Error('The memory record id was not reported.');
    const result = await tool.execute({ domain: 'memory', action: 'update', id, confidence: 90 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('action:"review"');
  });

  test('memory search honours limit and says when a page was filled', async () => {
    const { tool } = await toolFixture();
    for (const word of ['one', 'two', 'three']) {
      const created = await tool.execute({ domain: 'memory', action: 'create', cls: 'fact', summary: `alpha ${word}` });
      expect(created.success, created.error).toBe(true);
    }
    const result = await tool.execute({ domain: 'memory', action: 'search', query: 'alpha', semantic: false, limit: 2 });
    expect(result.success, result.error).toBe(true);
    expect(result.output).toContain('Showing 2 rows (limit 2)');
    expect((result.output ?? '').split('\n').filter((line) => line.includes('alpha ')).length).toBe(2);
  });

  test('an empty activate value is not read as yes, and a word is never guessed at', () => {
    expect(readActivation('')).toBeUndefined();
    expect(readActivation(undefined)).toBeUndefined();
    expect(() => readActivation('yes')).toThrow('activate must be true or false');
    expect(readActivation('true')).toBe(true);
    expect(readActivation(false)).toBe(false);
  });

  test('a refused action names the actions the domain accepts', async () => {
    const { tool } = await toolFixture();
    const result = await tool.execute({ domain: 'note', action: 'enable', id: 'anything' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Valid actions for domain note: list, search, get, create, update, review, stale, delete');
  });

  test('a refused memory action names the actions memory accepts', async () => {
    const { tool } = await toolFixture();
    const result = await tool.execute({ domain: 'memory', action: 'enable', id: 'anything' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Valid actions for domain memory: list, search, get, create, update, review, stale, delete');
  });
});

describe('memory search index health', () => {
  test('the health check asks the same spine as the search, so a daemon index that is down is named', async () => {
    const searched: string[] = [];
    const spine = {
      vectorStats: async () => ({ enabled: true, available: false, error: 'daemon index offline', indexedRecords: 0 }),
      honestSearch: async () => { searched.push('literal'); return { records: [] }; },
      searchSemantic: async () => { searched.push('semantic'); return []; },
    } as unknown as MemoryAccess;
    const paths = shellPaths(), registry = await createMemoryRegistry(paths);
    const text = await handleMemory(registry, spine, 'search', { query: 'deploy' }, {});
    expect(text).toContain('literal fallback, the semantic memory index is unavailable: daemon index offline');
    expect(searched).toEqual(['literal']);
  });
});
