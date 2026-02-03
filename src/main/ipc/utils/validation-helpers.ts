// ============================================================================
// IPC VALIDATION HELPERS
// ============================================================================
//
// Shared validation utilities for IPC handlers.
// All handlers should import these helpers instead of duplicating the code.
// ============================================================================

import { ZodError } from 'zod';

/**
 * Standard validation error response format for IPC handlers
 */
export interface ValidationErrorResponse {
  success: false;
  error: string;
  code: 'VALIDATION_ERROR';
  details?: Array<{ path: string; message: string }>;
}

/**
 * Formats a ZodError into a user-friendly error response
 * 
 * @param error - The Zod validation error to format
 * @returns A standardized validation error response
 */
export function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join(', ')}`,
    code: 'VALIDATION_ERROR',
    details,
  };
}

/**
 * Custom error class for IPC validation errors
 * 
 * Use this to throw validation errors that will be properly formatted in IPC responses.
 */
export class IPCValidationError extends Error {
  constructor(
    message: string,
    public details?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = 'IPCValidationError';
  }
}
