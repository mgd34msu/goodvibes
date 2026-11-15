/**
 * skills/roots.ts
 *
 * Where skills live. Every reader of skills (the daemon's skills.* verbs, the terminal
 * apps' discovery, the TUI Skills modal) takes its directories from `resolveSkillRoots`,
 * so a skill one of them sees is a skill all of them see.
 *
 * Search order, first match of a name wins:
 *   1. `<project>/.goodvibes/skills`
 *   2. `<project>/.goodvibes/<surface>/skills`
 *   3. `~/.goodvibes/skills`
 *   4. `~/.goodvibes/<surface>/skills`
 *
 * Inside each directory a skill is either a flat `<name>.md` document or a folder
 * holding `SKILL.md` (the folder may carry the skill's supporting files).
 */

import { join, resolve } from 'node:path';

/** Where a skill was found: the project, the user's home, or a caller-supplied directory. */
export type SkillOrigin = 'project-local' | 'global' | 'custom';

/** One directory searched for skills, with the origin its skills report. */
export interface SkillRoot {
  readonly directory: string;
  readonly origin: SkillOrigin;
}

/** The directories skill roots are resolved from. Without a working directory there are no project roots. */
export interface SkillRootPaths {
  readonly workingDirectory?: string | undefined;
  readonly homeDirectory: string;
}

/**
 * The skill directories for one product surface, in search order. When the working
 * directory is the home directory, each directory is listed once, as the project's.
 */
export function resolveSkillRoots(paths: SkillRootPaths, surfaceRoot: string): SkillRoot[] {
  const projectRoots: SkillRoot[] = paths.workingDirectory === undefined ? [] : [
    { directory: resolve(join(paths.workingDirectory, '.goodvibes', 'skills')), origin: 'project-local' },
    { directory: resolve(join(paths.workingDirectory, '.goodvibes', surfaceRoot, 'skills')), origin: 'project-local' },
  ];
  const projectDirectories = new Set(projectRoots.map((root) => root.directory));
  const globalRoots: SkillRoot[] = [
    { directory: resolve(join(paths.homeDirectory, '.goodvibes', 'skills')), origin: 'global' },
    { directory: resolve(join(paths.homeDirectory, '.goodvibes', surfaceRoot, 'skills')), origin: 'global' },
  ];
  return [...projectRoots, ...globalRoots.filter((root) => !projectDirectories.has(root.directory))];
}

/** Project skills first, then by name: the order every skill list is shown in. */
export function compareSkillsByOrigin(
  left: { readonly origin?: string | undefined; readonly name: string },
  right: { readonly origin?: string | undefined; readonly name: string },
): number {
  const originRank = left.origin === right.origin ? 0 : left.origin === 'project-local' ? -1 : right.origin === 'project-local' ? 1 : 0;
  return originRank || left.name.localeCompare(right.name);
}
