// ============================================================================
// SETTINGS SCHEMAS
// ============================================================================

import { z, ZodError } from 'zod';

// ============================================================================
// BASE SCHEMAS
// ============================================================================

/**
 * Setting key schema - alphanumeric with some special chars
 */
export const settingKeySchema = z.string()
  .min(1, 'Setting key is required')
  .max(100, 'Setting key too long')
  .regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/, 'Invalid setting key format');

/**
 * Setting update schema
 */
export const settingUpdateSchema = z.object({
  key: settingKeySchema,
  value: z.unknown(), // Allow any JSON-serializable value
});

/**
 * App path name schema
 */
export const appPathNameSchema = z.enum([
  'home', 'appData', 'userData', 'sessionData', 'temp', 'exe',
  'module', 'desktop', 'documents', 'downloads', 'music',
  'pictures', 'videos', 'recent', 'logs', 'crashDumps',
]);

// ============================================================================
// IPC INPUT SCHEMAS
// ============================================================================

/**
 * Input schema for get-setting handler
 */
export const getSettingInputSchema = settingKeySchema;

/**
 * Input schema for set-setting handler
 */
export const setSettingInputSchema = settingUpdateSchema;

/**
 * Input schema for get-app-path handler
 */
export const getAppPathInputSchema = appPathNameSchema;

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type SettingKey = z.infer<typeof settingKeySchema>;
export type SettingUpdate = z.infer<typeof settingUpdateSchema>;
export type AppPathName = z.infer<typeof appPathNameSchema>;

// ============================================================================
// VALIDATION RESULT TYPE
// ============================================================================

export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

export interface ValidationFailure {
  success: false;
  error: string;
  details?: z.ZodIssue[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Safely validate input using a Zod schema, returning a result object
 * instead of throwing.
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown
): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: formatZodError(result.error),
    details: result.error.issues,
  };
}

/**
 * Format a ZodError into a human-readable string
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}
