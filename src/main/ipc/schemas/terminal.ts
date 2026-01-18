// ============================================================================
// TERMINAL SCHEMAS
// ============================================================================

import { z } from 'zod';
import { filePathSchema, sessionIdSchema } from './primitives.js';

/**
 * Terminal start options schema
 */
export const terminalStartOptionsSchema = z.object({
  cwd: filePathSchema.optional(),
  name: z.string().max(200).optional(),
  resumeSessionId: sessionIdSchema.optional(),
  sessionType: z.enum(['user', 'subagent']).optional(),
});

/**
 * Terminal input schema
 */
export const terminalInputSchema = z.object({
  id: z.number().int().nonnegative(),
  data: z.string(),
});

/**
 * Terminal resize schema
 */
export const terminalResizeSchema = z.object({
  id: z.number().int().nonnegative(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(200),
});

/**
 * Terminal ID schema - for operations like kill-terminal
 */
export const terminalIdSchema = z.number().int().nonnegative();

/**
 * Plain terminal start options schema
 */
export const plainTerminalStartOptionsSchema = z.object({
  cwd: filePathSchema.optional(),
  name: z.string().max(200).optional(),
});

// Type exports for handler use
export type TerminalStartOptions = z.infer<typeof terminalStartOptionsSchema>;
export type TerminalInput = z.infer<typeof terminalInputSchema>;
export type TerminalResize = z.infer<typeof terminalResizeSchema>;
export type PlainTerminalStartOptions = z.infer<typeof plainTerminalStartOptionsSchema>;
