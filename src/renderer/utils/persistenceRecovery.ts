// ============================================================================
// PERSISTENCE RECOVERY UTILITIES - Error-resilient data persistence
// ============================================================================
//
// This module provides utilities for safely loading and saving persisted data
// with robust error recovery, partial corruption handling, and schema validation.
//
// Features:
// - Safe JSON parsing with fallback to defaults
// - Field-level validation and recovery for partial corruption
// - Schema migration support
// - Logging of recovery actions for debugging
//
// ============================================================================

import { createLogger } from '../../shared/logger';

const logger = createLogger('PersistenceRecovery');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Validator function type for individual fields
 */
export type FieldValidator<T> = (value: unknown) => value is T;

/**
 * Schema definition for validating persisted data.
 * T should be an object type with known keys.
 */
export interface PersistenceSchema<T extends object> {
  /** Name for logging purposes */
  name: string;
  /** Default values for all fields */
  defaults: T;
  /** Optional validators for individual fields */
  validators?: {
    [K in keyof T]?: FieldValidator<T[K]>;
  };
  /** Version of the schema for migration */
  version?: number;
}

/**
 * Result of a recovery operation
 */
export interface RecoveryResult<T> {
  /** The recovered data */
  data: T;
  /** Whether any recovery was needed */
  recovered: boolean;
  /** Fields that were recovered to defaults */
  recoveredFields: string[];
  /** Error message if recovery was needed */
  error?: string;
}

/**
 * Options for localStorage persistence
 */
export interface LocalStoragePersistOptions {
  /** Storage key */
  key: string;
  /** Whether to use sessionStorage instead of localStorage */
  useSessionStorage?: boolean;
}

// ============================================================================
// BUILT-IN VALIDATORS
// ============================================================================

/**
 * Common field validators for type checking
 */
export const validators = {
  /** Validates that value is a string */
  isString: (value: unknown): value is string => typeof value === 'string',

  /** Validates that value is a number */
  isNumber: (value: unknown): value is number =>
    typeof value === 'number' && !Number.isNaN(value),

  /** Validates that value is a boolean */
  isBoolean: (value: unknown): value is boolean => typeof value === 'boolean',

  /** Validates that value is a non-negative number */
  isNonNegativeNumber: (value: unknown): value is number =>
    typeof value === 'number' && !Number.isNaN(value) && value >= 0,

  /** Validates that value is a positive integer */
  isPositiveInteger: (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0,

  /** Validates that value is an array */
  isArray: (value: unknown): value is unknown[] => Array.isArray(value),

  /** Validates that value is an array of strings */
  isStringArray: (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string'),

  /** Validates that value is an object (not null, not array) */
  isObject: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),

  /** Validates that value is null or a specific type */
  isNullable:
    <T>(validator: FieldValidator<T>) =>
    (value: unknown): value is T | null =>
      value === null || validator(value),

  /** Validates that value is one of the allowed values */
  isOneOf:
    <T>(allowedValues: readonly T[]) =>
    (value: unknown): value is T =>
      allowedValues.includes(value as T),

  /** Validates that value is within a numeric range */
  isInRange:
    (min: number, max: number) =>
    (value: unknown): value is number =>
      typeof value === 'number' &&
      !Number.isNaN(value) &&
      value >= min &&
      value <= max,
};

// ============================================================================
// CORE RECOVERY FUNCTIONS
// ============================================================================

/**
 * Safely parse JSON with error recovery
 *
 * @param jsonString - The JSON string to parse
 * @param fallback - Fallback value if parsing fails
 * @returns Parsed value or fallback
 */
export function safeJsonParse<T>(jsonString: string, fallback: T): T {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    logger.warn('Failed to parse JSON, using fallback', {
      error: error instanceof Error ? error.message : String(error),
      preview: jsonString.slice(0, 100),
    });
    return fallback;
  }
}

/**
 * Validate and recover data against a schema
 *
 * This function performs field-level validation and recovery:
 * - Fields that fail validation are reset to their default values
 * - Missing fields are populated from defaults
 * - Extra fields not in the schema are preserved (for forward compatibility)
 *
 * @param data - The data to validate
 * @param schema - The schema to validate against
 * @returns Recovery result with validated data and recovery information
 */
export function validateAndRecover<T extends object>(
  data: unknown,
  schema: PersistenceSchema<T>
): RecoveryResult<T> {
  const recoveredFields: string[] = [];
  let hasErrors = false;
  let errorMessage: string | undefined;

  // Start with defaults
  const result = { ...schema.defaults };

  // If data isn't an object at all, return defaults
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    logger.warn(`${schema.name}: Data is not an object, using all defaults`, {
      dataType: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
    });
    return {
      data: result,
      recovered: true,
      recoveredFields: Object.keys(schema.defaults),
      error: 'Data was not a valid object, all fields reset to defaults',
    };
  }

  const inputData = data as Record<string, unknown>;

  // Validate each field in the schema
  for (const key of Object.keys(schema.defaults) as (keyof T)[]) {
    const keyStr = String(key);
    const defaultValue = schema.defaults[key];
    const validator = schema.validators?.[key];

    // Check if field exists in input
    if (!(keyStr in inputData)) {
      // Field is missing, use default
      recoveredFields.push(keyStr);
      hasErrors = true;
      logger.debug(`${schema.name}: Missing field '${keyStr}', using default`);
      continue;
    }

    const inputValue = inputData[keyStr];

    // If no validator, just check that value is same type as default
    if (!validator) {
      // Basic type check: same type or null (if default is null)
      const defaultType = defaultValue === null ? 'null' : typeof defaultValue;
      const inputType = inputValue === null ? 'null' : typeof inputValue;

      if (defaultType === inputType || (defaultValue === null && inputValue === null)) {
        result[key] = inputValue as T[keyof T];
      } else if (Array.isArray(defaultValue) && Array.isArray(inputValue)) {
        result[key] = inputValue as T[keyof T];
      } else {
        // Type mismatch, use default
        recoveredFields.push(keyStr);
        hasErrors = true;
        logger.debug(
          `${schema.name}: Type mismatch for '${keyStr}' (expected ${defaultType}, got ${inputType}), using default`
        );
      }
      continue;
    }

    // Run custom validator
    if (validator(inputValue)) {
      result[key] = inputValue as T[keyof T];
    } else {
      // Validation failed, use default
      recoveredFields.push(keyStr);
      hasErrors = true;
      logger.debug(
        `${schema.name}: Validation failed for '${keyStr}', using default`,
        { value: inputValue }
      );
    }
  }

  if (hasErrors) {
    errorMessage = `Recovered ${recoveredFields.length} field(s): ${recoveredFields.join(', ')}`;
    logger.info(`${schema.name}: ${errorMessage}`);
  }

  return {
    data: result,
    recovered: hasErrors,
    recoveredFields,
    error: errorMessage,
  };
}

// ============================================================================
// LOCALSTORAGE PERSISTENCE
// ============================================================================

/**
 * Load data from localStorage with error recovery
 *
 * @param options - Persistence options
 * @param schema - Schema for validation
 * @returns Recovery result
 */
export function loadFromLocalStorage<T extends object>(
  options: LocalStoragePersistOptions,
  schema: PersistenceSchema<T>
): RecoveryResult<T> {
  const storage = options.useSessionStorage ? sessionStorage : localStorage;

  try {
    const raw = storage.getItem(options.key);

    // No stored data, return defaults
    if (raw === null) {
      return {
        data: { ...schema.defaults },
        recovered: false,
        recoveredFields: [],
      };
    }

    // Parse JSON
    const parsed = safeJsonParse<unknown>(raw, null);

    // If parse failed completely, return defaults
    if (parsed === null) {
      logger.warn(
        `${schema.name}: Failed to parse stored data, clearing corrupted entry`
      );
      // Clear corrupted data
      try {
        storage.removeItem(options.key);
      } catch {
        // Ignore storage errors during cleanup
      }
      return {
        data: { ...schema.defaults },
        recovered: true,
        recoveredFields: Object.keys(schema.defaults),
        error: 'Stored data was corrupted (invalid JSON)',
      };
    }

    // Validate and recover
    return validateAndRecover(parsed, schema);
  } catch (error) {
    // Handle storage access errors (e.g., SecurityError, QuotaExceededError)
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`${schema.name}: Storage access error`, { error: errorMessage });

    return {
      data: { ...schema.defaults },
      recovered: true,
      recoveredFields: Object.keys(schema.defaults),
      error: `Storage access error: ${errorMessage}`,
    };
  }
}

/**
 * Save data to localStorage with error handling
 *
 * @param options - Persistence options
 * @param data - Data to save
 * @param schema - Schema for the data (used for name in logging)
 * @returns True if save succeeded, false otherwise
 */
export function saveToLocalStorage<T extends object>(
  options: LocalStoragePersistOptions,
  data: T,
  schema: PersistenceSchema<T>
): boolean {
  const storage = options.useSessionStorage ? sessionStorage : localStorage;

  try {
    const serialized = JSON.stringify(data);
    storage.setItem(options.key, serialized);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for quota exceeded
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      logger.error(`${schema.name}: Storage quota exceeded`, {
        key: options.key,
        dataSize: JSON.stringify(data).length,
      });
    } else {
      logger.error(`${schema.name}: Failed to save to storage`, {
        error: errorMessage,
      });
    }

    return false;
  }
}

/**
 * Remove data from localStorage
 *
 * @param options - Persistence options
 * @returns True if removal succeeded, false otherwise
 */
export function removeFromLocalStorage(
  options: LocalStoragePersistOptions
): boolean {
  const storage = options.useSessionStorage ? sessionStorage : localStorage;

  try {
    storage.removeItem(options.key);
    return true;
  } catch (error) {
    logger.error('Failed to remove from storage', {
      key: options.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// IPC PERSISTENCE HELPERS
// ============================================================================

/**
 * Load settings from IPC with error recovery
 *
 * This function wraps IPC calls to get settings with proper error handling
 * and field-level recovery.
 *
 * @param loadFn - Async function that loads all settings from IPC
 * @param schema - Schema for validation
 * @returns Recovery result
 */
export async function loadFromIpc<T extends object>(
  loadFn: () => Promise<Record<string, unknown>>,
  schema: PersistenceSchema<T>
): Promise<RecoveryResult<T>> {
  try {
    const raw = await loadFn();
    return validateAndRecover(raw, schema);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`${schema.name}: IPC load failed`, { error: errorMessage });

    return {
      data: { ...schema.defaults },
      recovered: true,
      recoveredFields: Object.keys(schema.defaults),
      error: `IPC load failed: ${errorMessage}`,
    };
  }
}

/**
 * Save a single setting via IPC with error handling
 *
 * @param saveFn - Async function that saves a single setting
 * @param key - Setting key
 * @param value - Setting value
 * @param schemaName - Name of the schema for logging
 * @returns True if save succeeded, false otherwise
 */
export async function saveToIpc<K extends string, V>(
  saveFn: (key: K, value: V) => Promise<boolean>,
  key: K,
  value: V,
  schemaName: string
): Promise<boolean> {
  try {
    const result = await saveFn(key, value);
    if (!result) {
      logger.warn(`${schemaName}: Save returned false for key '${key}'`);
    }
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`${schemaName}: Failed to save '${key}'`, { error: errorMessage });
    return false;
  }
}

// ============================================================================
// ZUSTAND PERSISTENCE MIDDLEWARE HELPER
// ============================================================================

/**
 * Create a custom storage adapter for Zustand persist middleware
 * that includes error recovery
 *
 * @param options - LocalStorage persistence options
 * @param schema - Schema for validation
 * @returns Storage adapter compatible with Zustand persist
 */
export function createRecoverableStorage<T extends object>(
  options: LocalStoragePersistOptions,
  schema: PersistenceSchema<T>
) {
  return {
    getItem: (_name: string): string | null => {
      const result = loadFromLocalStorage(options, schema);

      // If recovery was needed, save the recovered data
      if (result.recovered) {
        saveToLocalStorage(options, result.data, schema);
      }

      return JSON.stringify({ state: result.data });
    },

    setItem: (_name: string, value: string): void => {
      try {
        const parsed = JSON.parse(value) as { state: T };
        saveToLocalStorage(options, parsed.state, schema);
      } catch (error) {
        logger.error(`${schema.name}: Failed to parse state for saving`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    removeItem: (_name: string): void => {
      removeFromLocalStorage(options);
    },
  };
}

// ============================================================================
// ERROR RECOVERY FOR CORRUPT DATA
// ============================================================================

/**
 * Attempt to repair corrupted JSON by common fixes
 *
 * This function attempts various repairs for common JSON corruption issues:
 * - Trailing commas
 * - Unquoted keys
 * - Single quotes instead of double quotes
 *
 * @param corrupted - The corrupted JSON string
 * @returns Repaired JSON string or null if repair failed
 */
export function attemptJsonRepair(corrupted: string): string | null {
  // Try original first (maybe it just has whitespace issues)
  try {
    JSON.parse(corrupted.trim());
    return corrupted.trim();
  } catch {
    // Continue with repairs
  }

  // Try common fixes
  const repairs = [
    // Remove trailing commas before closing brackets
    () => corrupted.replace(/,(\s*[}\]])/g, '$1'),
    // Replace single quotes with double quotes
    () => corrupted.replace(/'/g, '"'),
    // Both fixes together
    () => corrupted.replace(/'/g, '"').replace(/,(\s*[}\]])/g, '$1'),
  ];

  for (const repair of repairs) {
    try {
      const repaired = repair();
      JSON.parse(repaired);
      logger.info('Successfully repaired corrupted JSON');
      return repaired;
    } catch {
      // Try next repair
    }
  }

  logger.warn('Failed to repair corrupted JSON');
  return null;
}

/**
 * Safe parse with repair attempt
 *
 * @param jsonString - The JSON string to parse
 * @param fallback - Fallback value if all parsing fails
 * @returns Parsed value or fallback
 */
export function safeJsonParseWithRepair<T>(jsonString: string, fallback: T): T {
  // Try normal parse first
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    // Try repair
    const repaired = attemptJsonRepair(jsonString);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // Repair parsing failed
      }
    }
    return fallback;
  }
}
