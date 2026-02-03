// ============================================================================
// NOTIFICATION SCHEMAS
// ============================================================================

import { z } from 'zod';

/**
 * Get notifications schema
 */
export const getNotificationsSchema = z.object({
  includeRead: z.boolean().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
