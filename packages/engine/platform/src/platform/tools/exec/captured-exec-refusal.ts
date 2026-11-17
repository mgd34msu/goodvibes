/**
 * Why a captured run's file changes were not applied, in a shape the result
 * can report: what kind of refusal, which path, and a sentence naming both.
 *
 * - `conflict`: the path was changed in the project by someone else during the run.
 * - `alias`: the run left a symlink, hard link or special file there.
 * - `reserved`: the run wrote inside a directory captured runs never publish.
 * - `authority`: the owner's read authority or the projection itself changed.
 */
export type CapturedRefusalKind = 'conflict' | 'alias' | 'reserved' | 'authority';

export class CapturedBoundaryRefusal extends Error {
  constructor(
    readonly kind: CapturedRefusalKind,
    /** The project-relative path the refusal is about (absolute only for a projection-level refusal). */
    readonly path: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'CapturedBoundaryRefusal';
  }
}

/** The text a captured exec result reports for a refusal: the state, the reason and the next step. */
export function capturedRefusalText(refusal: CapturedBoundaryRefusal, published: boolean, outputKept: boolean): string {
  const state = published ? 'some file changes were applied before this was found' : 'no file changes were applied';
  const output = outputKept ? " The command's output is kept." : '';
  switch (refusal.kind) {
    case 'conflict':
      return `Captured exec not applied: ${refusal.message}; ${state}.${output} Read ${refusal.path} again, then rerun if the change is still needed.`;
    case 'alias':
      return `Captured exec not applied: ${refusal.message}; ${state}.${output} Captured runs publish regular files and directories only, so a rerun of the same command is refused the same way: change it to leave a regular file at ${refusal.path}, or remove it before the command ends.`;
    case 'reserved':
      return `Captured exec not applied: ${refusal.message}; ${state}.${output} Write to project or artifact paths outside that directory instead.`;
    case 'authority':
      return `Captured exec held: ${refusal.message}; output withheld, ${state}. Re-read the files you rely on, then rerun if still needed.`;
  }
}
