/**
 * The one slot for onboarding operations that wait on the network, the daemon
 * or a sign-in. It holds the running operation's name, so a key pressed while
 * one runs is answered with what it waits for instead of being ignored.
 */
import type { InputHandlerLike } from './handler-types.ts';

type OperationHost = Pick<InputHandlerLike, 'onboardingOperation' | 'commandContext' | 'onboardingWizard' | 'requestRender'>;

/**
 * Claim the one onboarding operation slot for `name`, or say which operation
 * holds it and refuse. Every wizard action that waits on the network, the
 * daemon or a sign-in goes through this one slot.
 */
export function beginOnboardingOperation(handler: OperationHost, name: string): boolean {
  const running = handler.onboardingOperation;
  if (running === null) {
    handler.onboardingOperation = name;
    return true;
  }
  const message = `${running} is still running; ${name} was not started. Wait for it to finish, then try again.`;
  handler.onboardingWizard.setApplyFeedback({ severity: 'warning', title: `${running} is still running`, summary: message, messages: [] });
  handler.commandContext?.print?.(`[Setup] ${message}`);
  handler.requestRender();
  return false;
}

export function endOnboardingOperation(handler: Pick<InputHandlerLike, 'onboardingOperation'>): void {
  handler.onboardingOperation = null;
}

