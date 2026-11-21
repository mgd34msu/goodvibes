import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';

/**
 * Where a terminal product keeps its native work journals: the one rule the
 * interactive host and the headless command both read, so an admission made by
 * either is seen by `/work intake-status` in the other.
 */

/** The native work submission journal under a product's surface root (`tui` or `agent`). */
export function nativeSubmissionJournalPath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>, surfaceRoot: string): string {
  return shellPaths.resolveUserPath(surfaceRoot, 'native-work-submission.json');
}

/** The conversation intake journal kept beside a submission journal. */
export function intakeJournalPathFor(submissionJournalPath: string): string {
  return `${submissionJournalPath}.intake`;
}

/** The native conversation intake journal under a product's surface root. */
export function nativeIntakeJournalPath(shellPaths: Pick<ShellPathService, 'resolveUserPath'>, surfaceRoot: string): string {
  return intakeJournalPathFor(nativeSubmissionJournalPath(shellPaths, surfaceRoot));
}
