/**
 * The process states a fleet node does not leave: the one definition every
 * fleet reader (the emit bridge, the archive, the contract adapter) uses.
 */
import type { ProcessState } from './types.js';

export const TERMINAL_PROCESS_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>(['done', 'failed', 'killed', 'interrupted']);

export function isTerminalProcessState(state: ProcessState): boolean {
  return TERMINAL_PROCESS_STATES.has(state);
}
