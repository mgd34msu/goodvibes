import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';

/**
 * The text of a tool's catch-all. An admission problem (held, stale, invalid
 * and the rest) is rethrown so the tool runtime reports it with its cause and
 * next step; a three-word "Tool input projection held." in a result would tell
 * the model neither. Any other error is its own message.
 */
export function toolErrorText(error: unknown): string {
  if (error instanceof ToolInputProjectionError) throw error;
  return error instanceof Error ? error.message : String(error);
}
