/**
 * skills/roots.ts
 *
 * Where skills live. Every reader of skills (the daemon's skills.* verbs, the terminal
 * apps' discovery, the TUI Skills modal, a typed /<skill>, the model's registry tool)
 * takes its directories from `resolveSkillRoots`, so a skill one of them sees is a skill
 * all of them see.
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

/** The directories skill roots are resolved from. Without a working directory there are no project roots; without a home directory, no global ones. */
export interface SkillRootPaths {
  readonly workingDirectory?: string | undefined;
  readonly homeDirectory?: string | undefined;
}

/**
 * The skill directories for one product surface, in search order. When the working
 * directory is the home directory, each directory is listed once, as the project's.
 */
export function resolveSkillRoots(paths: SkillRootPaths, surfaceRoot: string): SkillRoot[] {
  const owners: Array<readonly [string | undefined, SkillOrigin]> = [[paths.workingDirectory, 'project-local'], [paths.homeDirectory, 'global']];
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();
  for (const [owner, origin] of owners) {
    if (owner === undefined) continue;
    // An empty surface root names no surface folder; the shared folder is listed once.
    const directories = [join(owner, '.goodvibes', 'skills'), ...(surfaceRoot.trim() ? [join(owner, '.goodvibes', surfaceRoot, 'skills')] : [])];
    for (const directory of directories.map((entry) => resolve(entry))) {
      if (seen.has(directory)) continue;
      seen.add(directory);
      roots.push({ directory, origin });
    }
  }
  return roots;
}

/** Project skills first, then by name: the order every skill list is shown in. */
export function compareSkillsByOrigin(
  left: { readonly origin?: string | undefined; readonly name: string },
  right: { readonly origin?: string | undefined; readonly name: string },
): number {
  const originRank = left.origin === right.origin ? 0 : left.origin === 'project-local' ? -1 : right.origin === 'project-local' ? 1 : 0;
  return originRank || left.name.localeCompare(right.name);
}
