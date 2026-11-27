/**
 * caller-project.ts, the ONE check of the project a caller names (`workingDirectory` in a call's body, or the
 * `x-goodvibes-project` header a program sends with every request). Every door that takes a caller's project goes
 * through it: the daemon's method dispatch (daemon/control-plane.ts, for `capabilities.run`'s `callerOf`, the routed
 * Work methods, hosted sessions, places and every other method), and the web chat's creation
 * (companion/companion-chat-routes.ts `chatProjectOf`). A project a caller names is what path confinement, folder trust
 * and the rules "in this project" are read for, so it is never taken as given:
 *
 * - it is resolved to its real path and then to its project (`projectIdentityOf`), and both must pass;
 * - it is never `/`, never the home folder itself, never the GoodVibes or daemon home, anything inside one or any folder
 *   above one;
 * - it must be a registered workspace or inside one (the shared register is where the owner's trust decisions are kept
 *   too), unless the caller is the owner himself or his own program, by who it is (his sign-in, a device he paired, his
 *   registered terminal program, his Agent program, a turn the daemon hosts: `projectNamerOf`), whose every project is
 *   his; the operator token or the Agent's credential alone is a script. The folder the daemon was started in is no
 *   exception: the daemon's own working folder is in its home (`<daemon home>/own-folder`), which no project is, and the
 *   folder it was started from means nothing to it, so a device works there only once the owner registered it;
 * - any other caller (a paired device, a signed-in member) may name only a project the owner assigned to it
 *   (caller-projects-store.ts, set from the Devices place); with none assigned it names no project and acts on shared
 *   things only.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { projectIdentityOf, registeredWorkspaceRoots } from './project-identity.js';
import type { CredentialKind } from '@goodvibes/engine/daemon-api/http-policy';
import type { Actor } from '../daemon/http-policy.js';
import { ownersProgramCaller } from '../daemon/method-owner-decision.js';

/** The real path of `path`: of the file when it exists, else of its nearest existing folder with the rest after it. */
export function realPathOf(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(existing), ...[...rest].reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `path` is `root` or inside it (pass real paths). */
export function pathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Who names the project: the owner's own program on this machine, or another caller (a device, a member) by principal. */
export interface ProjectNamer {
  readonly ownersProgram: boolean;
  readonly principalId?: string | undefined;
  /**
   * A turn the daemon runs itself (a web chat's, a schedule's or a trigger's run, a Work step): it names exactly its own
   * project (the folder its turn works in) and no other; it is not the owner at large.
   */
  readonly turnProject?: string | undefined;
}

/** What the check reads: the homes it keeps out, the registered roots, a caller's assigned projects. */
export interface CallerProjectFacts {
  readonly homeDirectory: string;
  readonly goodVibesHome: string;
  readonly daemonHome: string;
  /** The registered workspace roots, read fresh. Absent: read from the shared register under the home. */
  readonly registeredRoots?: (() => readonly string[]) | undefined;
  /** The projects the owner assigned to this principal (real paths); empty when none. */
  readonly assignedProjects: (principalId: string) => readonly string[];
}

export type CallerProjectVerdict =
  | { readonly ok: true; readonly project: string }
  | { readonly ok: false; readonly reason: string };

const refused = (reason: string): CallerProjectVerdict => ({ ok: false, reason });

/**
 * Why a folder can never be a project, or undefined: the root, the home folder itself, anything in or above the
 * GoodVibes or daemon home. Read for the folder and for the project it belongs to. The one rule a caller's project and a
 * registered workspace (registration/store.ts) are both held to.
 */
export function whyNeverAProject(folder: string, facts: Pick<CallerProjectFacts, 'homeDirectory' | 'goodVibesHome' | 'daemonHome'>): string | undefined {
  const real = realPathOf(folder);
  return neverAProject(real, facts) ?? neverAProject(projectIdentityOf(real), facts);
}

/**
 * Why something that runs later (a trigger, a schedule, a watcher) may not be kept or run in `folder`, or undefined: it
 * names no project, or a folder that is never one (the daemon's own folder is inside its home). Nothing is ever run in
 * the daemon's own folder.
 */
export function noProjectRefusal(folder: string | undefined, facts: Pick<CallerProjectFacts, 'homeDirectory' | 'goodVibesHome' | 'daemonHome'>): string | undefined {
  if (folder === undefined || !folder.trim()) return 'it has no project';
  if (!isAbsolute(folder)) return `${folder} is not the full path of a project folder`;
  const never = whyNeverAProject(folder, facts);
  return never ? `${folder} is no project: ${never}` : undefined;
}

/** The facts {@link noProjectRefusal} reads, for a daemon home under `homeDirectory`. */
export function noProjectFacts(homeDirectory: string, daemonHome: string): Pick<CallerProjectFacts, 'homeDirectory' | 'goodVibesHome' | 'daemonHome'> {
  return { homeDirectory, goodVibesHome: join(homeDirectory, '.goodvibes'), daemonHome };
}

/** Why a real path may never be a project, or undefined. */
function neverAProject(path: string, facts: Pick<CallerProjectFacts, 'homeDirectory' | 'goodVibesHome' | 'daemonHome'>): string | undefined {
  if (dirname(path) === path) return 'the root of the file system is no project';
  if (path === realPathOf(facts.homeDirectory) || path === realPathOf(homedir())) return 'the home folder itself is no project';
  for (const [home, name] of [[facts.goodVibesHome, 'the GoodVibes home'], [facts.daemonHome, 'the daemon home']] as const) {
    const at = realPathOf(home);
    if (pathWithin(path, at) || pathWithin(at, path)) return `it holds or is inside ${name}, which is no project`;
  }
  return undefined;
}

/** The project a caller named, checked (see the file's comment): the project's real path, or why it is refused. */
export function checkCallerProject(raw: string, who: ProjectNamer, facts: CallerProjectFacts): CallerProjectVerdict {
  const named = raw.trim();
  if (!named || !isAbsolute(named) || named.includes('\0')) return refused(`${named || 'the folder named'} is not the absolute path of a project folder`);
  const real = realPathOf(named);
  const registered = facts.registeredRoots?.() ?? registeredWorkspaceRoots(facts.homeDirectory);
  const project = projectIdentityOf(real, registered);
  for (const path of [real, project]) {
    const never = neverAProject(path, facts);
    if (never) return refused(`${named} cannot be a project: ${never}`);
  }
  if (who.turnProject !== undefined) {
    const own = projectIdentityOf(realPathOf(who.turnProject), registered);
    return project === own ? { ok: true, project }
      : refused(`${named} is not this turn's own project (${own}): a turn the daemon runs works in its own project only`);
  }
  if (who.ownersProgram) return { ok: true, project };
  if (!registered.some((root) => pathWithin(project, realPathOf(root)))) {
    return refused(`${named} is not a registered workspace or inside one; the owner registers a folder before another caller may work in it`);
  }
  const assigned = who.principalId ? facts.assignedProjects(who.principalId).map(realPathOf) : [];
  if (!assigned.some((root) => pathWithin(project, root))) {
    return refused(assigned.length === 0
      ? `${named} is not a project the owner gave this caller, and it was given none: it acts on shared things only; the owner gives it a project in Devices and network, on its row ("Let a device or member work in a project")`
      : `${named} is not one of the projects the owner gave this caller (${assigned.join(', ')})`);
  }
  return { ok: true, project };
}

/**
 * Who names a project, for {@link checkCallerProject}: the owner's own program by WHO it is, never by the kind of
 * credential it holds (daemon/method-owner-decision.ts `ownersProgramCaller`: the owner himself, his sign-in, a device he
 * paired himself, his registered terminal program; his Agent program's model; a turn the daemon hosts), whose every
 * project is his without his giving it to himself. The operator token from a script or from another machine, and the
 * Agent's credential without its program, are scripts: like a member, an admin who is not the owner and every other
 * device, they name only the projects the owner gave them.
 */
export function projectNamerOf(caller: {
  readonly credentialKind?: CredentialKind | null | undefined;
  readonly actor?: Actor | undefined;
  readonly registration?: string | undefined;
  readonly principalId?: string | undefined;
  readonly daemonHosted?: boolean | undefined;
  /** The project of a turn the daemon runs itself, made in process (no credential): it names that project only. */
  readonly turnProject?: string | undefined;
}): ProjectNamer {
  if (caller.turnProject !== undefined) return { ownersProgram: false, principalId: caller.principalId, turnProject: caller.turnProject };
  const ownersProgram = ownersProgramCaller({ actor: caller.actor, credentialKind: caller.credentialKind ?? undefined,
    registration: caller.registration, daemonHosted: caller.daemonHosted });
  return { ownersProgram, principalId: caller.principalId };
}
