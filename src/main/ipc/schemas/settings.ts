// ============================================================================
// SETTINGS SCHEMAS
// ============================================================================

import { z } from 'zod';

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
