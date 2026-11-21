import { retainHookWork } from '../live-work.js';
import type { HookDefinition, HookResult, HookEvent } from '../types.js';
import type { AgentManager } from '../../tools/agent/index.js';
import { OwnedAgentExecutionUnavailableError } from '../../tools/agent/manager.js';
import { summarizeError } from '../../utils/error-display.js';
import { createHookExecution, hookTimeoutSeconds, type HookExecutionOptions } from '../execution.js';

/**
 * Agent hook runner: spawns a subagent through AgentManager.spawnOwned and
 * awaits its settlement, up to the hook's configured timeout.
 *
 * The hook's `prompt` field (with `$ARGUMENTS` replaced by the event JSON)
 * becomes the agent task description.
 *
 * The spawn runs the work: it is not outside every contract, so the manager
 * starts a contract through the composed contract runner (as the agent tool
 * does for a spawn inside a contract). The contract's unit agents run in the
 * background and Jev checks their work; when the contract ends, the owner
 * record settles `completed` with the contract's answer in `fullOutput`,
 * `failed` with its error, or `cancelled`, and the hook's await of that
 * settlement returns. Its result carries the answer as `additionalContext`,
 * never the operator progress line. The hook's execution signal ends at the
 * caller's cancellation (a turn that owns the hook) or at the hook's timeout,
 * whichever comes first; a hook fired outside a turn has only the timeout.
 * Either stops the contract and its unit agents.
 */
export async function run(
  hook: HookDefinition,
  event: HookEvent,
  manager: Pick<AgentManager, 'spawnOwned'>,
  options: HookExecutionOptions = {},
): Promise<HookResult> {
  if (hook.prompt == null) return { ok: false, error: 'agent hook missing "prompt" field' };
  if (options.signal?.aborted) return { ok: false, error: 'agent hook cancelled' };
  const execution = createHookExecution(options, hookTimeoutSeconds(hook, 'agent'), 'agent');
  try {
    execution.signal.throwIfAborted();
    const owned = manager.spawnOwned({
      mode: 'spawn',
      task: hook.prompt.replaceAll('$ARGUMENTS', JSON.stringify(event)),
      template: 'general',
      model: hook.model,
      sessionId: event.sessionId,
    }, { signal: execution.signal });
    const current = await retainHookWork(owned.settled);
    const agentId = current.id;
    if (execution.signal.aborted) {
      return { ok: false, error: options.signal?.aborted ? 'agent hook cancelled' : `agent hook timed out after ${hookTimeoutSeconds(hook, 'agent')}s (agentId: ${agentId})` };
    }
    if (current.status === 'completed') return current.fullOutput ? { ok: true, additionalContext: current.fullOutput } : { ok: true };
    if (current.status === 'cancelled') return { ok: false, error: `agent ${agentId} was cancelled before completing` };
    return { ok: false, error: current.error ?? `agent ${agentId} settled without completing`, ...(current.failureReason === 'OWNED_AGENT_EXECUTION_UNSUPPORTED' ? { code: current.failureReason } : {}) };
  } catch (error) {
    return { ok: false, error: `agent hook failed: ${summarizeError(error)}`, ...(error instanceof OwnedAgentExecutionUnavailableError ? { code: error.code } : {}) };
  } finally {
    execution.dispose();
  }
}
