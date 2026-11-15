/**
 * Which agent a tool call belongs to.
 *
 * A tool body receives its arguments and a signal, never the identity of the
 * agent that called it, and a tool that answers "about me" (how my unit's
 * criteria read, say) must not take that identity from the model. The runner
 * binds it here around each call it executes, so the tool reads the host's
 * truth and the model cannot name another agent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const callingAgent = new AsyncLocalStorage<string>();

/** Runs `fn` with `agentId` as the calling agent of every tool call it starts. */
export function withCallingAgent<T>(agentId: string, fn: () => T): T {
  return callingAgent.run(agentId, fn);
}

/** The agent whose tool call is executing, or undefined outside a sub-agent run. */
export function callingAgentId(): string | undefined {
  return callingAgent.getStore();
}
