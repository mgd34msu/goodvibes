// ============================================================================
// HOOKS SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, sessionIdSchema, filePathSchema } from './primitives.js';

// ============================================================================
// HOOK EVENT TYPES
// ============================================================================

/**
 * Hook event type schema (legacy format)
 */
export const hookEventTypeSchema = z.enum([
  'session_start',
  'session_end',
  'commit_before',
  'commit_after',
  'push_before',
  'push_after',
  'pull_before',
  'pull_after',
  'branch_checkout',
  'file_change',
]);

/**
 * Extended hook event type schema - all 12 Claude hook events
 */
export const extendedHookEventTypeSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
]);

// ============================================================================
// HOOK CONFIGURATION SCHEMAS
// ============================================================================

/**
 * Hook creation schema
 */
export const createHookSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  eventType: hookEventTypeSchema,
  script: z.string().min(1).max(100000),
  enabled: z.boolean(),
  async: z.boolean().optional(),
  timeout: z.number().int().positive().max(300000).optional(), // 5 min max
  projectPath: z.string().max(1000).optional(),
});

/**
 * Hook update schema
 */
export const updateHookSchema = z.object({
  id: numericIdSchema,
  updates: createHookSchema.partial(),
});

/**
 * Get hooks by event schema
 */
export const getHooksByEventSchema = z.object({
  eventType: hookEventTypeSchema,
  projectPath: z.string().max(1000).optional(),
});

// ============================================================================
// TEST HOOK SCHEMA
// ============================================================================

/**
 * Test hook command schema - validates hook testing input
 * Note: command execution is intentional for user-defined hooks
 */
export const testHookSchema = z.object({
  command: z.string()
    .min(1, 'Command is required')
    .max(10000, 'Command too long'),
  input: z.record(z.unknown()),
});

// ============================================================================
// HOOK EVENT QUERY SCHEMAS
// ============================================================================

/**
 * Pagination limit schema for hook events
 */
export const hookEventLimitSchema = z.object({
  limit: z.number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(10000, 'Limit too large')
    .optional(),
});

/**
 * Get hook events by session schema
 */
export const getHookEventsBySessionSchema = z.object({
  sessionId: sessionIdSchema,
  limit: z.number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(10000, 'Limit too large')
    .optional(),
});

/**
 * Get hook events by type schema
 */
export const getHookEventsByTypeSchema = z.object({
  eventType: extendedHookEventTypeSchema,
  limit: z.number()
    .int('Limit must be an integer')
    .positive('Limit must be positive')
    .max(10000, 'Limit too large')
    .optional(),
});

/**
 * Cleanup hook events schema
 */
export const cleanupHookEventsSchema = z.object({
  maxAgeHours: z.number()
    .int('Hours must be an integer')
    .positive('Hours must be positive')
    .max(8760, 'Max age cannot exceed 1 year')
    .optional(),
});

// ============================================================================
// BUDGET SCHEMAS
// ============================================================================

/**
 * Budget reset period schema
 */
export const budgetResetPeriodSchema = z.enum(['session', 'daily', 'weekly', 'monthly']);

/**
 * Get budget schema
 */
export const getBudgetSchema = z.object({
  projectPath: filePathSchema.optional(),
  sessionId: sessionIdSchema.optional(),
});

/**
 * Upsert budget schema
 */
export const upsertBudgetSchema = z.object({
  projectPath: filePathSchema.optional().nullable(),
  sessionId: sessionIdSchema.optional().nullable(),
  limitUsd: z.number()
    .nonnegative('Limit cannot be negative')
    .max(1000000, 'Limit too large'),
  spentUsd: z.number()
    .nonnegative('Spent amount cannot be negative')
    .max(1000000, 'Amount too large')
    .optional(),
  warningThreshold: z.number()
    .min(0, 'Threshold cannot be negative')
    .max(1, 'Threshold must be between 0 and 1')
    .optional(),
  hardStopEnabled: z.boolean().optional(),
  resetPeriod: budgetResetPeriodSchema.optional(),
});

/**
 * Update budget spent schema
 */
export const updateBudgetSpentSchema = z.object({
  id: numericIdSchema,
  additionalCost: z.number()
    .nonnegative('Cost cannot be negative')
    .max(10000, 'Cost too large'),
});

// ============================================================================
// APPROVAL POLICY SCHEMAS
// ============================================================================

/**
 * Approval action schema
 */
export const approvalActionSchema = z.enum(['auto-approve', 'auto-deny', 'queue']);

/**
 * Create approval policy schema
 */
export const createApprovalPolicySchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  matcher: z.string().min(1, 'Matcher is required').max(1000, 'Matcher too long'),
  action: approvalActionSchema,
  priority: z.number()
    .int('Priority must be an integer')
    .min(0, 'Priority cannot be negative')
    .max(1000, 'Priority too large')
    .optional(),
  conditions: z.string().max(10000, 'Conditions too long').optional().nullable(),
  enabled: z.boolean().optional(),
});

/**
 * Update approval policy schema
 */
export const updateApprovalPolicySchema = z.object({
  id: numericIdSchema,
  updates: createApprovalPolicySchema.partial(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type HookEventType = z.infer<typeof hookEventTypeSchema>;
export type ExtendedHookEventType = z.infer<typeof extendedHookEventTypeSchema>;
export type CreateHookInput = z.infer<typeof createHookSchema>;
export type UpdateHookInput = z.infer<typeof updateHookSchema>;
export type GetHooksByEventInput = z.infer<typeof getHooksByEventSchema>;
export type TestHookInput = z.infer<typeof testHookSchema>;
export type GetHookEventsBySessionInput = z.infer<typeof getHookEventsBySessionSchema>;
export type GetHookEventsByTypeInput = z.infer<typeof getHookEventsByTypeSchema>;
export type CleanupHookEventsInput = z.infer<typeof cleanupHookEventsSchema>;
export type GetBudgetInput = z.infer<typeof getBudgetSchema>;
export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;
export type UpdateBudgetSpentInput = z.infer<typeof updateBudgetSpentSchema>;
export type CreateApprovalPolicyInput = z.infer<typeof createApprovalPolicySchema>;
export type UpdateApprovalPolicyInput = z.infer<typeof updateApprovalPolicySchema>;
