/**
 * companion-chat-turn-execution.ts
 *
 * executeCompanionToolCalls: the companion chat's binding of the one tool-batch
 * executor. It runs model-emitted tool calls through the permission boundary
 * and publishes per-call results, degrading honestly when a registry is
 * present without a permission manager. The turn itself is core/turn-loop.ts.
 */

import type { CompanionChatTurnEvent } from './companion-chat-types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import type { ConfigManager } from '../config/manager.js';
import type { AutonomousToolSource } from '../permissions/autonomous.js';
import { executeToolCalls as executeOrchestratorToolCalls, toolBudgetFromConfig } from '../core/orchestrator-tool-runtime.js';
import { maxParallelToolCalls } from '../core/tool-batch.js';

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

export interface CompanionToolExecutionDeps {
  readonly toolRegistry: ToolRegistry | null;
  readonly permissionManager: PermissionManager | null;
  readonly hookDispatcher: HookDispatcherLike | null;
  readonly runtimeBus: RuntimeEventBus | null;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  /** The request the calls serve (the person's message): the goal autonomous admission judges each call against. */
  readonly autonomousSource?: (() => AutonomousToolSource) | undefined;
}

/**
 * Execute model-emitted tool calls through the permission boundary and publish
 * each result. Returns [] when no registry is configured; denies every call
 * honestly (isError result + published event) when a registry exists without a
 * permission manager.
 */
export async function executeCompanionToolCalls(
  deps: CompanionToolExecutionDeps,
  toolCalls: ToolCall[],
  publish: (event: CompanionChatTurnEvent) => void,
  sessionId: string,
  turnId: string,
  /** The turn's cancellation, which reaches every call, and the receipts as they land. */
  options: { readonly signal?: AbortSignal | undefined; readonly onSettled?: ((result: ToolResult) => void) | undefined } = {},
): Promise<ToolResult[]> {
  const toolRegistry = deps.toolRegistry;
  if (!toolRegistry) return [];

  if (!deps.permissionManager) {
    return toolCalls.map((call) => {
      const toolResult: ToolResult = {
        callId: call.id,
        success: false,
        error: 'Tool execution denied: permission manager unavailable for companion chat',
      };
      publish({
        type: 'turn.tool_result',
        sessionId,
        turnId,
        toolCallId: call.id,
        toolName: call.name,
        result: toolResult.error,
        isError: true,
      });
      return toolResult;
    });
  }

  let results: ToolResult[];
  const settled = new Map<string, ToolResult>();
  try {
    results = await executeOrchestratorToolCalls({
      toolRegistry,
      permissionManager: deps.permissionManager,
      hookDispatcher: deps.hookDispatcher,
      runtimeBus: deps.runtimeBus,
      sessionId,
      autonomousSource: deps.autonomousSource,
      turnSignal: options.signal,
      onToolSettled: (result) => { settled.set(result.callId, result); options.onSettled?.(result); },
      toolBudget: () => toolBudgetFromConfig(deps.configManager),
      maxParallel: () => maxParallelToolCalls(deps.configManager),
      emitterContext: (id) => ({
        sessionId,
        traceId: `${sessionId}:${id}`,
        source: 'companion-chat',
      }),
    }, turnId, toolCalls);
  } catch (error) {
    // A cancelled turn is closed by the turn loop. Any other failure becomes one
    // error result per call that has none, so the model sees what happened and
    // the history keeps a result for every call it made.
    if (options.signal?.aborted) throw error;
    const reason = `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`;
    results = toolCalls.map((call) => settled.get(call.id) ?? { callId: call.id, success: false, error: reason });
  }

  for (const [index, toolResult] of results.entries()) {
    const call = toolCalls[index]!;
    if (!call) continue;
    publish({
      type: 'turn.tool_result',
      sessionId,
      turnId,
      toolCallId: call.id,
      toolName: call.name,
      result: toolResult.output ?? toolResult.error ?? null,
      isError: !toolResult.success,
    });
  }

  return results;
}
