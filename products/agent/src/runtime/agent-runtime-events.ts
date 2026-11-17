import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ContractRunner } from '@goodvibes-jev/engine/platform/platform/contract';
import { registerHostRuntimeEvents, type HostRuntimeMessageRouter } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import type { ConversationFollowUpItem } from '@goodvibes-jev/engine/platform/platform/core';
import type { AgentManager, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { createDomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/state';

export type AgentRuntimeMessageRouter = HostRuntimeMessageRouter;

export interface AgentRuntimeEventBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly domainDispatch: ReturnType<typeof createDomainDispatch>;
  readonly getSystemMessageRouter: () => AgentRuntimeMessageRouter | null;
  readonly queueConversationFollowUp?: (item: ConversationFollowUpItem) => void;
  readonly requestRender: () => void;
  /** Not read by the bridge; accepted from existing callers. */
  readonly configManager?: ConfigManager;
  readonly agentManager: AgentManager;
  readonly contractRunner: Pick<ContractRunner, 'get' | 'list'>;
  readonly toolRegistry: Pick<ToolRegistry, 'execute'>;
}

/**
 * The Agent app's runtime event bridge: the platform bridge both terminal apps
 * share (registerHostRuntimeEvents), with the Agent's `[Delegated task]`
 * wording, compaction receipts as lines, and failed-agent lines that carry the
 * `agent` tool's structured failure.
 */
export function registerAgentRuntimeEvents(options: AgentRuntimeEventBridgeOptions): ReturnType<typeof registerHostRuntimeEvents> {
  return registerHostRuntimeEvents({
    runtimeBus: options.runtimeBus,
    domainDispatch: options.domainDispatch,
    getSystemMessageRouter: options.getSystemMessageRouter,
    queueConversationFollowUp: options.queueConversationFollowUp,
    requestRender: options.requestRender,
    agentManager: options.agentManager,
    contractRunner: options.contractRunner,
    toolRegistry: options.toolRegistry,
    agentLineVoice: 'delegated-task',
    compactionReceiptLines: true,
  });
}
