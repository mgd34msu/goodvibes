/**
 * Where work may run on this daemon: the one answer every way of starting an
 * agent in a folder asks (a hosted session, contract work dispatched into one).
 *
 * The allowed roots are the daemon's own working directory and every workspace
 * registered with it (`workspaces.registrations.*`). A path is allowed when it
 * is one of them or lies inside one, with symlinks resolved so a link inside a
 * root cannot lead out of it.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readWorkspaceRegisterSync } from '../workspace/registration/store.js';

/** The real path of `path`, or of its nearest existing ancestor with the rest appended. */
export function canonicalWorkspacePath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** The allowed root that contains `path`, or undefined when none does. */
export function allowedRootFor(path: string, roots: readonly string[]): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const candidate = canonicalWorkspacePath(path);
  return roots.find((root) => {
    const fromRoot = relative(canonicalWorkspacePath(root), candidate);
    return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
  });
}

/**
 * The daemon's working directory plus every registered workspace root, in that
 * order, without duplicates. One small file read per call: a session create, or
 * the New menu asking which folders it can offer.
 */
export function allowedWorkspaceRoots(workingDirectory: string, registerPath: string): readonly string[] {
  const roots = [workingDirectory];
  const register = readWorkspaceRegisterSync(registerPath);
  if (register.state === 'ok') for (const row of register.workspaces) roots.push(row.root);
  return [...new Set(roots)];
}

/** The refusal for a folder outside every allowed root, naming them and how to add one. */
export function outsideAllowedRootsMessage(path: string, roots: readonly string[]): string {
  return `'${path}' is outside the folders this daemon runs work in (${roots.join(', ')}). `
    + 'Pick one of them, or register the project first with workspaces.registrations.add (or by opening it in the terminal app).';
}
