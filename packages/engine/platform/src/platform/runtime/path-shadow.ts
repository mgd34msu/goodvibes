/**
 * path-shadow.ts, decide whether the copy of a command the updater maintains
 * is actually the copy the user's shell runs.
 *
 * The platform's update guarantee is "one verified swap mechanism, nothing
 * ever drifts". That guarantee holds only while there is exactly one copy of
 * each command reachable on PATH. When a second, older copy sits in a
 * directory that comes EARLIER on PATH than the install directory, the
 * updater keeps upgrading a file the user never reaches: `goodvibes-agent`
 * reports itself current, an older build answers the typing, and the product
 * looks like it is lying about its own capabilities. That is exactly what
 * happened with a leftover `~/.bun/bin/goodvibes-agent` link (1.18.1) sitting
 * at PATH position 2 while `~/.local/bin/goodvibes-agent` (1.21.0) sat at
 * position 21.
 *
 * This module is the one place that decides those facts. It is pure: every
 * filesystem and subprocess touch (does this file exist and is it runnable,
 * where does this symlink actually point, what does `<path> --version` say)
 * is injected, so the policy is provable under test with fake paths and no
 * real install. The surfaces wire the real I/O:
 *   - a client's startup check reports a shadow before anything else renders;
 *   - the installer's shell implementation (goodvibes-daemon scripts/install.sh)
 *     mirrors these same rules in POSIX sh, because an installer cannot
 *     import TypeScript.
 *
 * Removal is deliberately conservative. A copy is only ever offered for
 * removal when it is recognisably one of OUR programs, a link into an
 * installed exact historical product package, or a file that answers
 * `--version` with `<command> <semver>`, and only when it lives inside the
 * user's own home directory. Everything else is reported and left alone.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How confident we are that a copy found on PATH is one of our own programs,
 * and therefore whether it is safe to offer to remove it.
 *
 *   - `install-target`: the copy living in the directory the installer and
 *     the auto-updater maintain. Never a removal candidate.
 *   - `package-link`: an entry that resolves into an installed
 *     exact historical product package, with affirmative global-manager
 *     ownership and a matching version. Local dependencies remain untouched.
 *   - `our-binary`: a standalone file that answers `--version` with
 *     `<command> <semver>`, i.e. a previous standalone install of the same
 *     program. Removed by deleting the file.
 *   - `unknown`: anything we cannot positively identify, including anything
 *     outside the user's home directory. Reported, never removed.
 */
export type ShadowOwnership = 'install-target' | 'package-link' | 'our-binary' | 'unknown';

/** How a recognised copy is removed, and by what command. */
export interface ShadowRemoval {
  /** `package` = uninstall the owning package; `file` = delete the PATH entry itself. */
  readonly kind: 'package' | 'file';
  /** The exact historical package name, when `kind` is `package`. */
  readonly packageName?: string | undefined;
  /** The exact command a user (or the installer) runs to remove this copy. */
  readonly command: string;
}

/** One copy of a command found on PATH. */
export interface CommandCopy {
  /** The command name, e.g. `goodvibes-agent`. */
  readonly command: string;
  /** The PATH directory the copy was found in. */
  readonly directory: string;
  /** `<directory>/<command>`, the path the shell would execute. */
  readonly path: string;
  /** Zero-based position of `directory` in PATH. Lower wins. */
  readonly pathIndex: number;
  /** The symlink-resolved path, or `path` when it is not a link. */
  readonly resolvedPath: string;
  /** What `<path> --version` reported, when it could be probed. */
  readonly version?: string | undefined;
  readonly ownership: ShadowOwnership;
  /** Present only when `ownership` is `package-link` or `our-binary`. */
  readonly removal?: ShadowRemoval | undefined;
}

/** The reachability verdict for one command. */
export interface CommandShadowReport {
  readonly command: string;
  /** Every copy found, in PATH order. */
  readonly copies: readonly CommandCopy[];
  /** The copy the shell actually runs, the first on PATH. Absent when the command is not on PATH at all. */
  readonly winner?: CommandCopy | undefined;
  /** The copy in the install directory. Absent when the install directory is not on PATH. */
  readonly installed?: CommandCopy | undefined;
  /**
   * Copies that come earlier on PATH than the install directory's copy. A
   * non-empty list means the maintained install is unreachable by name.
   */
  readonly shadowing: readonly CommandCopy[];
  /** True when the install directory holds this command but is not on PATH at all. */
  readonly installDirNotOnPath: boolean;
}

/** The whole-install verdict across every command the installer maintains. */
export interface ShadowScanResult {
  readonly reports: readonly CommandShadowReport[];
  /** Commands whose maintained copy loses to an earlier PATH entry. */
  readonly shadowed: readonly CommandShadowReport[];
  /** True when any command is shadowed or the install directory is missing from PATH. */
  readonly hasProblem: boolean;
}

/** Affirmative host observation of the selected manager's actual global install. */
export type GlobalPackageOwner =
  | { readonly manager: 'bun'; readonly root: string; readonly bin: string }
  | { readonly manager: 'npm'; readonly root: string; readonly prefix: string };

/** Quotes a single POSIX shell argument for display; never execute this text. */
export function quoteShadowArgument(value: string): string {
  if (/^[A-Za-z0-9_./@:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ShadowScanInput {
  /** Command names the installer/updater maintains, e.g. `['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']`. */
  readonly commands: readonly string[];
  /** The directory the installer writes to and the auto-updater swaps in place. */
  readonly installDir: string;
  /** PATH split into directories, in order, exactly as the shell would search them. */
  readonly pathEntries: readonly string[];
  /** The user's home directory. Nothing outside it is ever a removal candidate. */
  readonly homeDir: string;
  /** True when `path` exists and is a runnable file. */
  readonly isExecutableFile: (path: string) => boolean;
  /** Resolves the actual existing path; throws when resolution fails. */
  readonly realPath: (path: string) => string;
  /**
   * Runs `<path> --version` and returns its first line, or undefined when it
   * cannot be run. Optional: without it, `our-binary` can never be
   * established and such copies stay `unknown` (reported, never removed).
   */
  readonly probeVersion?: ((path: string) => string | undefined) | undefined;
  /** Called lazily only for a version-matched exact historical product package. */
  readonly globalPackageOwner?: ((packageName: string, packageRoot: string) => GlobalPackageOwner | undefined) | undefined;
}

// ---------------------------------------------------------------------------
// PATH handling
// ---------------------------------------------------------------------------

/**
 * Splits a raw PATH string into directories in search order.
 *
 * Empty entries (from a leading, trailing, or doubled separator) mean "the
 * current directory" to a POSIX shell. They are dropped rather than resolved:
 * a cwd-relative hit is not a stable install anyone can reason about, and
 * treating it as one would produce a different verdict per directory.
 * Duplicated directories collapse to their first occurrence, which is the
 * only position that can ever win.
 */
export function splitPathEntries(rawPath: string | undefined, separator = ':'): string[] {
  if (!rawPath) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of rawPath.split(separator)) {
    const entry = raw;
    if (entry.length === 0) continue;
    const normalized = stripTrailingSeparators(entry);
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries;
}

/** Drops trailing `/` (or `\`) so `~/.local/bin` and `~/.local/bin/` are one directory. */
function stripTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1;
  return value.slice(0, end);
}

function joinPath(directory: string, name: string): string {
  return `${stripTrailingSeparators(directory)}/${name}`;
}

function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/).filter((segment) => segment.length > 0);
}

/** True when `path` is `root` itself or lives underneath it. */
export function isWithinDirectory(path: string, root: string): boolean {
  const normalizedRoot = stripTrailingSeparators(root);
  if (normalizedRoot.length === 0) return false;
  if (segmentsOf(path).some((part) => part === '..' || part === '.')
    || segmentsOf(root).some((part) => part === '..' || part === '.')) return false;
  const normalizedPath = stripTrailingSeparators(path);
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

/** Existing published product packages accepted solely for old-install cleanup. */
const HISTORICAL_COMMANDS: Readonly<Record<string, string>> = {
  '@pellux/goodvibes-tui': 'goodvibes',
  '@pellux/goodvibes-agent': 'goodvibes-agent',
  '@pellux/goodvibes-daemon': 'goodvibes-daemon',
};

function packageLocation(path: string): { name: string; root: string } | undefined {
  const marker = '/node_modules/';
  const at = path.lastIndexOf(marker);
  if (at < 0) return undefined;
  const tail = path.slice(at + marker.length).split('/');
  const count = tail[0]?.startsWith('@') ? 2 : 1;
  const name = tail.slice(0, count).join('/');
  return { name, root: path.slice(0, at + marker.length) + name };
}

/** The innermost exact historical package, never a prefix match. */
export function owningPackageName(resolvedPath: string): string | undefined {
  const location = packageLocation(resolvedPath);
  return location && Object.hasOwn(HISTORICAL_COMMANDS, location.name) ? location.name : undefined;
}

function packageRemoval(input: ShadowScanInput, packageName: string, root: string): ShadowRemoval | undefined {
  const owner = input.globalPackageOwner?.(packageName, root);
  if (!owner || !isWithinDirectory(owner.root, input.homeDir) || root !== `${stripTrailingSeparators(owner.root)}/${packageName}`) return undefined;
  if (owner.manager === 'bun') {
    if (!owner.root.endsWith('/node_modules') || !isWithinDirectory(owner.bin, input.homeDir)) return undefined;
    return { kind: 'package', packageName, command: `BUN_INSTALL_GLOBAL_DIR=${quoteShadowArgument(owner.root.slice(0, -'/node_modules'.length))} BUN_INSTALL_BIN=${quoteShadowArgument(owner.bin)} bun remove -g --ignore-scripts ${quoteShadowArgument(packageName)}` };
  }
  if (!isWithinDirectory(owner.prefix, input.homeDir)) return undefined;
  return { kind: 'package', packageName, command: `npm --prefix ${quoteShadowArgument(owner.prefix)} rm -g --ignore-scripts ${quoteShadowArgument(packageName)}` };
}

/**
 * True when a `--version` line is one of ours: `<command> <dotted numbers>`,
 * which is the exact shape every goodvibes command prints. Anything else,
 * an unrelated program that happens to share the name, a wrapper script, a
 * `--version` that errors, fails, and the copy stays `unknown`.
 */
export function versionLineIdentifiesCommand(line: string | undefined, command: string): string | undefined {
  if (!line) return undefined;
  const match = /^([A-Za-z0-9._-]+)[ \t]+v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(line.trim());
  if (!match) return undefined;
  if (match[1] !== command) return undefined;
  return match[2];
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

function classify(input: ShadowScanInput, copy: {
  readonly command: string;
  readonly directory: string;
  readonly path: string;
  readonly pathIndex: number;
  readonly resolvedPath: string;
}): { ownership: ShadowOwnership; removal?: ShadowRemoval | undefined; version?: string | undefined } {
  if (copy.path === joinPath(input.installDir, copy.command)) {
    return { ownership: 'install-target', version: probe(input, copy.path, copy.command) };
  }
  if (!copy.resolvedPath || /[\x00-\x1f\x7f]/.test(copy.path + copy.resolvedPath)) return { ownership: 'unknown' };
  // A different PATH spelling of the maintained file must never suggest deletion.
  if (copy.resolvedPath === resolve(input, joinPath(input.installDir, copy.command))) return { ownership: 'install-target', version: probe(input, copy.path, copy.command) };
  const insideHome = isWithinDirectory(copy.path, input.homeDir) && isWithinDirectory(copy.resolvedPath, input.homeDir);
  const location = packageLocation(copy.resolvedPath);
  if (location && HISTORICAL_COMMANDS[location.name] !== copy.command) return { ownership: 'unknown' };
  const version = probe(input, copy.path, copy.command);
  if (!insideHome || version === undefined) return { ownership: 'unknown', version };
  if (location) {
    try {
      const removal = packageRemoval(input, location.name, location.root);
      return removal ? { ownership: 'package-link', removal, version } : { ownership: 'unknown', version };
    } catch { return { ownership: 'unknown', version }; }
  }
  return { ownership: 'our-binary', removal: { kind: 'file', command: `rm -- ${quoteShadowArgument(copy.path)}` }, version };
}

function probe(input: ShadowScanInput, path: string, command: string): string | undefined {
  if (!input.probeVersion) return undefined;
  try {
    return versionLineIdentifiesCommand(input.probeVersion(path), command);
  } catch {
    return undefined;
  }
}

function resolve(input: ShadowScanInput, path: string): string {
  try {
    return input.realPath(path);
  } catch {
    return '';
  }
}

function exists(input: ShadowScanInput, path: string): boolean {
  try {
    return input.isExecutableFile(path);
  } catch {
    return false;
  }
}

/** Scans PATH for every copy of every maintained command and decides which one wins. */
export function scanCommandShadows(input: ShadowScanInput): ShadowScanResult {
  input = { ...input, commands: [...input.commands], pathEntries: [...input.pathEntries] };
  const entries = input.pathEntries.map(stripTrailingSeparators).filter((entry) => entry.length > 0);
  const installDir = stripTrailingSeparators(input.installDir);
  const installDirOnPath = entries.some((entry) => entry === installDir);

  const reports: CommandShadowReport[] = [];
  for (const command of input.commands) {
    const copies: CommandCopy[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const directory = entries[index] as string;
      const path = joinPath(directory, command);
      if (!exists(input, path)) continue;
      const resolvedPath = resolve(input, path);
      const partial = { command, directory, path, pathIndex: index, resolvedPath };
      copies.push({ ...partial, ...classify(input, partial) });
    }

    const installedOnPath = copies.find((copy) => copy.ownership === 'install-target');
    // The install directory may hold the command while being absent from
    // PATH; that install is just as unreachable as a shadowed one.
    const installedOffPath = !installDirOnPath && exists(input, joinPath(installDir, command));

    const shadowing = installedOnPath
      ? copies.filter((copy) => copy.pathIndex < installedOnPath.pathIndex)
      : [];

    reports.push({
      command,
      copies,
      winner: copies[0],
      installed: installedOnPath,
      shadowing,
      installDirNotOnPath: installedOffPath,
    });
  }

  const shadowed = reports.filter((report) => report.shadowing.length > 0 || report.installDirNotOnPath);
  return { reports, shadowed, hasProblem: shadowed.length > 0 };
}

// ---------------------------------------------------------------------------
// Plain-words reporting
// ---------------------------------------------------------------------------

function describeVersion(copy: CommandCopy): string {
  return copy.version ? `version ${copy.version}` : 'version unknown';
}

/**
 * Renders one shadowed command as plain lines: which path wins, what version
 * each copy is, and the exact command that fixes it. No jargon, no severity
 * words, the user needs to know which file answers when they type the name.
 */
export function describeShadowReport(report: CommandShadowReport): string[] {
  const lines: string[] = [];
  if (report.installDirNotOnPath) {
    lines.push(
      `${report.command} is installed but its directory is not on your PATH, so typing "${report.command}" does not reach it.`,
    );
    return lines;
  }
  const winner = report.winner;
  const installed = report.installed;
  if (!winner || !installed) return lines;

  lines.push(
    `Typing "${report.command}" runs ${winner.path} (${describeVersion(winner)}), `
    + `not the copy this installer maintains at ${installed.path} (${describeVersion(installed)}).`,
  );
  for (const copy of report.shadowing) {
    if (copy.removal) {
      lines.push(`  ${copy.path} is a copy of our own program. Remove it with: ${copy.removal.command}`);
    } else {
      lines.push(
        `  ${copy.path} is not something we can identify as ours, so it will not be touched. `
        + `Remove or reorder it yourself, or put ${installed.directory} earlier on your PATH.`,
      );
    }
  }
  return lines;
}

/** Renders every problem in a scan, in command order. Empty when the scan is clean. */
export function describeShadowScan(result: ShadowScanResult): string[] {
  return result.shadowed.flatMap((report) => describeShadowReport(report));
}

/**
 * The copies a caller may offer to remove: recognised copies of our own
 * program that are shadowing the maintained install. Deduplicated by path,
 * since one leftover package install typically provides several commands.
 */
export function removableShadows(result: ShadowScanResult): CommandCopy[] {
  const byPath = new Map<string, CommandCopy>();
  for (const report of result.shadowed) {
    for (const copy of report.shadowing) {
      if (!copy.removal) continue;
      if (!byPath.has(copy.path)) byPath.set(copy.path, copy);
    }
  }
  return [...byPath.values()];
}
