/**
 * The owner's read rules as bubblewrap mount masks over a tree a captured
 * command sees by mount (the member worktree, the project's dependencies).
 * One pass over the tree per evaluation: a denied or reserved directory is
 * covered by an empty tmpfs and not descended into; a denied or reserved file
 * or a special file is covered by /dev/null. Symlinks are left as they are:
 * the read filter judges where a link lands, and a landing inside a mounted
 * tree is masked at its own path, while one outside it is not mounted at all.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { checkCapturedInputsInBatches } from './captured-exec-validation.js';

/** May this entry be shown? Called with the entry's path relative to the tree. */
export type CapturedMaskDecision = (relativePath: string, signal: AbortSignal) => Promise<boolean>;

export interface CapturedMasks {
  /** bwrap arguments, in mount order, that hide what the command may not read. */
  readonly argv: readonly string[];
  /** Relative paths that were hidden (directories end with `/`). */
  readonly hidden: readonly string[];
}

const RESERVED: ReadonlySet<string> = new Set(CONTRACT_INPUT_EXCLUSIONS);

/**
 * Walk `sourceRoot` and return the masks for its image mounted at `targetRoot`.
 * `reserved` names (any depth) are always hidden; `skip` names relative paths
 * the caller mounts or masks itself (a dependency mount point).
 */
export async function computeCapturedMasks(
  sourceRoot: string,
  targetRoot: string,
  allowed: CapturedMaskDecision,
  signal: AbortSignal,
  options: { readonly reserved?: boolean; readonly skip?: ReadonlySet<string> } = {},
): Promise<CapturedMasks> {
  const argv: string[] = [];
  const hidden: string[] = [];
  const reserved = options.reserved !== false;
  const visit = async (dir: string): Promise<void> => {
    signal.throwIfAborted();
    const entries = await readdir(join(sourceRoot, dir), { withFileTypes: true });
    const descend: string[] = [];
    await checkCapturedInputsInBatches(entries, async (entry, current) => {
      const rel = dir ? join(dir, entry.name) : entry.name;
      if (options.skip?.has(rel) || entry.isSymbolicLink()) return;
      const directory = entry.isDirectory();
      const show = !(reserved && RESERVED.has(entry.name)) && (directory || entry.isFile()) && await allowed(rel, current);
      if (show) { if (directory) descend.push(rel); return; }
      hidden.push(directory ? `${rel}/` : rel);
      argv.push(...(directory ? ['--tmpfs', join(targetRoot, rel)] : ['--ro-bind', '/dev/null', join(targetRoot, rel)]));
    }, signal);
    for (const child of descend) await visit(child);
  };
  await visit('');
  return { argv, hidden };
}
