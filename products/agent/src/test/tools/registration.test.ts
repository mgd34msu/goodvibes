import { getTestRuntimeServices } from '../helpers/runtime-services.ts';
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { registerAllTools } from '@goodvibes-jev/engine/platform/platform/tools';
import { createTestManagers } from '../helpers/test-managers.ts';
import { CrossSessionTaskRegistry } from '@goodvibes-jev/engine/platform/platform/sessions';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { AgentMessageBus } from '@goodvibes-jev/engine/platform/platform/agents';
import { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { OverflowHandler } from '@goodvibes-jev/engine/platform/platform/tools';
import { FileUndoManager } from '@goodvibes-jev/engine/platform/platform/state';
import { ModeManager } from '@goodvibes-jev/engine/platform/platform/state';
import { ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import { createWorkflowServices } from '@goodvibes-jev/engine/platform/platform/tools';
import { compactRegisteredToolDefinitions, CORE_TOOL_NAMES } from '../../tools/tool-definition-compaction.ts';
import { installAgentToolPolicyGuard } from '../../tools/agent-tool-policy-guard.ts';
import { installToolExecutionSafetyGuard } from '../../tools/tool-execution-safety.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { createPreparedAgentRuntimeServices } from '../helpers/prepared-runtime-services.ts';

interface RegisteredScene {
  readonly workingDirectory: string;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  /** Replaces the live session id the task tool reads on every call. */
  setSession(id: string): void;
}

async function registerTools(registry: ToolRegistry): Promise<RegisteredScene> {
  let sessionId = 'registration-session-1';
  const services = createTestManagers();
  const workingDirectory = makeProjectTempDir('gv-tool-registry');
  const agentManager = new AgentManager({
    messageBus: new AgentMessageBus(),
    configManager: services.configManager,
  });
  const sessionOrchestration = new CrossSessionTaskRegistry(
    join(workingDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'sessions', 'task-graph.json'),
  );
  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const agentMessageBus = new AgentMessageBus();
  registerAllTools(registry, {
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    resolveSessionId: () => sessionId,
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentManager,
    contractRunner: (await getTestRuntimeServices()).contractRunner,
    projectRoot: workingDirectory,
    agentMessageBus,
    configManager: services.configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    sessionOrchestration,
    sandboxSessionRegistry,
    workingDirectory,
    overflowHandler: new OverflowHandler({ baseDir: workingDirectory }),
    webSearchService: {
      search: async () => [],
    } as never,
    channelRegistry: null,
    remoteRunnerRegistry,
    workflowServices: createWorkflowServices(),
    mcpRegistry: {
      list: () => [],
    } as never,
  });
  return { workingDirectory, sessionOrchestration, setSession: (id) => { sessionId = id; } };
}

describe('registerAllTools', () => {

  test('compacted model-visible tool descriptions stay within the prompt budget', async () => {
    const registry = new ToolRegistry();
    await registerTools(registry);
    compactRegisteredToolDefinitions(registry);
    for (const tool of registry.list()) {
      expect(tool.definition.description.length).toBeLessThanOrEqual(CORE_TOOL_NAMES.has(tool.definition.name) ? 240 : 56);
      expect(tool.definition.description).not.toContain('...');
    }
  });

  test("the Agent's own composed catalog, platform and Agent tools together, stays within the same budget", async () => {
    const root = makeProjectTempDir('gv-agent-catalog');
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const configDir = join(homeDir, '.goodvibes', 'agent');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: workspace, timeout: 30_000 });
    const services = await createPreparedAgentRuntimeServices({
      modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
      configManager: new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir, configDir }),
      workingDir: workspace, homeDirectory: homeDir, getConversationTitle: () => 'agent-catalog-budget',
    });
    const { toolRegistry, dispose } = composeAgentToolRegistry({
      services, configManager: services.configManager, homeDirectory: homeDir,
      resolveSessionId: () => 'agent-catalog-budget', getLastUserMessage: () => null,
    });
    try {
      const names = toolRegistry.list().map((tool) => tool.definition.name);
      // Agent-only tools are present, so the budget below covers more than the platform catalog.
      expect(names).toContain('agent_local_registry');
      expect(names).toContain('goodvibes_settings');
      for (const tool of toolRegistry.list()) {
        const limit = CORE_TOOL_NAMES.has(tool.definition.name) ? 240 : 56;
        expect(tool.definition.description.length, tool.definition.name).toBeLessThanOrEqual(limit);
        expect(tool.definition.description, tool.definition.name).not.toContain('...');
      }
    } finally {
      await dispose();
    }
  });

  test('Agent-guarded platform tools all return structured results instead of throwing', async () => {
    const registry = new ToolRegistry();
    await registerTools(registry);
    installAgentToolPolicyGuard(registry);
    installToolExecutionSafetyGuard(registry);

    const smokeArgs: Record<string, Record<string, unknown>> = {
      agent: { mode: 'list' },
      analyze: { mode: 'impact', target: 'package.json' },
      channel: { mode: 'accounts' },
      control: { mode: 'commands' },
      edit: {},
      exec: { commands: [] },
      fetch: { urls: [] },
      find: { mode: 'files', query: 'package.json' },
      goodvibes_context: { mode: 'summary' },
      goodvibes_settings: { mode: 'set', key: 'provider.model', confirm: false },
      inspect: { mode: 'project' },
      mcp: { mode: 'servers' },
      packet: { mode: 'list' },
      query: { mode: 'list' },
      read: {},
      registry: { mode: 'list' },
      remote: { mode: 'pools' },
      repl: {},
      state: { mode: 'get' },
      task: { mode: 'list' },
      team: { mode: 'list' },
      web_search: { query: 'goodvibes', topN: 1 },
      workflow: { mode: 'list' },
      worklist: { mode: 'list' },
      write: {},
    };

    for (const tool of registry.list()) {
      const callId = `smoke-${tool.definition.name}`;
      const result = await registry.execute(callId, tool.definition.name, smokeArgs[tool.definition.name] ?? {});
      expect(result.callId, tool.definition.name).toBe(callId);
      expect(typeof result.success, tool.definition.name).toBe('boolean');
      // A result states its outcome: success carries output, failure carries the reason.
      if (result.success) expect(typeof result.output, tool.definition.name).toBe('string');
      else expect(result.error ?? '', tool.definition.name).not.toBe('');
    }
  });

  test('the registered task tool files refs under the live session id, and follows it when it changes', async () => {
    const registry = new ToolRegistry();
    const scene = await registerTools(registry);

    const first = await registry.execute('task-1', 'task', { mode: 'create', taskId: 't1', title: 'First' });
    expect(first.success).toBe(true);
    expect(scene.sessionOrchestration.getRef('registration-session-1', 't1')?.title).toBe('First');

    scene.setSession('registration-session-2');
    const second = await registry.execute('task-2', 'task', { mode: 'create', taskId: 't2', title: 'Second' });
    expect(second.success).toBe(true);
    expect(scene.sessionOrchestration.getRef('registration-session-2', 't2')?.title).toBe('Second');
    expect(scene.sessionOrchestration.getRef('registration-session-1', 't2')).toBeUndefined();
  });

  test('the registered team and worklist tools have a store under the Agent surface root', async () => {
    const registry = new ToolRegistry();
    const scene = await registerTools(registry);

    const team = await registry.execute('team-1', 'team', { mode: 'create', teamId: 'crew', name: 'Crew', summary: 'Ships it' });
    expect(team.success, team.error).toBe(true);
    const worklist = await registry.execute('worklist-1', 'worklist', { mode: 'create', worklistId: 'wl', title: 'Chores' });
    expect(worklist.success, worklist.error).toBe(true);

    const storeDirectory = join(scene.workingDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT);
    expect(JSON.parse(readFileSync(join(storeDirectory, 'teams.json'), 'utf8'))).toMatchObject({ teams: [{ id: 'crew' }] });
    expect(JSON.parse(readFileSync(join(storeDirectory, 'worklists.json'), 'utf8'))).toMatchObject({ worklists: [{ id: 'wl' }] });
    // Nothing is written under the TUI's root by the Agent's registry.
    expect(existsSync(join(scene.workingDirectory, '.goodvibes', 'tui'))).toBe(false);
  });

  test('post-edit diagnostics (platform 1.6.1 diagnostics.postEdit) reach the write tool result untouched', async () => {
    const registry = new ToolRegistry();
    const { workingDirectory } = await registerTools(registry);
    // Install the SAME guard layers production bootstrap installs
    // (installAgentToolPolicyGuard, installToolExecutionSafetyGuard),
    // neither wraps the write tool's execute function, but this proves that
    // rather than assumes it: diagnostics must still reach the result.
    installAgentToolPolicyGuard(registry);
    installToolExecutionSafetyGuard(registry);
    // hasTsProjectContext() walks up from the written file looking for
    // tsconfig.json/jsconfig.json, without one, the provider honestly
    // returns [] rather than fabricating "no errors".
    writeFileSync(join(workingDirectory, 'tsconfig.json'), '{}\n');

    const result = await registry.execute('write-diagnostics-smoke', 'write', {
      files: [{
        path: 'broken.ts',
        // Deliberately unbalanced, a real syntax error, not a type error.
        content: 'export function broken( {\n  return 1\n',
      }],
    });

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(result.output ?? '{}') as { diagnostics?: readonly { file: string; message: string }[] };
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
    expect(parsed.diagnostics!.length).toBeGreaterThan(0);
    expect(parsed.diagnostics![0]!.file).toContain('broken.ts');
  });
});
