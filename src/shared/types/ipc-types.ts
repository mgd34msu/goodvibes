// ============================================================================
// IPC RESULT TYPES - Consistent error handling for IPC communication
// ============================================================================
//
// These types provide a consistent pattern for IPC handlers to return results
// that include error information, preventing silent error suppression.
//
// Usage:
//   Instead of: return []  (on error, silently fails)
//   Use: return { success: false, error: 'Error message', data: [] }
//
// ============================================================================

/**
 * Generic IPC result type for handlers that return data.
 * Ensures errors are propagated to the renderer process.
 *
 * @template T - The type of the data returned on success
 */
export interface IPCResult<T> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The data returned (may be default/empty value on error) */
  data: T;
  /** Error message if success is false */
  error?: string;
}

/**
 * IPC result type for handlers that return a simple boolean.
 * Use when the operation either succeeds or fails with no data.
 */
export interface IPCBooleanResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if success is false */
  error?: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a successful IPC result
 */
export function ipcOk<T>(data: T): IPCResult<T> {
  return { success: true, data };
}

/**
 * Create a failed IPC result with an error message
 */
export function ipcErr<T>(error: unknown, fallbackData: T): IPCResult<T> {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    data: fallbackData,
  };
}

/**
 * Create a successful boolean result
 */
export function ipcBoolOk(): IPCBooleanResult {
  return { success: true };
}

/**
 * Create a failed boolean result with an error message
 */
export function ipcBoolErr(error: unknown): IPCBooleanResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
