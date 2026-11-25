/**
 * persons-own-act.ts: whether what runs now is a person's own act in a terminal program, a line he typed or a control
 * he pressed. Set around the command line typed at the keyboard (command-registry.ts `executeFromOwner`) and a press in
 * a place (places/place-host.ts `runCapability`); read where something that act made is handed to the daemon (an
 * artifact it saves, agent-turn/capability-tools.ts `daemonCapabilityRunner`): such a save is part of what the person
 * asked and carries the person's claim. A model's turn started under it is not the person's act: the reader checks
 * that no turn and no tool call is running.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** One act's mark: under way until the act returns (or its promise settles), then over for everything it started. */
interface ActMark { live: boolean }

const scope = new AsyncLocalStorage<ActMark>();

/**
 * Run `act` as the person's own act. The mark ends when `act` returns, or when the promise it returns settles: work
 * it started that goes on afterwards (a background agent, a run that saves later) still sees the store, but no longer
 * as the person's act, so it carries no claim of his.
 */
export function asPersonsOwnAct<T>(act: () => T): T {
  const mark: ActMark = { live: true };
  let result: T;
  try {
    result = scope.run(mark, act);
  } catch (error) {
    mark.live = false;
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => { mark.live = false; }) as T;
  }
  mark.live = false;
  return result;
}

/** Whether a person's own typed line or press is what runs now (its handler has not returned yet). */
export function inPersonsOwnAct(): boolean {
  return scope.getStore()?.live === true;
}
