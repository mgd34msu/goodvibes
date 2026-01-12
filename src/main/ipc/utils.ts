// ============================================================================
// IPC UTILITIES
// ============================================================================

import { createRequestContext, runWithContextAsync } from '../services/requestContext.js';

/**
 * Wraps an IPC handler with request context for correlation logging.
 * This enables tracking requests through the entire application stack.
 *
 * @param operation - The name of the IPC operation (e.g., 'get-sessions')
 * @param handler - The handler function to wrap
 * @returns A wrapped handler that runs within a request context
 */
export function withContext<TArgs extends unknown[], TReturn>(
  operation: string,
  handler: (...args: TArgs) => Promise<TReturn>
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const context = createRequestContext(operation);
    return runWithContextAsync(context, () => handler(...args));
  };
}
