/**
 * hosted-turn.ts, the Agent's turn in a session the daemon hosts for it
 * (`originSurface: 'agent'`): the Agent's own prompt and the Agent tools that
 * need no terminal, given to the hosted-session engine as its surface turn.
 *
 * The prompt is composed per model request by the same function the Agent
 * process uses (prompt-context-receipts.ts): the host's base prompt with one
 * section saying what this turn cannot do, then the capability rules, VIBE,
 * project context, the Agent operator policy and capture contract, reviewed
 * memory ranked for the turn, routines, skills, the persona and the model-tier
 * supplement, read from the same `~/.goodvibes/agent` stores. Its receipt goes
 * to the same journal the Agent's receipt views read, under the journal's
 * cross-process lock.
 *
 * The tools are `registerAgentTurnTools`, the one list both places register.
 * Every other Agent tool runs only in the Agent's own process (most are views
 * over its command registry and terminal); this turn names them in its prompt
 * and a call to one is refused with the state, the reason and the next step.
 */
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { HostedSurfaceTurn } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { readTierPromptSupplement } from '@goodvibes-jev/engine/platform/platform/providers';
import { factsFor } from '@goodvibes-jev/engine/platform/platform/routing';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { joinPromptParts } from '../prompt-parts.js';
import { GOODVIBES_AGENT_OPERATOR_POLICY } from './operator-policy.js';
import { AgentPromptContextReceiptStore, composeRuntimePromptWithReceipt } from './prompt-context-receipts.js';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { createProfileGatewayInvoke } from './profile-gateway.js';
import { createOccasionsGatewayInvoke } from './occasions-gateway.js';
import { registerAgentProfileTool } from './profile-tool.js';
import { registerAgentOccasionsTool } from './occasions-tool.js';
import type { FamilyGatewayRemote } from './family-gateway.js';
import { registerAgentArtifactsTool } from './artifacts-tool.js';
import { registerAgentDocumentsTool } from './documents-tool.js';
import { registerAgentResearchRunsTool } from './research-runs-tool.js';
import { registerAgentResearchSourcesTool } from './research-sources-tool.js';
import { registerAgentReviewPacketPresetsTool } from './review-packet-presets-tool.js';
import type { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';

/** What the Agent turn tools are built from, in either process. */
export interface AgentTurnToolDeps {
  /** This process's gateway catalog; the daemon's carries the `profile.*` and `occasions.*` handlers. */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  /** The Agent process's connected-host route for those verbs; the daemon passes none. */
  readonly remote?: FamilyGatewayRemote | undefined;
  /** The owner's message for the current turn; a person lookup is refused unless it names the person. */
  readonly currentOwnerMessage?: (() => string | null | undefined) | undefined;
  /** The turn's workspace and home: the Agent's project and user stores are resolved against it. */
  readonly shellPaths: ShellPathService;
  /** The home's artifact store, which artifacts, documents and review packets are kept in. */
  readonly artifactStore: ArtifactStore;
}

/**
 * The Agent tools a turn has wherever it runs: the owner profile and occasions
 * (the two halves of the capture contract the operator policy carries),
 * artifacts, documents, research runs and sources, and review-packet presets.
 */
export function registerAgentTurnTools(registry: ToolRegistry, deps: AgentTurnToolDeps): void {
  const family = {
    ...(deps.gatewayMethods ? { gatewayMethods: deps.gatewayMethods } : {}),
    ...(deps.remote ? { remote: deps.remote } : {}),
  };
  registerAgentProfileTool(registry, {
    invoke: createProfileGatewayInvoke(family),
    ...(deps.currentOwnerMessage ? { currentOwnerMessage: deps.currentOwnerMessage } : {}),
  });
  registerAgentOccasionsTool(registry, { invoke: createOccasionsGatewayInvoke(family) });
  registerAgentArtifactsTool(registry, deps.artifactStore, { projectRoot: deps.shellPaths.workingDirectory });
  registerAgentDocumentsTool(registry, deps.shellPaths, deps.artifactStore);
  registerAgentResearchRunsTool(registry, deps.shellPaths);
  registerAgentResearchSourcesTool(registry, deps.shellPaths);
  registerAgentReviewPacketPresetsTool(registry, deps.artifactStore);
}

/**
 * The Agent's tools that run only in the Agent's own process: views over its
 * command registry and terminal, and the tools whose stores and connections
 * that process owns. A turn the daemon hosts names them and refuses a call to
 * one; a tool that moves into `registerAgentTurnTools` leaves this list.
 */
export const AGENT_PROCESS_TOOL_NAMES: readonly string[] = Object.freeze([
  // Views over the Agent's command registry and terminal.
  'agent_harness', 'audit', 'autonomy', 'capability_status', 'channels', 'computer', 'context', 'delegation', 'device',
  'execution', 'host', 'import_goodvibes_settings', 'memory', 'models', 'personal_ops', 'process', 'research', 'route',
  'security', 'sessions', 'settings', 'setup', 'support', 'terminal', 'vibe', 'workspace',
  // Tools over the Agent process's own stores and connections.
  'accounts', 'agent_autonomy_schedule', 'agent_channel_send', 'agent_knowledge', 'agent_knowledge_ingest',
  'agent_learning_consolidation', 'agent_local_registry', 'agent_media_generate', 'agent_model_compare', 'agent_notify',
  'agent_operator_action', 'agent_operator_briefing', 'agent_operator_method', 'agent_reminder_schedule',
  'agent_research_report', 'agent_review_packet_share', 'agent_schedule_edit', 'agent_work_plan', 'browser', 'google',
  'schedule',
]);

const HOSTED_REFUSAL = {
  reason: 'This GoodVibes Agent turn is hosted by the daemon, and this tool runs only in the GoodVibes Agent\'s own process.',
  next: 'Tell the owner which tool the request needs and that it runs when he continues in the GoodVibes Agent itself (with the setting hostedSessions.routeConversationTurns off, the Agent answers in its own process).',
};

/** The one section a hosted Agent turn's prompt adds: what it is and what it cannot do here. */
function hostedAgentSection(): string {
  return [
    '## This Agent turn is hosted by the daemon',
    'You are the GoodVibes Agent, answering in a session the daemon hosts rather than in the Agent\'s own process. Your policy, persona, skills, routines and memory below are the Agent\'s, and `profile`, `occasions`, `agent_artifacts`, `agent_documents`, `agent_research_runs`, `agent_research_sources` and `agent_review_packet_presets` are here, so recording what you learn works as the policy says.',
    `These Agent tools run only in the Agent's own process and are not here: ${AGENT_PROCESS_TOOL_NAMES.map((name) => `\`${name}\``).join(', ')}. Where the policy names one of them, say which tool the request needs, that this hosted turn cannot run it, and that it runs when the owner continues in the GoodVibes Agent itself. A call to one is refused.`,
  ].join('\n');
}

/** What the daemon builds the Agent's hosted turn from. */
export interface AgentHostedTurnDeps {
  /** The home whose `~/.goodvibes/agent` stores the turn reads (the daemon's own). */
  readonly homeDirectory: string;
  /** The home's one memory store. */
  readonly memoryRegistry: MemoryRegistry;
  /** The daemon's gateway catalog, which serves the `profile.*` and `occasions.*` verbs in-process. */
  readonly gatewayMethods: GatewayMethodCatalog;
  /** The home's artifact store. */
  readonly artifactStore: ArtifactStore;
}

export function createAgentHostedTurn(deps: AgentHostedTurnDeps): HostedSurfaceTurn {
  const receipts = new AgentPromptContextReceiptStore(
    createShellPathService({ workingDirectory: deps.homeDirectory, homeDirectory: deps.homeDirectory })
      .resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'prompt-context-receipts.jsonl'),
  );
  const section = hostedAgentSection();
  return {
    registerTools({ registry, workspaceRoot }) {
      registerAgentTurnTools(registry, {
        gatewayMethods: deps.gatewayMethods,
        shellPaths: createShellPathService({ workingDirectory: workspaceRoot, homeDirectory: deps.homeDirectory }),
        artifactStore: deps.artifactStore,
      });
      registry.declareElsewhere(AGENT_PROCESS_TOOL_NAMES, HOSTED_REFUSAL);
      return undefined;
    },
    async systemPrompt(input) {
      const signal = input.signal;
      signal?.throwIfAborted();
      const providerRegistry = input.providerRegistry;
      const model = providerRegistry.getCurrentModel();
      const tierPrompt = await readTierPromptSupplement(
        factsFor({ catalog: providerRegistry }, model),
        providerRegistry.modelTiers,
        'agent.conversation-system-prompt',
        { audience: 'conversation', signal },
      );
      signal?.throwIfAborted();
      const composed = await composeRuntimePromptWithReceipt({
        sessionId: input.sessionId,
        turnId: null,
        source: 'turn',
        provider: model.provider,
        model,
        contextWindow: providerRegistry.getKnownContextWindowForModel(model),
        tierPrompt,
        runtimePrompt: joinPromptParts(input.basePrompt, section),
        operatorPolicy: GOODVIBES_AGENT_OPERATOR_POLICY,
        shellPaths: createShellPathService({ workingDirectory: input.workspaceRoot, homeDirectory: deps.homeDirectory }),
        memoryRegistry: deps.memoryRegistry,
        capabilityIndex: null,
        turnText: input.turnText,
      });
      signal?.throwIfAborted();
      try {
        receipts.record(composed.receipt);
      } catch (error) {
        // The receipt describes the prompt; failing to keep it must not fail the turn.
        logger.warn('Hosted Agent prompt receipt was not recorded', { sessionId: input.sessionId, error: summarizeError(error) });
      }
      return composed.prompt;
    },
  };
}
