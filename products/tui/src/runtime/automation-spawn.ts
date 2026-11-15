/**
 * automation-spawn.ts, how a scheduled or heartbeat automation starts its agent.
 *
 * The automation manager records the trusted source and cancel signal for the
 * action on the input it hands over. The agent has to be spawned with that
 * binding, or it runs as an ordinary classic agent that asks the person at the
 * terminal instead of under the owner the automation recorded.
 */
import { automationActionBinding, type SpawnAutomationTaskInput } from '@goodvibes-jev/engine/platform/platform/automation';
import type { AgentManager } from '@goodvibes-jev/engine/platform/platform/tools';

export function createAutomationSpawnTask(agentManager: Pick<AgentManager, 'spawn'>): (input: SpawnAutomationTaskInput) => string {
  return (input) => {
    const record = agentManager.spawn({
      mode: 'spawn',
      task: input.prompt,
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.modelProvider ? { provider: input.modelProvider } : {}),
      ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
      ...(input.routing ? { routing: input.routing } : {}),
      ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
      ...(input.context ? { context: input.context } : {}),
    }, automationActionBinding(input));
    return record.id;
  };
}

/**
 * Everything the automation manager needs from the agent manager: how a run
 * starts its agent, how it reads that agent's status to settle the run, and
 * how it stops the agent to cancel the run or end it at its timeout.
 */
export function createAutomationAgentControls(agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>): {
  readonly spawnTask: (input: SpawnAutomationTaskInput) => string;
  readonly agentStatusProvider: Pick<AgentManager, 'getStatus'>;
  readonly cancelTask: (agentId: string) => void;
} {
  return {
    spawnTask: createAutomationSpawnTask(agentManager),
    agentStatusProvider: agentManager,
    cancelTask: (agentId) => { agentManager.cancel(agentId); },
  };
}
