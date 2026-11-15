import { z } from 'zod/v4';

/**
 * Schema for `control.status` response.
 *
 * Matches `OperatorMethodOutputMap["control.status"]`.
 */
export const ControlStatusResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
  // The daemon always sends the two versions separately, and `cluster` whenever it has a coordinator.
  buildVersion: z.string().optional(),
  platformVersion: z.string().optional(),
  receipts: z.array(z.object({ id: z.string(), text: z.string(), at: z.number() })).optional(),
  cluster: z.unknown().optional(),
}).strict();

export type ControlStatusResponse = z.infer<typeof ControlStatusResponseSchema>;

/**
 * Schema for `local_auth.status` response.
 *
 * Matches `OperatorMethodOutputMap["local_auth.status"]`.
 */
const LocalAuthUserSchema = z.object({
  username: z.string(),
  roles: z.array(z.string()),
}).strict();

const LocalAuthSessionSchema = z.object({
  id: z.string(),
  username: z.string(),
  expiresAt: z.number(),
}).strict();

export const LocalAuthStatusResponseSchema = z.object({
  userStorePath: z.string(),
  bootstrapCredentialPath: z.string(),
  bootstrapCredentialPresent: z.boolean(),
  userCount: z.number(),
  sessionCount: z.number(),
  users: z.array(LocalAuthUserSchema),
  sessions: z.array(LocalAuthSessionSchema),
}).strict();

export type LocalAuthStatusResponse = z.infer<typeof LocalAuthStatusResponseSchema>;
