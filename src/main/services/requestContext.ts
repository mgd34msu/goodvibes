// ============================================================================
// REQUEST CONTEXT SERVICE
// ============================================================================
//
// Provides request correlation for tracing IPC calls through the application.
// Uses AsyncLocalStorage to maintain context across async boundaries.
// ============================================================================

import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Request context that flows through the application for each IPC call
 */
export interface RequestContext {
  /** Unique identifier for this request */
  requestId: string;
  /** Timestamp when the request started (ms since epoch) */
  startTime: number;
  /** Name of the operation being performed */
  operation: string;
}

// ============================================================================
// STORAGE
// ============================================================================

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Creates a new request context for an operation.
 * @param operation - The name of the operation (e.g., 'get-sessions', 'git-status')
 * @returns A new RequestContext with unique ID and current timestamp
 */
export function createRequestContext(operation: string): RequestContext {
  return {
    requestId: uuidv4(),
    startTime: Date.now(),
    operation,
  };
}

/**
 * Runs a function within a request context.
 * The context will be available to all code called from within the function,
 * including async callbacks.
 *
 * @param context - The request context to use
 * @param fn - The function to run within the context
 * @returns The return value of the function
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Runs an async function within a request context.
 * The context will be available to all code called from within the function,
 * including async callbacks and awaited promises.
 *
 * @param context - The request context to use
 * @param fn - The async function to run within the context
 * @returns A promise that resolves to the return value of the function
 */
export async function runWithContextAsync<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Gets the current request context, if one exists.
 * @returns The current RequestContext, or undefined if not in a request context
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Gets the current request ID, if one exists.
 * This is a convenience function for logging.
 * @returns The current request ID, or undefined if not in a request context
 */
export function getRequestId(): string | undefined {
  return asyncLocalStorage.getStore()?.requestId;
}

/**
 * Gets the elapsed time since the request started.
 * @returns The elapsed time in milliseconds, or undefined if not in a request context
 */
export function getRequestDuration(): number | undefined {
  const context = asyncLocalStorage.getStore();
  if (!context) return undefined;
  return Date.now() - context.startTime;
}

/**
 * Gets the current operation name, if one exists.
 * @returns The current operation name, or undefined if not in a request context
 */
export function getOperation(): string | undefined {
  return asyncLocalStorage.getStore()?.operation;
}
