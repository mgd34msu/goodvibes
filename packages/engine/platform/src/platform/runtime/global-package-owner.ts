/** Read-only manager discovery, called only for an already identified shadow.
 * No path spelling (.bun/node_modules) establishes global ownership. Commands
 * are bounded and must succeed. Returned roots are actual canonical directories;
 * remediation names that captured manager scope explicitly, not its next default.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { GlobalPackageOwner } from './path-shadow.js';

export function discoverGlobalPackageOwner(
  packageName: string,
  packageRoot: string,
  run: (program: string, args: readonly string[]) => string | undefined = managerOutput,
  realPath: (path: string) => string = realpathSync,
): GlobalPackageOwner | undefined {
  const canonical = (path: string | undefined): string | undefined => {
    if (!path || /[\x00-\x1f\x7f]/.test(path) || !path.startsWith('/')) return undefined;
    try { return realPath(path); } catch { return undefined; }
  };
  const npmRoot = canonical(run('npm', ['root', '--global']));
  const npmPrefix = npmRoot && packageRoot === join(npmRoot, packageName)
    ? canonical(run('npm', ['prefix', '--global'])) : undefined;
  // Both observations must describe the same selected npm global context.
  if (npmRoot && npmPrefix && npmRoot === canonical(join(npmPrefix, 'lib', 'node_modules'))
    && packageRoot === join(npmRoot, packageName)) return { manager: 'npm', root: npmRoot, prefix: npmPrefix };
  const listing = run('bun', ['pm', 'ls', '-g']);
  const first = listing?.split('\n')[0];
  const match = first && /^(.*) node_modules \(\d+ installed\)$/.exec(first);
  const project = canonical(match?.[1]);
  const bin = project && packageRoot === join(project, 'node_modules', packageName)
    ? canonical(run('bun', ['pm', 'bin', '-g'])) : undefined;
  if (project && bin && packageRoot === join(project, 'node_modules', packageName)) {
    return { manager: 'bun', root: join(project, 'node_modules'), bin };
  }
  return undefined;
}

/** One startup scan shares read-only manager observations across its commands. */
export function createGlobalPackageOwnerResolver(): (name: string, root: string) => GlobalPackageOwner | undefined {
  const observations = new Map<string, string | undefined>();
  return (name, root) => discoverGlobalPackageOwner(name, root, (program, args) => {
    const key = [program, ...args].join('\0');
    if (!observations.has(key)) observations.set(key, managerOutput(program, args));
    return observations.get(key);
  });
}

function managerOutput(program: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync(program, [...args], { encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    return !result.error && result.status === 0 && result.signal === null ? result.stdout.replace(/\r?\n$/, '') : undefined;
  } catch { return undefined; }
}
