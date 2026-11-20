import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import type { MemoryClass, MemoryReviewState, MemoryScope } from '@goodvibes/engine/platform/platform/state';
import { memoryRecordTemporalStatus } from '@goodvibes/engine/platform/platform/state';

export const VALID_CLASSES: MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
export const VALID_SCOPES: MemoryScope[] = ['session', 'project', 'team'];
export const VALID_REVIEW_STATES: MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

export function isValidClass(s: string): s is MemoryClass {
  return VALID_CLASSES.includes(s as MemoryClass);
}

export function isValidScope(s: string): s is MemoryScope {
  return VALID_SCOPES.includes(s as MemoryScope);
}

export function isValidReviewState(s: string): s is MemoryReviewState {
  return VALID_REVIEW_STATES.includes(s as MemoryReviewState);
}

export function resolveBundlePath(pathArg: string, shellPaths: Pick<ShellPathService, 'resolveWorkspacePath'>): string {
  return shellPaths.resolveWorkspacePath(pathArg);
}

/**
 * The bundle path for a model-run command stays inside the workspace: a model
 * (or text that persuaded it) must not choose where a file is written or read.
 * An owner-typed command may name any path. Undefined means refused.
 */
export function resolveConfinedBundlePath(
  pathArg: string,
  shellPaths: Pick<ShellPathService, 'resolveWorkspacePath' | 'isWithinWorkingDirectory'>,
  invokedByModel: boolean | undefined,
): string | undefined {
  const resolved = resolveBundlePath(pathArg, shellPaths);
  if (invokedByModel === true && !shellPaths.isWithinWorkingDirectory(resolved)) return undefined;
  return resolved;
}

/**
 * Compact inline label for a record's temporal validity window, appended
 * wherever `/memory` lists records, so an out-of-window record is visibly
 * `[pending]`/`[expired]` rather than silently indistinguishable from an
 * always-valid one. Empty string for 'active' (the common case; no window,
 * or currently inside it) so normal listings stay unnoisy.
 */
export function temporalStatusLabel(record: { validFrom?: number | undefined; validUntil?: number | undefined }, now?: number): string {
  const status = memoryRecordTemporalStatus(record, now);
  return status === 'active' ? '' : ` [${status}]`;
}
