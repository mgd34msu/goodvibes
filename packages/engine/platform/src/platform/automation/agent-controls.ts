import type { AgentManager } from '../tools/agent/index.js';
import { automationActionBinding } from './action-source.js';
import type { SpawnAutomationTaskInput } from './manager-runtime-helpers.js';

/**
 * How an automation run starts its agent. Every product composes the manager
 * with this one adapter, so a job behaves the same wherever it runs. The agent
 * is spawned with the action binding the manager recorded on the input (the
 * trusted source and cancel signal), so it runs under the owner the automation
 * recorded rather than asking the person at the terminal. An empty
 * tool allowlist means no restriction, the same as no allowlist: a job is
 * restricted only by a list that names at least one tool.
 */
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
