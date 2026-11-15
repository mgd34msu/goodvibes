/**
 * The Agent product's `route` plan and catalog search, on the tool registry
 * the Agent registers at start-up (runtime/bootstrap-agent-tools.ts), composed
 * the way products/agent/src/test/tools/agent-harness-catalog-bootstrap.test.ts
 * composes it. Product modules are imported by computed path so the engine's
 * typecheck does not pull the Agent sources into its program.
 */
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../../../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../../../platform/src/platform/runtime/events/index.ts';
import { ToolRegistry } from '../../../platform/src/platform/tools/registry.ts';
import { countingPort, readingsPort } from '../fakes.ts';
import type { Instance, MeasureEnv, Scenario } from '../harness.ts';

const AGENT = resolve(import.meta.dir, '../../../../../products/agent/src');
const A = 'products/agent/src';
const load = <T>(path: string): Promise<T> => import(join(AGENT, path)) as Promise<T>;

interface AgentServices {
  readonly shellPaths: unknown;
  readonly providerRegistry: unknown;
  readonly judgment: { port: JudgmentPort; readonly decisionLog?: Parameters<typeof withDecisionLog>[1] };
  close(): Promise<void>;
}
interface ExecuteResult { readonly success: boolean; readonly output?: string; readonly error?: string }

const ROUTE_QUERY = 'fix the failing tests in parallel';
const CATALOG_QUERY = 'search my inbox for the invoice from last week';

interface AgentFloor {
  readonly registry: ToolRegistry;
  readonly toolCount: number;
  close(): Promise<void>;
}

async function openAgent(env: MeasureEnv): Promise<AgentFloor> {
  const { createPreparedAgentRuntimeServices } = await load<{ createPreparedAgentRuntimeServices(options: Record<string, unknown>): Promise<AgentServices> }>('test/helpers/prepared-runtime-services.ts');
  const { researchScreeningFixture, cleanupResearchScreeningFixtures } = await load<{ researchScreeningFixture(options?: Record<string, unknown>): { owner: unknown }; cleanupResearchScreeningFixtures(): Promise<void> }>('test/helpers/research-screening.ts');
  const { taskRoutePort } = await load<{ taskRoutePort(fixtures: Record<string, unknown>): { port: JudgmentPort } }>('test/helpers/task-route-readings.ts');
  const { bindAgentResearchSourceOwner } = await load<{ bindAgentResearchSourceOwner(registry: ToolRegistry, owner: unknown): void }>('agent/protected-research-report.ts');
  const { CommandRegistry } = await load<{ CommandRegistry: new () => unknown }>('input/command-registry.ts');
  const { registerAgentTools } = await load<{ registerAgentTools(deps: Record<string, unknown>): void }>('runtime/bootstrap-agent-tools.ts');
  const { createRuntimeStore } = await load<{ createRuntimeStore(): unknown }>('runtime/store/index.ts');

  const root = env.workspace;
  mkdirSync(join(root, '.goodvibes', 'agent'), { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: env.home });
  const services = await createPreparedAgentRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), workingDir: root, homeDirectory: env.home, modelDiscovery: 'skip' });
  // The protected research-source owner talks to an in-process loopback fake of
  // the screening service (test helper); its requests are counted as fixtureRequests.
  const screening = researchScreeningFixture({ recordCalls: false });
  const registry = new ToolRegistry();
  bindAgentResearchSourceOwner(registry, screening.owner);
  const context = {
    workspace: { shellPaths: services.shellPaths },
    provider: { providerRegistry: services.providerRegistry },
    platform: { config: configManager.getAll(), configManager },
    session: { runtime: { sessionId: 'measure-agent' } },
    extensions: { toolRegistry: registry }, ops: {},
  };
  registerAgentTools({ toolRegistry: registry, commandRegistry: new CommandRegistry(), commandContext: context, configManager, services, getSessionId: () => 'measure-agent' });

  // Route readings for the measured query; every other decision (catalog fit per
  // tool, screening, gate) from the shared fixtures.
  const route = taskRoutePort({ [ROUTE_QUERY]: { pick: 'build-work', slots: { delegated: 0.95 } } }).port;
  const shared = readingsPort();
  const catalog = fakePort((_name, question, state) => {
    const candidate = (state as { candidate?: { name?: string } }).candidate?.name ?? '';
    return question.type === 'noul' ? noulAnswer(/inbox|email|mail|search/.test(candidate) ? 0.9 : 0.02) : noulAnswer(0.02);
  });
  const answering: JudgmentPort = {
    model: shared.model,
    async ask(request) {
      if (request.context?.site === 'agent.harness.tools') return catalog.port.ask(request);
      const state = request.state as { context?: { request?: string }; request?: string; query?: string } | undefined;
      const text = state?.context?.request ?? state?.request ?? state?.query;
      if (text === ROUTE_QUERY) return route.ask(request);
      return shared.ask(request as JudgmentRequest<Questions>) as never;
    },
  };
  const counted = countingPort(answering);
  const port = services.judgment.decisionLog ? withDecisionLog(counted, services.judgment.decisionLog) : counted;
  // As the bootstrap test does: the composed port's ask is replaced, and the
  // process port points at the same object.
  services.judgment.port.ask = port.ask.bind(port);
  installJudgmentPort(services.judgment.port);
  return {
    registry,
    toolCount: registry.list().length,
    async close() { await services.close(); await cleanupResearchScreeningFixtures(); },
  };
}

function agentScenario(name: string, drives: string, entries: string[], args: Record<string, unknown>): Scenario {
  return {
    name, drives, entries, runs: 3,
    testOnly: 'the protected research-source owner points at the test helper\'s in-process loopback screening service (products/agent/src/test/helpers/research-screening.ts)',
    async setup(env): Promise<Instance> {
      const agent = await openAgent(env);
      return {
        async op() {
          const result = await agent.registry.execute('measure-agent', String(args['tool']), args['input'] as Record<string, unknown>) as ExecuteResult;
          return { succeeded: result.success ? 1 : 0, registeredTools: agent.toolCount, outputChars: (result.output ?? result.error ?? '').length };
        },
        dispose: () => agent.close(),
      };
    },
  };
}

export const scenarios: Scenario[] = [
  agentScenario('agent-route-plan', `ToolRegistry.execute('route', { action: 'plan', query: '${ROUTE_QUERY}' }) on the Agent's full start-up registry.`,
    [`${A}/tools/agent-route-tool.ts:73 createAgentRouteTool (registered at :121)`, `${A}/tools/agent-route-planner.ts planAgentTaskRoute`, `${A}/runtime/bootstrap-agent-tools.ts:68 registerAgentTools`],
    { tool: 'route', input: { action: 'plan', query: ROUTE_QUERY } }),
  agentScenario('agent-catalog-search', `ToolRegistry.execute('agent_harness', { mode: 'tools', query: '${CATALOG_QUERY}' }) (the catalog search) on the Agent's full start-up registry.`,
    [`${A}/tools/agent-harness-tool.ts:162 createAgentHarnessTool (mode tools -> searchHarnessModelTools)`, `${A}/runtime/bootstrap-agent-tools.ts:68 registerAgentTools`],
    { tool: 'agent_harness', input: { mode: 'tools', query: CATALOG_QUERY } }),
];
