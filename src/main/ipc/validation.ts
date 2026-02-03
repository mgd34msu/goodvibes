// ============================================================================
// IPC INPUT VALIDATION - Validation utilities for IPC handlers
// ============================================================================

import { Logger } from '../services/logger.js';
import { MAX_STRING_LENGTH, MAX_PATH_LENGTH } from '../../shared/constants.js';

const logger = new Logger('IPCValidation');

// ============================================================================
// VALIDATION ERROR
// ============================================================================

/**
 * Custom error class for validation failures
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ============================================================================
// VALIDATION RESULT TYPE
// ============================================================================

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================================================
// STRING VALIDATION
// ============================================================================

/**
 * Configuration options for string validation
 */
export interface StringValidationOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  allowEmpty?: boolean;
  trim?: boolean;
}

/**
 * Validates that a value is a string and meets the specified criteria
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @param options - Validation options
 * @returns The validated string or throws ValidationError
 */
export function validateString(
  value: unknown,
  fieldName: string,
  options: StringValidationOptions = {}
): string {
  const {
    minLength = 0,
    maxLength = MAX_STRING_LENGTH,
    pattern,
    allowEmpty = false,
    trim = true,
  } = options;

  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`, fieldName, value);
  }

  let str = trim ? value.trim() : value;

  if (!allowEmpty && str.length === 0) {
    throw new ValidationError(`${fieldName} cannot be empty`, fieldName, value);
  }

  if (str.length < minLength) {
    throw new ValidationError(
      `${fieldName} must be at least ${minLength} characters`,
      fieldName,
      value
    );
  }

  if (str.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
      fieldName,
      value
    );
  }

  if (pattern && !pattern.test(str)) {
    throw new ValidationError(
      `${fieldName} format is invalid`,
      fieldName,
      value
    );
  }

  return str;
}

/**
 * Validates an optional string
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @param options - Validation options
 * @returns The validated string or null/undefined
 */
export function validateOptionalString(
  value: unknown,
  fieldName: string,
  options: StringValidationOptions = {}
): string | null | undefined {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }
  return validateString(value, fieldName, options);
}

// ============================================================================
// NUMBER VALIDATION
// ============================================================================

/**
 * Configuration options for number validation
 */
export interface NumberValidationOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  allowNaN?: boolean;
}

/**
 * Validates that a value is a number and meets the specified criteria
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @param options - Validation options
 * @returns The validated number or throws ValidationError
 */
export function validateNumber(
  value: unknown,
  fieldName: string,
  options: NumberValidationOptions = {}
): number {
  const {
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER,
    integer = false,
    allowNaN = false,
  } = options;

  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }

  const num = typeof value === 'number' ? value : Number(value);

  if (!allowNaN && isNaN(num)) {
    throw new ValidationError(`${fieldName} must be a valid number`, fieldName, value);
  }

  if (integer && !Number.isInteger(num)) {
    throw new ValidationError(`${fieldName} must be an integer`, fieldName, value);
  }

  if (num < min) {
    throw new ValidationError(
      `${fieldName} must be at least ${min}`,
      fieldName,
      value
    );
  }

  if (num > max) {
    throw new ValidationError(
      `${fieldName} must be at most ${max}`,
      fieldName,
      value
    );
  }

  return num;
}

/**
 * Validates an optional number
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @param options - Validation options
 * @returns The validated number or null/undefined
 */
export function validateOptionalNumber(
  value: unknown,
  fieldName: string,
  options: NumberValidationOptions = {}
): number | null | undefined {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }
  return validateNumber(value, fieldName, options);
}

// ============================================================================
// BOOLEAN VALIDATION
// ============================================================================

/**
 * Validates that a value is a boolean
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated boolean or throws ValidationError
 */
export function validateBoolean(value: unknown, fieldName: string): boolean {
  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }

  if (typeof value !== 'boolean') {
    // Allow truthy string conversions
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new ValidationError(`${fieldName} must be a boolean`, fieldName, value);
  }

  return value;
}

/**
 * Validates an optional boolean
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated boolean or null/undefined
 */
export function validateOptionalBoolean(
  value: unknown,
  fieldName: string
): boolean | null | undefined {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }
  return validateBoolean(value, fieldName);
}

// ============================================================================
// ARRAY VALIDATION
// ============================================================================

/**
 * Configuration options for array validation
 */
export interface ArrayValidationOptions<T> {
  minLength?: number;
  maxLength?: number;
  itemValidator?: (item: unknown, index: number) => T;
}

/**
 * Validates that a value is an array and meets the specified criteria
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @param options - Validation options
 * @returns The validated array or throws ValidationError
 */
export function validateArray<T = unknown>(
  value: unknown,
  fieldName: string,
  options: ArrayValidationOptions<T> = {}
): T[] {
  const {
    minLength = 0,
    maxLength = MAX_STRING_LENGTH,
    itemValidator,
  } = options;

  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }

  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an array`, fieldName, value);
  }

  if (value.length < minLength) {
    throw new ValidationError(
      `${fieldName} must have at least ${minLength} items`,
      fieldName,
      value
    );
  }

  if (value.length > maxLength) {
    throw new ValidationError(
      `${fieldName} must have at most ${maxLength} items`,
      fieldName,
      value
    );
  }

  if (itemValidator) {
    return value.map((item, index) => {
      try {
        return itemValidator(item, index);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new ValidationError(
            `${fieldName}[${index}]: ${error.message}`,
            `${fieldName}[${index}]`,
            item
          );
        }
        throw error;
      }
    });
  }

  return value as T[];
}

// ============================================================================
// OBJECT VALIDATION
// ============================================================================

/**
 * Validates that a value is a non-null object
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated object or throws ValidationError
 */
export function validateObject(
  value: unknown,
  fieldName: string
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an object`, fieldName, value);
  }

  return value as Record<string, unknown>;
}

// ============================================================================
// ENUM VALIDATION
// ============================================================================

/**
 * Validates that a value is one of the allowed enum values
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @param allowedValues - Array of allowed values
 * @returns The validated value or throws ValidationError
 */
export function validateEnum<T extends string | number>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[]
): T {
  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`, fieldName, value);
  }

  if (!allowedValues.includes(value as T)) {
    throw new ValidationError(
      `${fieldName} must be one of: ${allowedValues.join(', ')}`,
      fieldName,
      value
    );
  }

  return value as T;
}

// ============================================================================
// ID VALIDATION
// ============================================================================

/**
 * UUID pattern for session IDs
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Agent session ID pattern
 */
const AGENT_ID_PATTERN = /^agent-[a-z0-9]+$/i;

/**
 * Validates a session ID (UUID or agent-* format)
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated session ID or throws ValidationError
 */
export function validateSessionId(value: unknown, fieldName: string = 'sessionId'): string {
  const id = validateString(value, fieldName, { maxLength: 100 });

  if (!UUID_PATTERN.test(id) && !AGENT_ID_PATTERN.test(id)) {
    throw new ValidationError(
      `${fieldName} must be a valid session ID (UUID or agent-* format)`,
      fieldName,
      value
    );
  }

  return id;
}

/**
 * Validates a numeric ID (positive integer)
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated numeric ID or throws ValidationError
 */
export function validateNumericId(value: unknown, fieldName: string = 'id'): number {
  return validateNumber(value, fieldName, { min: 1, integer: true });
}

// ============================================================================
// PATH VALIDATION
// ============================================================================

/**
 * Dangerous path patterns that could indicate path traversal attacks
 */
const DANGEROUS_PATH_PATTERNS = [
  /\.\.[/\\]/, // Path traversal
  /^[/\\]$/, // Root directory only
];

/**
 * Validates a file system path
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated path or throws ValidationError
 */
export function validatePath(value: unknown, fieldName: string = 'path'): string {
  const path = validateString(value, fieldName, { maxLength: MAX_PATH_LENGTH });

  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    if (pattern.test(path)) {
      throw new ValidationError(
        `${fieldName} contains an invalid path pattern`,
        fieldName,
        value
      );
    }
  }

  return path;
}

/**
 * Validates an optional file system path
 * @param value - The value to validate
 * @param fieldName - The name of the field for error messages
 * @returns The validated path or null/undefined
 */
export function validateOptionalPath(
  value: unknown,
  fieldName: string = 'path'
): string | null | undefined {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }
  return validatePath(value, fieldName);
}

// ============================================================================
// VALIDATION WRAPPER
// ============================================================================

/**
 * Wraps a validation function and returns a ValidationResult instead of throwing
 * @param validator - The validation function to wrap
 * @returns A ValidationResult with success/error information
 */
export function safeValidate<T>(validator: () => T): ValidationResult<T> {
  try {
    return { success: true, data: validator() };
  } catch (error) {
    if (error instanceof ValidationError) {
      logger.warn('Validation failed', {
        field: error.field,
        message: error.message,
        value: typeof error.value === 'string' ? error.value.substring(0, 100) : error.value
      });
      return { success: false, error: error.message };
    }
    logger.error('Unexpected validation error', error);
    return { success: false, error: 'Validation failed' };
  }
}

// ============================================================================
// IPC-SPECIFIC VALIDATORS
// ============================================================================

/**
 * Validates terminal start options
 * @param options - The options object to validate
 * @returns Validated terminal start options
 */
export function validateTerminalStartOptions(options: unknown): {
  cwd?: string;
  name?: string;
  resumeSessionId?: string;
  sessionType?: 'user' | 'subagent';
} {
  const obj = validateObject(options, 'options');

  return {
    cwd: validateOptionalPath(obj.cwd, 'cwd') ?? undefined,
    name: validateOptionalString(obj.name, 'name', { maxLength: 200 }) ?? undefined,
    resumeSessionId: obj.resumeSessionId ? validateSessionId(obj.resumeSessionId, 'resumeSessionId') : undefined,
    sessionType: obj.sessionType
      ? validateEnum(obj.sessionType, 'sessionType', ['user', 'subagent'] as const)
      : undefined,
  };
}

/**
 * Validates setting update data
 * @param data - The data object to validate
 * @returns Validated setting data
 */
export function validateSettingData(data: unknown): { key: string; value: unknown } {
  const obj = validateObject(data, 'data');

  const key = validateString(obj.key, 'key', { maxLength: 100 });

  // Value can be any JSON-serializable type
  return { key, value: obj.value };
}

/**
 * Validates collection creation data
 * @param data - The data object to validate
 * @returns Validated collection data
 */
export function validateCollectionData(data: unknown): {
  name: string;
  color?: string;
  icon?: string;
} {
  const obj = validateObject(data, 'data');

  return {
    name: validateString(obj.name, 'name', { maxLength: 100 }),
    color: validateOptionalString(obj.color, 'color', {
      maxLength: 20,
      pattern: /^#[0-9a-fA-F]{6}$/
    }) ?? undefined,
    icon: validateOptionalString(obj.icon, 'icon', { maxLength: 10 }) ?? undefined,
  };
}

/**
 * Validates tag creation data
 * @param data - The data object to validate
 * @returns Validated tag data
 */
export function validateTagData(data: unknown): { name: string; color: string } {
  const obj = validateObject(data, 'data');

  return {
    name: validateString(obj.name, 'name', { maxLength: 50 }),
    color: validateString(obj.color, 'color', {
      maxLength: 20,
      pattern: /^#[0-9a-fA-F]{6}$/
    }),
  };
}

/**
 * Validates export options
 * @param options - The options object to validate
 * @returns Validated export options
 */
export function validateExportOptions(options: unknown): {
  sessionId: string;
  format: 'markdown' | 'json' | 'html';
} {
  const obj = validateObject(options, 'options');

  return {
    sessionId: validateSessionId(obj.sessionId),
    format: validateEnum(obj.format, 'format', ['markdown', 'json', 'html'] as const),
  };
}

/**
 * Validates git operation parameters
 * @param params - The parameters object to validate
 * @returns Validated git parameters
 */
export function validateGitParams(params: unknown): { cwd: string } & Record<string, unknown> {
  const obj = validateObject(params, 'params');

  return {
    ...obj,
    cwd: validatePath(obj.cwd, 'cwd'),
  };
}

// ============================================================================
// ZOD VALIDATION UTILITIES
// ============================================================================

import { z, type ZodSchema, ZodError } from 'zod';

/**
 * Result type for Zod validation
 */
export type ZodValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; issues: z.ZodIssue[] };

/**
 * Validates input against a Zod schema with detailed error messages
 * @param schema - The Zod schema to validate against
 * @param input - The input to validate
 * @param context - Optional context for error logging
 * @returns Validation result with data or error information
 */
export function validateWithZod<T>(
  schema: ZodSchema<T>,
  input: unknown,
  context?: string
): ZodValidationResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errorMessage = formatZodError(result.error);

  if (context) {
    logger.warn(`Validation failed for ${context}`, {
      error: errorMessage,
      issues: result.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }

  return {
    success: false,
    error: errorMessage,
    issues: result.error.issues,
  };
}

/**
 * Validates input against a Zod schema, throwing on failure
 * @param schema - The Zod schema to validate against
 * @param input - The input to validate
 * @param context - Optional context for error messages
 * @returns The validated and typed data
 * @throws ValidationError if validation fails
 */
export function validateWithZodOrThrow<T>(
  schema: ZodSchema<T>,
  input: unknown,
  context?: string
): T {
  const result = validateWithZod(schema, input, context);

  if (!result.success) {
    throw new ValidationError(result.error, context || 'input', input);
  }

  return result.data;
}

/**
 * Formats Zod errors into a human-readable string
 * @param error - The ZodError to format
 * @returns Formatted error string
 */
export function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });

  return issues.join('; ');
}

/**
 * Creates an IPC error response for validation failures
 * @param error - The validation error message
 * @param code - Optional error code (default: 'VALIDATION_ERROR')
 * @returns Standardized error response object
 */
export function createValidationErrorResponse(
  error: string,
  code: string = 'VALIDATION_ERROR'
): { success: false; error: string; code: string } {
  return {
    success: false,
    error,
    code,
  };
}

/**
 * Higher-order function that wraps an IPC handler with Zod validation
 * @param schema - The Zod schema to validate input against
 * @param handler - The handler function to wrap
 * @returns Wrapped handler that validates input before calling the original handler
 */
export function withZodValidation<TInput, TOutput>(
  schema: ZodSchema<TInput>,
  handler: (validatedInput: TInput) => Promise<TOutput>
): (input: unknown) => Promise<TOutput | { success: false; error: string; code: string }> {
  return async (input: unknown) => {
    const result = validateWithZod(schema, input);

    if (!result.success) {
      return createValidationErrorResponse(result.error);
    }

    return handler(result.data);
  };
}
