import { toolErrorText } from './tool-error-text.ts';

/**
 * A held, stale, invalid or cancelled call is not a tool's own result. It
 * propagates to the tool runtime, which words every such problem once, with
 * its cause and next step, for every tool, and reports a cancelled call as
 * cancelled. A tool's catch-all uses `toolErrorText` (tool-error-text.ts);
 * these two names remain only for the callers that still import them.
 */
export function failureMessage(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) throw error;
  return toolErrorText(error);
}

/** Rethrows: the runtime describes the problem. */
export function describeProjectionFailure(error: unknown): never {
  throw error;
}
