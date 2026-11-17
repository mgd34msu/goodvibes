/**
 * A daemon-hosted Agent session (`originSurface: 'agent'`): the hosted session
 * runtime with the Agent's surface turn (terminal-shell agent-turn
 * createAgentHostedTurn), composed with the deps the daemon gives it
 * (products/daemon/src/runtime/hosted-session-composition.ts), over the real
 * client floor. One operator message, one model request: what that request
 * carries, above all its tool definitions (core tools in full, every other
 * tool as one line).
 */
import { join } from 'node:path';
import { createHostedSessionRuntime, type HostedSessionRuntime } from '../../../platform/src/platform/hosted-sessions/session-runtime.ts';
import { MemoryStore } from '../../../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../../../platform/src/platform/state/memory-registry.ts';
import { MemoryEmbeddingProviderRegistry } from '../../../platform/src/platform/state/memory-embeddings.ts';
import { createLocalMemoryAccess } from '../../../platform/src/platform/runtime/memory-spine/client.ts';
import { WebhookNotifier } from '../../../platform/src/platform/integrations/webhooks.ts';
import { MediaProviderRegistry } from '../../../platform/src/platform/media/provider-registry.ts';
import { ChannelDeliveryRouter } from '../../../platform/src/platform/channels/delivery-router.ts';
import { REGULAR_KNOWLEDGE_DB_FILE } from '../../../platform/src/platform/knowledge/store-config.ts';
import { createConfiguredPlanningStore, prepareConfiguredProjectContext } from '../../../platform/src/platform/knowledge/project-planning/configured-project.ts';
import { ProjectPlanningService } from '../../../platform/src/platform/knowledge/project-planning/service.ts';
import { ProjectWorkPlan } from '../../../platform/src/platform/knowledge/project-planning/work-plan.ts';
import { createAgentHostedTurn } from '../../../terminal-shell/src/agent-turn/hosted-turn.ts';
import { createFloor, seedWorkspace, type Floor } from '../compose.ts';
import { providerCounts, textAnswer } from '../fakes.ts';
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';
import { traceNote } from '../instrument.ts';

const P = 'packages/engine/platform/src/platform';
const ANSWER = 'Nothing needs doing.';

const hostedAgentRequest: Scenario = {
  name: 'hosted-agent-request',
  runs: 3,
  drives: 'HostedSessionRuntime.submit of one operator message to a session hosted for the Agent (originSurface agent, the Agent surface turn with the daemon\'s deps); the fake model answers at once. Reports the tool definitions the one request carried (count and JSON bytes).',
  entries: [
    `${P}/hosted-sessions/session-runtime.ts:503 HostedSessionRuntime.submit`,
    'packages/engine/terminal-shell/src/agent-turn/hosted-turn.ts:289 createAgentHostedTurn',
    `${P}/tools/registry.ts ToolRegistry.getModelToolDefinitions (core in full, others one line)`,
    'products/daemon/src/runtime/hosted-session-composition.ts:224 (product composition)',
  ],
  async setup(env: MeasureEnv): Promise<Instance> {
    seedWorkspace(env.workspace);
    const floor: Floor = await createFloor(env);
    const { configManager, services } = floor;
    const memoryStore = new MemoryStore(join(env.home, '.goodvibes', 'daemon', 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await memoryStore.init();
    const memoryRegistry = new MemoryRegistry(memoryStore);
    await prepareConfiguredProjectContext(configManager, env.workspace, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });
    const knowledgeStore = createConfiguredPlanningStore(configManager, REGULAR_KNOWLEDGE_DB_FILE, { family: 'wiki' });
    await knowledgeStore.init();
    const planning = ProjectPlanningService.forConfiguredWorkspace(knowledgeStore, configManager, env.workspace);
    const workPlan = new ProjectWorkPlan({ service: planning.service, projectId: planning.projectId, projectRoot: env.workspace, surface: 'daemon' });
    const webhookNotifier = new WebhookNotifier([]);
    const surfaceTurn = createAgentHostedTurn({
      homeDirectory: env.home, memoryRegistry, memoryAccess: createLocalMemoryAccess(memoryRegistry),
      artifactStore: services.artifactStore, notificationConfig: configManager, webhookNotifier,
      mediaProviders: new MediaProviderRegistry(), channelDeliveryRouter: new ChannelDeliveryRouter({ configManager, serviceRegistry: services.serviceRegistry, artifactStore: services.artifactStore, secretsManager: services.secretsManager }), workPlan,
      settings: configManager, configManager, secretsManager: services.secretsManager,
    });
    const session: HostedSessionRuntime = createHostedSessionRuntime({
      sessionId: 'measure-agent-session', workspaceRoot: env.workspace,
      floor: { services, contractRunner: services.contractRunner, dispose: () => {} },
      systemPrompt: 'You are the GoodVibes daemon hosting this session.', execPosture: 'workstream',
      originSurface: 'agent', surfaceTurn,
    });
    let before = 0;
    return {
      prepare() {
        floor.script.length = 0;
        floor.script.push(textAnswer(ANSWER));
        before = session.conversation.getMessageSnapshot().length;
      },
      async op(run) {
        await session.submit(`measured message ${run}`, undefined, { operatorInput: true });
        const messages = session.conversation.getMessageSnapshot().slice(before);
        const final = messages.at(-1);
        assertOutcome(final?.role === 'assistant' && String(final.content).includes(ANSWER), `the turn did not end with the model's answer (last message: ${final?.role ?? 'none'})`);
        assertOutcome(providerCounts.requests === 1, `${providerCounts.requests} model requests for one message`);
        assertOutcome(providerCounts.tools > 0, 'the request carried no tool definitions');
        // MEASURE_TRACE=tools lists each definition sent, with its size.
        for (const tool of providerCounts.lastTools) traceNote('tools', `${tool.name} ${tool.bytes} bytes${tool.parameters ? ', with parameters' : ''}`);
        return {
          toolDefinitionsSent: providerCounts.tools, toolDefinitionBytesSent: providerCounts.toolBytes,
          toolDefinitionsWithParameters: providerCounts.lastTools.filter((tool) => tool.parameters).length,
        };
      },
      async dispose() {
        session.dispose();
        webhookNotifier.close();
        planning.service.dispose();
        await knowledgeStore.close();
        memoryStore.close();
        await floor.dispose();
      },
    };
  },
};

export const scenarios: Scenario[] = [hostedAgentRequest];
