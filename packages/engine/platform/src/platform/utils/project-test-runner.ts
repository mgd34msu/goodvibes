import { shellSplit } from './shell-split.js';

/** Read declared literal runner commands; custom scripts and compound shells remain unresolved. */
export function declaredTestRunner(manifest: Record<string, unknown>): string | undefined {
  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return undefined;
  const commands = scripts as Record<string, unknown>;
  const seen = new Set<string>();
  const read = (name: string): string | undefined => {
    if (seen.has(name) || seen.size >= 8) return undefined;
    seen.add(name);
    const script = commands[name];
    if (typeof script !== 'string' || /[;&|<>`$\n\r]/.test(script)) return undefined;
    // Quoting only groups literal words. An incomplete quote is not a declaration.
    let quote = '';
    for (let i = 0; i < script.length; i++) {
      const c = script[i]!;
      if (c === '\\' && quote !== "'") { i++; if (i === script.length) return undefined; continue; }
      if (c === quote) quote = '';
      else if (!quote && (c === "'" || c === '"')) quote = c;
    }
    if (quote) return undefined;
    const words = shellSplit(script);
    const assignments = () => { while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift(); };
    assignments();
    if (words[0] === 'env' || words[0] === 'cross-env') { words.shift(); assignments(); }
    if (words[0] === 'npx' || words[0] === 'bunx') {
      words.shift();
      if (['--no-install', '--yes', '-y'].includes(words[0] ?? '')) words.shift();
    } else if ((words[0] === 'pnpm' || words[0] === 'yarn') && words[1] === 'exec') words.splice(0, 2);
    const command = words[0]?.replace(/^\.\/node_modules\/\.bin\//, '');
    if (['jest', 'vitest', 'mocha', 'ava'].includes(command ?? '')) return command;
    if (command === 'playwright' && words[1] === 'test') return 'playwright';
    if (command === 'cypress' && (words[1] === 'run' || words[1] === 'open')) return 'cypress';
    if (command === 'node' && words[1] === '--test') return 'node:test';
    if (command === 'bun' && words[1] === 'test') return 'bun:test';
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(command ?? '')) {
      const target = words[1] === 'run' || words[1] === 'run-script' ? words[2] : words[1];
      if (target && Object.hasOwn(commands, target)) return read(target);
    }
    return undefined;
  };
  return read('test');
}

export type DeclaredPackageManager = 'npm' | 'bun' | 'yarn' | 'pnpm';

/** Lockfiles and the one package manager that writes each. */
export const PACKAGE_MANAGER_LOCKFILES: ReadonlyArray<readonly [file: string, manager: DeclaredPackageManager]> = [
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
];

export const isDeclaredPackageManager = (value: string): value is DeclaredPackageManager =>
  value === 'npm' || value === 'bun' || value === 'yarn' || value === 'pnpm';

/**
 * The package manager a project declares: the package.json `packageManager`
 * field (corepack), else the only manager among the lockfiles present.
 * Undefined when the facts leave it open (none, or several lockfiles).
 */
export function declaredPackageManager(manifest: Record<string, unknown>, lockfilesPresent: readonly string[]): DeclaredPackageManager | undefined {
  const field = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined;
  if (field !== undefined && isDeclaredPackageManager(field)) return field;
  const managers = [...new Set(PACKAGE_MANAGER_LOCKFILES.filter(([file]) => lockfilesPresent.includes(file)).map(([, manager]) => manager))];
  return managers.length === 1 ? managers[0] : undefined;
}
