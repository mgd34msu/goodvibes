import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';

/**
 * The text of a tool's catch-all. An admission problem (held, stale, invalid
 * and the rest), and any error once the call's `signal` is aborted, is
 * rethrown so the tool runtime reports it with its cause and next step, the
 * same wording every tool gets; a three-word "Tool input projection held." in
 * a result would tell the model neither. Any other error is its own message.
 */
export function toolErrorText(error: unknown, signal?: AbortSignal | undefined): string {
  if (error instanceof ToolInputProjectionError || signal?.aborted === true) throw error;
  return error instanceof Error ? error.message : String(error);
}
