import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';

/**
 * What the model is told when a tool's own catch meets a held, stale or invalid
 * call. The bare "Tool input projection held." says nothing about whose fault it
 * is or what to do; a retry of a call the host refused is the usual wrong guess.
 * The host's own wording for the same problems lives in the engine's tool
 * runtime; this carries the two states these tools actually hit.
 */
export function describeProjectionFailure(error: ToolInputProjectionError): string {
  switch (error.problem) {
    case 'held':
      return `${error.message} The host held this call before it took effect: its recorded admission or authority did not hold. This is not caused by your arguments; do not retry the same call, and ask the owner if the change is wanted.`;
    case 'stale':
      return `${error.message} The tool or its inputs changed while the call was being prepared or run. Re-read what you need, then re-issue the call.`;
    case 'invalid':
      return `${error.message} The arguments could not be prepared for this tool. Nothing was executed; check them against the tool schema and re-issue the call.`;
    default:
      return error.message;
  }
}

/**
 * A tool's catch-all: a cancelled call is signalled by a throw and must stay one
 * (the host reports it as cancelled, not as an ordinary failure); a held or stale
 * call becomes a failure that says why; anything else is its own message.
 */
export function failureMessage(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted || (error instanceof ToolInputProjectionError && error.problem === 'cancelled')) throw error;
  if (error instanceof ToolInputProjectionError) return describeProjectionFailure(error);
  return error instanceof Error ? error.message : String(error);
}
