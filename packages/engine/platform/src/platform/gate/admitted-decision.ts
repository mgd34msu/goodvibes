/**
 * The gate's decision on the tool call now running, set by the one tool-batch
 * executor around the call's body (and by a nested call's own admission). A
 * host-owned scope: tool arguments and execution options never set it, so a
 * reader learns who settled the call, never a grant. A settings write reads it
 * to stamp the write with an agent origin (config/manager.ts `setMany`), so the
 * settings owner applies its own rule on a change that loosens security.
 *
 * One grant rides on it: the owner's own yes to the exact call their card showed (the gate's prompt, answered by them,
 * the call's arguments as the card showed them). For as long as that one call runs, and only inside it,
 * `ownersYesToThisCall` is true: the daemon sends that call's nested methods with the owner's authority
 * (daemon/capability-wiring.ts), even in a conversation that read text from outside. Another call of the same turn has
 * its own decision, so it gains nothing; a call started inside this one (a helper's turn) has its own decision too; and
 * once the call has finished the grant is spent, so nothing it left running later reads it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolDecision } from '../types/tools.js';

const admitted = new AsyncLocalStorage<ToolDecision>();
/** The decisions that are the owner's own yes to that one call, while the call runs. */
const ownersYes = new WeakSet<ToolDecision>();

/**
 * Run a tool call's body with the gate's decision on it in scope. `ownersOneCallYes`: the owner in person said yes to
 * exactly this call as their card showed it (set by the executor only, never from a tool's arguments or options).
 */
export function withAdmittedToolDecision<T>(decision: ToolDecision, run: () => T, ownersOneCallYes = false): T {
  if (!ownersOneCallYes) return admitted.run(decision, run);
  // Its own object, so no other call's decision is ever the granted one.
  const own: ToolDecision = { ...decision };
  ownersYes.add(own);
  let result: T;
  try {
    result = admitted.run(own, run);
  } catch (error) {
    ownersYes.delete(own);
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => { ownersYes.delete(own); }) as unknown as T;
  }
  ownersYes.delete(own);
  return result;
}

/** The gate's decision on the tool call this code runs inside, or undefined outside any admitted call. */
export function currentAdmittedToolDecision(): ToolDecision | undefined {
  return admitted.getStore();
}

/** Whether this code runs inside a call the owner in person said yes to, as their card showed it, while that call runs. */
export function ownersYesToThisCall(): boolean {
  const decision = admitted.getStore();
  return decision !== undefined && ownersYes.has(decision);
}
