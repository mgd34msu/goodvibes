import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface ShellPathService {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly projectGoodVibesRoot: string;
  readonly userGoodVibesRoot: string;
  expandHomePath(path: string): string;
  resolveWorkspacePath(path: string): string;
  resolveProjectPath(...segments: string[]): string;
  resolveUserPath(...segments: string[]): string;
  isWithinWorkingDirectory(path: string): boolean;
}

export interface CreateShellPathServiceOptions {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

function requireAbsoluteOwnedRoot(path: string, name: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`ShellPathService ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`ShellPathService ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

/**
 * The physical location of `path`: the deepest part of it that exists, with
 * every link in that part resolved, followed by the parts that do not exist yet.
 */
function physicalPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `path` (absolute) lies inside `root` once links are followed: a link
 * inside the root that points outside it is outside. This is the one
 * containment test for paths a model-run command names. Cost: one `realpath`
 * of the path's deepest existing ancestor, plus the root's.
 */
export function isPathWithinRoot(root: string, path: string): boolean {
  const physicalRoot = physicalPath(resolve(root));
  const resolved = physicalPath(resolve(path));
  const prefix = physicalRoot.endsWith('/') ? physicalRoot : `${physicalRoot}/`;
  return resolved === physicalRoot || resolved.startsWith(prefix);
}

export function createShellPathService(
  options: CreateShellPathServiceOptions,
): ShellPathService {
  const workingDirectory = requireAbsoluteOwnedRoot(options.workingDirectory, 'workingDirectory');
  const homeDirectory = requireAbsoluteOwnedRoot(options.homeDirectory, 'homeDirectory');
  const projectGoodVibesRoot = join(workingDirectory, '.goodvibes');
  const userGoodVibesRoot = join(homeDirectory, '.goodvibes');

  const expandHomePath = (path: string): string => {
    if (path === '~') return homeDirectory;
    if (path.startsWith('~/')) {
      return join(homeDirectory, path.slice(2));
    }
    return path;
  };

  const resolveWorkspacePath = (path: string): string => {
    const normalized = expandHomePath(path);
    return resolve(workingDirectory, normalized);
  };

  const isWithinWorkingDirectory = (path: string): boolean => isPathWithinRoot(workingDirectory, resolveWorkspacePath(path));

  return {
    workingDirectory,
    homeDirectory,
    projectGoodVibesRoot,
    userGoodVibesRoot,
    expandHomePath,
    resolveWorkspacePath,
    resolveProjectPath: (...segments) => join(projectGoodVibesRoot, ...segments),
    resolveUserPath: (...segments) => join(userGoodVibesRoot, ...segments),
    isWithinWorkingDirectory,
  };
}
