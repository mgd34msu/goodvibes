/**
 * agent-graph.ts, the four objects that make up a conversation loop's agent
 * graph, wired in the one order that works.
 *
 * The ordering is not cosmetic. `AgentOrchestrator` predates `AgentManager`, so
 * two of their links (the conversation-snapshot sink and the cooperative
 * cancellation source) cannot be constructor deps, they are set afterwards, on
 * the orchestrator, pointing back at the manager. Miss either and a spawned
 * agent's transcript never reaches a panel, or a cancel never reaches the run.
 * Every graph that runs agents calls this: the daemon-grade
 * `createRuntimeServices`, the pure-client `createClientRuntimeServices`, and
 * the execution graph with a contract runner (agent-graph-composition.ts), so
 * the order exists in exactly one place.
 *
 * Nothing here is daemon-grade: a surface running its own loop owns this graph
 * outright, which is why it sits below the daemon furniture in the dependency
 * order and imports none of it.
 */

import { join } from 'node:path';
import { resolveProcessCapturedBunRuntimeExecutable } from './captured-bun-runtime.js';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import { AgentOrchestrator } from '../agents/orchestrator.js';
import { archetypeLoaderFor, type ArchetypeLoader } from '../agents/archetypes.js';
import { AgentManager } from '../tools/agent/index.js';
import type { RuntimeEventBus } from './events/index.js';

export interface AgentGraphOptions {
  /** Absolute ordinary-Bun declaration; defaults to this build's runtime. */
  readonly capturedBunRuntimeExecutable?: string | undefined;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  /** Project root; the per-project archetype directory hangs off it. */
  readonly workingDirectory: string;
  /** Runs owned outside this manager (a daemon's other fleets) that count against the same capacity. */
  readonly additionalFleetOwnership?: (() => ReturnType<AgentManager['fleetOwnership']>) | undefined;
}

/** The agent graph a conversation loop runs on. */
export interface AgentGraph {
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly agentManager: AgentManager;
}

export function createAgentGraph(options: AgentGraphOptions): AgentGraph {
  const agentMessageBus = new AgentMessageBus(); agentMessageBus.setRuntimeBus(options.runtimeBus);
  // The process's one loader for this directory, shared with /teamwork: one scan, one freshness rule.
  const archetypeLoader = archetypeLoaderFor(join(options.workingDirectory, '.goodvibes', 'agents'));
  const agentOrchestrator = new AgentOrchestrator({ messageBus: agentMessageBus,
    capturedBunRuntimeExecutable: options.capturedBunRuntimeExecutable ?? resolveProcessCapturedBunRuntimeExecutable() });
  agentOrchestrator.setRuntimeBus(options.runtimeBus);
  const agentManager = new AgentManager({
    archetypeLoader,
    messageBus: agentMessageBus,
    executor: agentOrchestrator,
    configManager: options.configManager,
    // The live registry lets a bare model id in a spawn() override resolve
    // through the shared resolver instead of being rejected as unqualified.
    providerRegistry: options.providerRegistry,
    additionalFleetOwnership: options.additionalFleetOwnership,
  });
  // Conversation-snapshot sink bridge: AgentOrchestrator predates AgentManager, so it's
  // wired via setConversationSink, not a constructor dep (same ordering constraint as setRuntimeBus above).
  agentOrchestrator.setConversationSink({
    register: (agentId, source) => agentManager.registerConversationSource(agentId, source),
    release: (agentId) => agentManager.releaseConversationSource(agentId),
  });
  // Cooperative cancellation bridge: same ordering constraint/setter pattern as setConversationSink above.
  agentOrchestrator.setCancellationSource({
    get: (agentId) => agentManager.getCancellationSignal(agentId),
  });
  agentManager.setRuntimeBus(options.runtimeBus);
  return { archetypeLoader, agentMessageBus, agentOrchestrator, agentManager };
}
