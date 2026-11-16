/**
 * What the Agent's policy says about one call. `allowed`: the call runs as a
 * read, or no Agent rule applies (the permission gate still decides). `needs_approval`:
 * the call changes something, so the permission gate decides it like any
 * change. `denied`: the call is refused before the gate (a malformed settings call).
 */
export interface AgentToolPolicyInvocationExplanation {
  readonly status: 'allowed' | 'needs_approval' | 'denied';
  readonly layer: 'agent_tool_policy';
  readonly reason: string;
  /** For a tool with read modes: the modes that run as reads. */
  readonly allowedModes?: readonly string[];
}
