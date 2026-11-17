/**
 * The Agent product's `route` plan and catalog search, on the tool registry
 * the Agent's start-up builds: composeAgentToolRegistry (the platform tools,
 * the tools every Agent turn has, the policy guard, definition compaction) as
 * runtime/bootstrap-core.ts calls it, then registerAgentTools as
 * runtime/bootstrap.ts does. Product modules are imported by computed path so
 * the engine's typecheck does not pull the Agent sources into its program.
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
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';

const AGENT = resolve(import.meta.dir, '../../../../../products/agent/src');
const A = 'products/agent/src';
const load = <T>(path: string): Promise<T> => import(join(AGENT, path)) as Promise<T>;

interface AgentServices {
  readonly shellPaths: unknown;
  readonly localReadSourceOwner: unknown;
  readonly researchReportSourceOwner: unknown;
  readonly providerRegistry: unknown;
  readonly judgment: { port: JudgmentPort; readonly decisionLog?: Parameters<typeof withDecisionLog>[1] };
  close(): Promise<void>;
}
interface ExecuteResult { readonly success: boolean; readonly output?: string; readonly error?: string }

const ROUTE_QUERY = 'fix the failing tests in parallel';
const CATALOG_QUERY = 'search my inbox for the invoice from last week';
/** The registered tool that reads the owner's mail. */
const INBOX_TOOL = 'personal_ops';

interface AgentFloor {
  readonly registry: ToolRegistry;
  readonly toolCount: number;
  close(): Promise<void>;
}

async function openAgent(env: MeasureEnv): Promise<AgentFloor> {
  const { createPreparedAgentRuntimeServices } = await load<{ createPreparedAgentRuntimeServices(options: Record<string, unknown>): Promise<AgentServices> }>('test/helpers/prepared-runtime-services.ts');
  const { taskRoutePort } = await load<{ taskRoutePort(fixtures: Record<string, unknown>): { port: JudgmentPort } }>('test/helpers/task-route-readings.ts');
  const { composeAgentToolRegistry } = await load<{ composeAgentToolRegistry(deps: Record<string, unknown>): { toolRegistry: ToolRegistry; dispose(): unknown } }>('runtime/agent-tool-registry.ts');
  const { CommandRegistry } = await load<{ CommandRegistry: new () => unknown }>('input/command-registry.ts');
  const { registerAgentTools } = await load<{ registerAgentTools(deps: Record<string, unknown>): void }>('runtime/bootstrap-agent-tools.ts');
  const { createRuntimeStore } = await load<{ createRuntimeStore(): unknown }>('runtime/store/index.ts');

  const root = env.workspace;
  mkdirSync(join(root, '.goodvibes', 'agent'), { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: env.home });
  // A decision model is set, as on a machine that uses one; its requests go to the counting port below.
  // With none set the composition runs every decision without one and the route plan is held unread.
  configManager.set('judgment.model', 'jev-latest', { daemonNotRunning: true });
  const services = await createPreparedAgentRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), workingDir: root, homeDirectory: env.home, modelDiscovery: 'skip' });
  // As runtime/bootstrap-core.ts composes the main conversation's registry.
  const composed = composeAgentToolRegistry({
    services, configManager, homeDirectory: env.home, resolveSessionId: () => 'measure-agent',
    researchReportSourceOwner: services.researchReportSourceOwner, researchSourceOwner: services.localReadSourceOwner,
  });
  const registry = composed.toolRegistry;
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
    async close() { await Promise.resolve(composed.dispose()); await services.close(); },
  };
}

/** Returns why the tool's output is not the expected answer, or undefined when it is. */
type OutputCheck = (output: Record<string, unknown>, registry: ToolRegistry) => string | undefined;

function agentScenario(name: string, drives: string, entries: string[], args: Record<string, unknown>, check: OutputCheck): Scenario {
  return {
    name, drives, entries, runs: 3,
    async setup(env): Promise<Instance> {
      const agent = await openAgent(env);
      return {
        async op() {
          const result = await agent.registry.execute('measure-agent', String(args['tool']), args['input'] as Record<string, unknown>) as ExecuteResult;
          assertOutcome(result.success, `${String(args['tool'])} failed: ${String(result.error ?? result.output ?? '').slice(0, 300)}`);
          let parsed: Record<string, unknown> | undefined;
          try { parsed = JSON.parse(result.output ?? '') as Record<string, unknown>; } catch { parsed = undefined; }
          assertOutcome(parsed !== undefined, `${String(args['tool'])} answered text that is not its JSON result: ${String(result.output).slice(0, 200)}`);
          const wrong = check(parsed, agent.registry);
          assertOutcome(wrong === undefined, `${String(args['tool'])} answered, but ${wrong}`);
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
    { tool: 'route', input: { action: 'plan', query: ROUTE_QUERY } },
    (output) => {
      const preferred = (output['preferred'] as { id?: unknown } | undefined)?.id;
      if (output['status'] !== 'ready') return `the plan's status is ${String(output['status'])}`;
      // The route readings pick build-work with the delegated slot for this query.
      return preferred === 'delegated-build-work' ? undefined : `the preferred route is ${String(preferred)}, not delegated-build-work`;
    }),
  agentScenario('agent-catalog-search', `ToolRegistry.execute('agent_harness', { mode: 'tools', query: '${CATALOG_QUERY}' }) (the catalog search) on the Agent's full start-up registry.`,
    [`${A}/tools/agent-harness-tool.ts:162 createAgentHarnessTool (mode tools -> searchHarnessModelTools)`, `${A}/runtime/bootstrap-agent-tools.ts:68 registerAgentTools`],
    { tool: 'agent_harness', input: { mode: 'tools', query: CATALOG_QUERY } },
    (output, registry) => {
      const names = Array.isArray(output['tools']) ? (output['tools'] as Array<{ name?: unknown }>).map((tool) => String(tool.name)) : [];
      if (names.length === 0) return 'it listed no tools';
      const unknown = names.filter((tool) => !registry.has(tool));
      if (unknown.length > 0) return `it listed tools that are not registered: ${unknown.join(', ')}`;
      // The tool that reads the owner's inbox must be among the matches for an inbox question.
      return names.includes(INBOX_TOOL) ? undefined : `${INBOX_TOOL} is not among the matches: ${names.join(', ')}`;
    }),
];
