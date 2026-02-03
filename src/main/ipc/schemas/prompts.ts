// ============================================================================
// PROMPT SCHEMAS
// ============================================================================

import { z } from 'zod';

/**
 * Prompt save schema
 */
export const savePromptSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50000),
  category: z.string().max(100).optional(),
});
