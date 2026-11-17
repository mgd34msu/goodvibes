/**
 * The gate's decision on the tool call now running, set by the one tool-batch
 * executor around the call's body (and by a nested call's own admission). A
 * host-owned scope: tool arguments and execution options never set it, so a
 * reader learns who settled the call, never a grant. A settings write reads it
 * to stamp the write with an agent origin (config/manager.ts `setMany`), so the
 * settings owner applies its own rule on a change that loosens security.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolDecision } from '../types/tools.js';

const admitted = new AsyncLocalStorage<ToolDecision>();

/** Run a tool call's body with the gate's decision on it in scope. */
export function withAdmittedToolDecision<T>(decision: ToolDecision, run: () => T): T {
  return admitted.run(decision, run);
}

/** The gate's decision on the tool call this code runs inside, or undefined outside any admitted call. */
export function currentAdmittedToolDecision(): ToolDecision | undefined {
  return admitted.getStore();
}
