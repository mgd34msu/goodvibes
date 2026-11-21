import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The durable fact that this product created a worktree: a small file in the
 * worktree's own git administrative directory, written when it is added. Git
 * deletes that directory with the worktree, so the fact cannot outlive it or
 * be inherited by a different worktree at the same path. A worktree in the
 * product's own location that lacks it (one made by an earlier version) is
 * removed by the retention sweep only when it holds nothing that exists nowhere
 * else (see `evaluateUnmarkedWorktree`); worktrees elsewhere are never removed
 * automatically.
 */
const MARKER_FILE = 'goodvibes-created';

function administrativeDirectory(worktreePath: string): string | null {
  try {
    const dotGit = join(worktreePath, '.git');
    if (!lstatSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return match?.[1] ? resolve(worktreePath, match[1].trim()) : null;
  } catch { return null; }
}

// ── The product-worktree layout ──────────────────────────────────────────────
//
// Every worktree this product creates lives under `<root>/.goodvibes/.worktrees`,
// in a first segment that names its kind. Creators build their paths here and
// every reader (retention, owners, the registry, directory walks) recognises
// them here, so a new kind is added once and is swept and classified at once.

/** The directory segments, under a project root, that hold the product's worktrees. */
export const PRODUCT_WORKTREE_DIR_SEGMENTS = ['.goodvibes', '.worktrees'] as const;

/**
 * The kinds of worktree the product creates, each the first segment under the
 * worktree root: a contract's own tree (and its work items' trees nested in it),
 * a fix planner's view, a contract's captured input, and a workstream item's
 * tree (by its branch: `ws/...`, `ws-ns/...`, `ws-owned/...`).
 */
export const PRODUCT_WORKTREE_KINDS = ['contract', 'contract-planner', 'contract-input', 'ws', 'ws-ns', 'ws-owned'] as const;
export type ProductWorktreeCreatedKind = typeof PRODUCT_WORKTREE_KINDS[number];
/** A created kind, or `agent`: an `agent-<id>` tree made only by versions before 3.3.0, still recognised so it is swept. */
export type ProductWorktreeKind = ProductWorktreeCreatedKind | 'agent';

const CREATED_KINDS: ReadonlySet<string> = new Set(PRODUCT_WORKTREE_KINDS);
const LEGACY_AGENT_PREFIX = 'agent-';

/** `<root>/.goodvibes/.worktrees`. */
export function productWorktreeRoot(root: string): string {
  return join(root, ...PRODUCT_WORKTREE_DIR_SEGMENTS);
}

/** True when `segment` is a kind the product creates. */
export function isProductWorktreeKind(segment: string | undefined): segment is ProductWorktreeCreatedKind {
  return segment !== undefined && CREATED_KINDS.has(segment);
}

/** The path of a worktree of `kind`, with `rest` as the segments below the kind. */
export function productWorktreePath(root: string, kind: ProductWorktreeCreatedKind, ...rest: string[]): string {
  return join(productWorktreeRoot(root), kind, ...rest);
}

/** The segments of `path` below `<root>/.goodvibes/.worktrees`, or null when it is not inside (or is the directory itself). */
export function productWorktreeSegments(root: string, path: string): string[] | null {
  const rel = relative(productWorktreeRoot(root), isAbsolute(path) ? path : resolve(root, path));
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep);
}

/** The kind of product worktree `path` is (or lies inside), or null when it is none the product makes. */
export function kindOfProductWorktree(root: string, path: string): ProductWorktreeKind | null {
  const first = productWorktreeSegments(root, path)?.[0];
  if (first === undefined) return null;
  if (isProductWorktreeKind(first)) return first;
  return first.startsWith(LEGACY_AGENT_PREFIX) && first.length > LEGACY_AGENT_PREFIX.length ? 'agent' : null;
}

/** The kinds a contract owns: its own tree, its fix planner's views and its captured input. */
export const CONTRACT_WORKTREE_KINDS = ['contract', 'contract-planner', 'contract-input'] as const satisfies readonly ProductWorktreeCreatedKind[];

/**
 * Whether `path` is, or lies inside, a product worktree of one of `kinds`
 * under any project root (`.../.goodvibes/.worktrees/<kind>[/...]`), for a
 * check that has no project root to ask about: read from the path alone.
 */
export function liesInProductWorktreeOfKind(path: string, kinds: readonly ProductWorktreeKind[]): boolean {
  const [product, worktrees] = PRODUCT_WORKTREE_DIR_SEGMENTS;
  const parts = path.split(/[/\\]/);
  for (let index = 1; index + 1 < parts.length; index += 1) {
    if (parts[index - 1] !== product || parts[index] !== worktrees) continue;
    const kind = parts[index + 1]!;
    if (isProductWorktreeKind(kind) && kinds.includes(kind)) return true;
    if (kinds.includes('agent') && kind.startsWith(LEGACY_AGENT_PREFIX) && kind.length > LEGACY_AGENT_PREFIX.length) return true;
  }
  return false;
}

/** True when `path` lies under `<root>/.goodvibes/.worktrees`. */
export function isInsideProductWorktreeDirectory(root: string, path: string): boolean {
  return productWorktreeSegments(root, path) !== null;
}

/** Record that this product created the worktree. Returns false when the administrative directory cannot be written. */
export function markProductWorktree(worktreePath: string): boolean {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return false;
  try { writeFileSync(join(directory, MARKER_FILE), '1\n', { mode: 0o600 }); return true; }
  catch { return false; }
}

/**
 * How long after `git worktree add` began an unmarked worktree is still taken
 * to be in creation: git lists it as soon as the add starts, and the marker is
 * written only after the checkout returns.
 */
export const WORKTREE_CREATION_GRACE_MS = 10 * 60_000;

/**
 * Why an unmarked worktree may still be in creation, or null once it has
 * settled. Git holds `locked` in the administrative directory for the whole
 * add (and a person's `git worktree lock` keeps it too); the `.git` link file is
 * written once at the start of the add, so its age is the worktree's age.
 */
export function unsettledWorktreeReason(worktreePath: string, now: number, graceMs = WORKTREE_CREATION_GRACE_MS): string | null {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return 'its git link is not written yet, so it may still be in creation';
  if (existsSync(join(directory, 'locked'))) return 'git holds it locked (being created, or locked by hand)';
  try {
    const age = now - lstatSync(join(worktreePath, '.git')).mtimeMs;
    return age < graceMs ? `it was created ${Math.max(0, Math.round(age / 1000))} s ago and may still be in creation` : null;
  } catch { return 'its git link could not be read'; }
}

/**
 * True when git holds the worktree locked: during `git worktree add`, or by a
 * person's `git worktree lock`. Git itself refuses to remove a locked worktree,
 * and the retention sweep never tries.
 */
export function isWorktreeLockedByGit(worktreePath: string): boolean {
  const directory = administrativeDirectory(worktreePath);
  return directory !== null && existsSync(join(directory, 'locked'));
}

export function isMarkedProductWorktree(worktreePath: string): boolean {
  const directory = administrativeDirectory(worktreePath);
  if (!directory) return false;
  try { return lstatSync(join(directory, MARKER_FILE)).isFile(); }
  catch { return false; }
}
