/**
 * The hosted third-party agent's lifecycle states and failure stages, as values,
 * so the operator contract publishes exactly the sets the host assigns. Kept free
 * of imports: the method catalog reads it without loading the host.
 */

/**
 * There is no waiting state: permission asks are decided by the autonomous
 * admission, not by a person, so no hosted row waits on a human.
 */
export const HOSTED_ACP_STATES = ['starting', 'idle', 'prompting', 'failed', 'stopped'] as const;

/** Spawning the process, the ACP initialize, session creation, or a prompt. */
export const ACP_HOST_ERROR_STAGES = ['spawn', 'initialize', 'session', 'prompt'] as const;
