/**
 * A tool call's permission category as Jev reads it, for explanations. It is
 * never an approval: the permission manager owns the decision, and its own
 * `checkDetailed` releases a cancelled caller at once (`awaitPermission`).
 */
import type { PermissionCategory } from '../../permissions/types.js';
import { assertPermissionActive, awaitPermission } from '../../permissions/cancellation.js';
import { categoryForSideEffectKind, readSideEffectKind } from '../reading.js';

/** Default decision site for standalone category readings, never an approval. */
export const TOOL_PERMISSION_SAFETY_SITE = 'engine.gate.tool-permission-safety';

/** A permission category read from the call by Jev, and whether the reading was confident. */
export interface PermissionCategoryReading {
  readonly category: PermissionCategory;
  readonly confident: boolean;
}

/** Reads a tool call's permission category: its side-effect kind, mapped to a category. The reading screens the arguments once. */
export async function readPermissionCategory(
  toolName: string,
  args: Record<string, unknown>,
  site: string = TOOL_PERMISSION_SAFETY_SITE,
  signal?: AbortSignal,
): Promise<PermissionCategoryReading> {
  assertPermissionActive(signal);
  const reading = await awaitPermission(() => readSideEffectKind(toolName, args, site, signal), signal);
  return { category: categoryForSideEffectKind(reading.kind), confident: reading.confident };
}
