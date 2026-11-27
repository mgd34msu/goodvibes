import type { AgentManager } from '../tools/agent/index.js';
import { partyOfRecordedCause, withInputParty } from '../security/turn-input-party.js';
import { withConversation } from '../security/conversation-exposure.js';
import { automationActionBinding } from './action-source.js';
import type { SpawnAutomationTaskInput } from './manager-runtime-helpers.js';

/**
 * How an automation run starts its agent. Every product composes the manager
 * with this one adapter, so a job behaves the same wherever it runs. The agent
 * is spawned with the action binding the manager recorded on the input (the
 * trusted source and cancel signal), so it runs under the owner the automation
 * recorded rather than asking the person at the terminal. An empty
 * tool allowlist means no restriction, the same as no allowlist: a job is
 * restricted only by a list that names at least one tool. An unrestricted run
 * also gets the tools the owner has connected (mail and calendar), under the
 * same permission gate as every other call of the run.
 */
export function createAutomationSpawnTask(
  agentManager: Pick<AgentManager, 'spawn'>,
  connectedTools: () => readonly string[] = () => [],
): (input: SpawnAutomationTaskInput) => string {
  return (input) => {
    // The owner's connected tools (their mail, their calendar) are their runs' only: never a run someone else caused.
    const extra = input.toolAllowlist?.length || input.cause !== undefined ? [] : connectedTools();
    // A schedule's run is the turn of whoever caused the schedule, marked so (security/turn-input-party.ts: unmarked
    // work is someone else's): the owner's own (made by them, their own turn, or kept from before makers were recorded),
    // or, when a paired device, a member, the outside agent, a script or a turn on someone else's input made, changed or
    // resumed it (jobs.ts `cause`), that caller's: reads only, no stored credential, whatever the mode.
    // Inside the schedule's own conversation key: it starts with what the conversation that made it had read.
    const record = withConversation(input.exposureKey, () => withInputParty(partyOfRecordedCause(input.cause), () => agentManager.spawn({
      mode: 'spawn',
      task: input.prompt,
      // A turn, as a conversation's is: its prompt goes to the model. Without this, a spawn with a decision model set
      // became the owner of a contract (tools/agent/manager.ts `startsContract`; the action binding is no contract
      // binding): its prompt went to a planner and step agents whose registries did not hold the turn's tools
      // ("Unknown tool in autonomous preparation"), and the schedule's own turn never reached the model.
      outsideContract: true,
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.modelProvider ? { provider: input.modelProvider } : {}),
      ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
      ...(input.routing ? { routing: input.routing } : {}),
      ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : extra.length > 0 ? { tools: [...extra] } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.spendingSource ? { spendingSource: input.spendingSource } : {}),
      // The run works in its schedule's project, never the daemon's own folder.
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    }, automationActionBinding(input))));
    return record.id;
  };
}

/**
 * Everything the automation manager needs from the agent manager: how a run
 * starts its agent, how it reads that agent's status to settle the run, and
 * how it stops the agent to cancel the run or end it at its timeout.
 */
export function createAutomationAgentControls(
  agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>,
  connectedTools?: () => readonly string[],
): {
  readonly spawnTask: (input: SpawnAutomationTaskInput) => string;
  readonly agentStatusProvider: Pick<AgentManager, 'getStatus'>;
  readonly cancelTask: (agentId: string) => void;
} {
  return {
    spawnTask: createAutomationSpawnTask(agentManager, connectedTools),
    agentStatusProvider: agentManager,
    cancelTask: (agentId) => { agentManager.cancel(agentId); },
  };
}
