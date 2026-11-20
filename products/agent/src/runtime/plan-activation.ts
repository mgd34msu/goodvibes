import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/**
 * Starts the turn that carries out an activated plan. The turn begins after the
 * activating command has returned (a microtask later, no timer to leak or
 * cancel), and a turn that cannot start is shown to the user: the plan was
 * announced active, so a silent no-op would look like a plan that is running.
 */
export function startPlanActivationTurn(options: {
  readonly planId: string;
  readonly task: string;
  readonly handleUserInput: (task: string) => Promise<unknown>;
  readonly notify: (message: string) => void;
}): void {
  void Promise.resolve()
    .then(() => options.handleUserInput(options.task))
    .catch((error: unknown) => {
      logger.debug('activatePlan handler failed', { error: summarizeError(error) });
      options.notify(`[Planning] Plan ${options.planId} is active but its first turn did not start: ${summarizeError(error)}. Send the task as a message to begin it.`);
    });
}
