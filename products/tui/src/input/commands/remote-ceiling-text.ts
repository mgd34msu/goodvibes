import type { RemoteRunnerContract } from '@goodvibes/engine/platform/platform/runtime/operations';

/**
 * What a runner contract's ceiling does, in the words the remote commands
 * print. An external (ACP) runner runs its own tools; this side refuses a
 * permission ask outside its tools or write scope (acp/runner-ceiling.ts). A
 * local agent is given only its tools.
 */
export function runnerToolsText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const tools = contract.capabilityCeiling.allowedTools;
  if (tools.length === 0) return '(no tool ceiling)';
  return `${tools.join(', ')} (${contract.trustClass === 'self-hosted-acp'
    ? 'a permission ask for any other kind of call is refused'
    : 'the agent is given only these'})`;
}

export function runnerWriteScopeText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const scope = contract.capabilityCeiling.writeScope;
  if (scope.length === 0) return '(none: the working directory, under its permission rules)';
  return `${scope.join(', ')} (${contract.trustClass === 'self-hosted-acp'
    ? 'an edit outside it, or a command, is refused at its permission ask'
    : 'the scope its work is accepted against'})`;
}

export function runnerReviewText(contract: Pick<RemoteRunnerContract, 'trustClass' | 'capabilityCeiling'>): string {
  const mode = contract.capabilityCeiling.reviewMode;
  return mode === 'contract' && contract.trustClass === 'self-hosted-acp' ? 'contract (not applied to an external runner)' : mode;
}
