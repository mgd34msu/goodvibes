import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { describeProjectionFailure } from './agent-projection-failure.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

const TOOL_SAFETY_MARKER = Symbol.for('goodvibes-agent.tool-execution-safety-wrapped');
const REGISTRY_SAFETY_MARKER = Symbol.for('goodvibes-agent.tool-registry-safety-installed');

type MarkedTool = Tool & { [TOOL_SAFETY_MARKER]?: true };
type MarkedRegistry = ToolRegistry & { [REGISTRY_SAFETY_MARKER]?: true };

export function installToolExecutionSafetyGuard(registry: ToolRegistry): void {
  const marked = registry as MarkedRegistry;
  if (marked[REGISTRY_SAFETY_MARKER]) return;
  marked[REGISTRY_SAFETY_MARKER] = true;

  for (const tool of registry.list()) wrapToolExecutionSafety(tool);

  const originalRegister = registry.register.bind(registry);
  registry.register = (tool: Tool, options): void => {
    wrapToolExecutionSafety(tool);
    originalRegister(tool, options);
  };
}

export function wrapToolExecutionSafety(tool: Tool): void {
  const marked = tool as MarkedTool;
  if (marked[TOOL_SAFETY_MARKER]) return;
  marked[TOOL_SAFETY_MARKER] = true;

  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    try {
      return await originalExecute(args, options);
    } catch (error) {
      // A cancelled call is signalled by a throw and must stay one: the host
      // reports it as cancelled, where an ordinary failed result would invite a
      // retry of a call the owner stopped. A held or stale call becomes a failed
      // result that says it is not the arguments' fault and not to retry.
      if (options?.signal?.aborted || (error instanceof ToolInputProjectionError && error.problem === 'cancelled')) throw error;
      if (error instanceof ToolInputProjectionError) return { success: false, error: describeProjectionFailure(error) };
      return {
        success: false,
        error: summarizeError(error),
      };
    }
  };
}
