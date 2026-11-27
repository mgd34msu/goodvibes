/**
 * The repair of a step whose changes conflicted with the work's own branch
 * (worktree mode). A step's agent runs its commands in the captured boundary,
 * where git cannot reach the repository behind a step's tree, so the host does
 * the git part and the agent edits files:
 *
 * - before the repair step's agent starts, the host brings the other branch
 *   into the repair step's tree (`git merge --no-ff --no-commit`), so the
 *   conflicting files hold both sides between conflict markers;
 * - when the agent's turn ends, the host reads the tree: no marker left in a
 *   conflicting file, so the host concludes the merge with a commit and the
 *   step is checked; a marker left, so the conflict remains and the owner is
 *   asked once, in every mode, as every Work question is (keep the first
 *   change, keep the second, or stop);
 * - the chosen "keep the first" or "keep the second" is applied here, by the
 *   host, file by file, and the merge concluded.
 *
 * Nothing here waits on a clock: each step runs when the agent's turn ended or
 * the owner answered.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSimpleGit } from '../git/optional-simple-git.js';

/** A conflicting merge a repair step resolves: the other branch and the files both sides changed. */
export interface MergeConflictRepair {
  readonly branch: string;
  readonly files: readonly string[];
}

/** Where a repair step's tree stands against the other branch. */
export type ConflictStanding =
  /** The other branch is part of the tree's history: nothing is left to resolve. */
  | { readonly kind: 'merged' }
  /** The merge is under way and no conflict marker is left: the host concludes it. */
  | { readonly kind: 'resolved' }
  /** The merge is under way and these files still hold conflict markers, or the merge was never started. */
  | { readonly kind: 'unresolved'; readonly files: readonly string[] };

/** The conflict a unit resolves: set for the first unit of a group that repairs a conflicting merge. */
export function conflictResolvedBy(
  group: { readonly unitIds: readonly string[]; readonly repairs?: { readonly conflict?: MergeConflictRepair | undefined } | undefined } | undefined,
  unitId: string,
): MergeConflictRepair | undefined {
  const conflict = group?.repairs?.conflict;
  return conflict !== undefined && group!.unitIds[0] === unitId ? conflict : undefined;
}

const MARKER =/^(<{7}(?: |$)|={7}$|>{7}(?: |$))/mu;

async function gitIn(cwd: string) {
  return createSimpleGit({ baseDir: cwd });
}

async function mergeUnderWay(cwd: string): Promise<boolean> {
  const git = await gitIn(cwd);
  const path = resolve(cwd, (await git.raw(['rev-parse', '--git-path', 'MERGE_HEAD'])).trim());
  return existsSync(path);
}

async function branchIsIn(cwd: string, branch: string): Promise<boolean> {
  // Compared by commit, not by exit code: a git run that exits 1 with nothing on stderr does not reject here.
  const git = await gitIn(cwd);
  try {
    const tip = (await git.raw(['rev-parse', '--verify', `${branch}^{commit}`])).trim();
    const base = (await git.raw(['merge-base', tip, 'HEAD'])).trim();
    return tip.length > 0 && base === tip;
  } catch {
    return false;
  }
}

/** The paths git still lists as unmerged, with the conflict's own files. */
async function conflictedPaths(cwd: string, files: readonly string[]): Promise<string[]> {
  const git = await gitIn(cwd);
  const unmerged = (await git.raw(['ls-files', '--unmerged'])).split('\n').map((line) => line.split('\t')[1]).filter((path): path is string => Boolean(path));
  return [...new Set([...files, ...unmerged])];
}

function holdsMarker(cwd: string, path: string): boolean {
  try { return MARKER.test(readFileSync(join(cwd, path), 'utf8')); } catch { return false; }
}

/**
 * Brings the other branch into the repair step's tree, before its agent starts. A merge already under way (the step
 * started again after a restart) or a branch already in the tree is left as it is. A conflicting merge is what this
 * expects, so git's refusal to finish is not an error; any other failure is.
 */
export async function startConflictMerge(cwd: string, repair: MergeConflictRepair): Promise<void> {
  if (await mergeUnderWay(cwd) || await branchIsIn(cwd, repair.branch)) return;
  const git = await gitIn(cwd);
  try {
    await git.raw(['merge', '--no-ff', '--no-commit', repair.branch]);
  } catch (error) {
    if (await mergeUnderWay(cwd)) return;
    throw new Error(`the other change (branch ${repair.branch}) could not be brought into the repair step's tree: ${error instanceof Error ? error.message : String(error)}`);
  }
  // git can end without an error and without merging (a refusal it prints to stdout): what is seen decides.
  if (!(await mergeUnderWay(cwd)) && !(await branchIsIn(cwd, repair.branch))) {
    throw new Error(`the other change (branch ${repair.branch}) could not be brought into the repair step's tree: git did not start the merge`);
  }
}

/** Where the repair step's tree stands, read when its agent's turn ended. */
export async function readConflictStanding(cwd: string, repair: MergeConflictRepair): Promise<ConflictStanding> {
  if (!(await mergeUnderWay(cwd))) return await branchIsIn(cwd, repair.branch) ? { kind: 'merged' } : { kind: 'unresolved', files: [...repair.files] };
  const left = (await conflictedPaths(cwd, repair.files)).filter((path) => holdsMarker(cwd, path));
  return left.length === 0 ? { kind: 'resolved' } : { kind: 'unresolved', files: left };
}

/** Concludes a merge whose conflicts are resolved in the files: every conflicting path is added and the merge committed. */
export async function finishConflictMerge(cwd: string, repair: MergeConflictRepair): Promise<void> {
  const git = await gitIn(cwd);
  const paths = await conflictedPaths(cwd, repair.files);
  if (paths.length > 0) await git.raw(['add', '--', ...paths]);
  // Said as what happened, not as git's "Merge branch '<internal branch>' into <internal branch>".
  await git.raw(['commit', '--no-verify', '-m', `Combine the two changes to ${repair.files.join(', ') || 'the same files'}`]);
}

/**
 * The owner's answer applied: each conflicting file takes the first change (what the work's own branch holds, the
 * tree's HEAD) or the second (the step's branch being brought in), and the merge is concluded. The other changes of
 * that step, outside the conflicting files, come in with it.
 */
export async function keepOneSide(cwd: string, repair: MergeConflictRepair, keep: 'first' | 'second'): Promise<void> {
  const git = await gitIn(cwd);
  if (!(await mergeUnderWay(cwd))) {
    if (await branchIsIn(cwd, repair.branch)) return;
    await startConflictMerge(cwd, repair);
  }
  const paths = await conflictedPaths(cwd, repair.files);
  // The agent's own edits of these files are set aside: the owner chose one side.
  if (paths.length > 0) await git.raw(['checkout', keep === 'first' ? '--ours' : '--theirs', '--', ...paths]);
  await finishConflictMerge(cwd, repair);
}

/**
 * The work ended (stopped, or failed) with the repair's merge never finished: the merge is undone in the repair
 * step's tree, and the tree and its branch go when they hold nothing the work's own branch lacks (the repair wrote
 * nothing of its own that was committed). What stays is the work's own branch and the other change's branch
 * (`repair.branch`), which the end line names. Never throws: a tree that stays is only disk use.
 */
export async function setRepairTreeAside(projectRoot: string, cwd: string, workBranch: string): Promise<void> {
  try {
    if (!existsSync(cwd)) return;
    const tree = await gitIn(cwd);
    if (await mergeUnderWay(cwd)) await tree.raw(['merge', '--abort']);
    const own = (await tree.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!own || own === 'HEAD' || own === workBranch) return;
    if ((await tree.raw(['status', '--porcelain', '--untracked-files=all'])).trim() !== '') return;
    // Its last commit is in the work's own branch: the tree holds nothing of its own.
    const head = (await tree.raw(['rev-parse', 'HEAD'])).trim();
    if (!(await tree.raw(['branch', '--contains', head, '--format=%(refname:short)'])).split('\n').map((line) => line.trim()).includes(workBranch)) return;
    const project = await gitIn(projectRoot);
    await project.raw(['worktree', 'remove', '--force', cwd]);
    await project.raw(['branch', '-D', own]);
  } catch { /* left for the retention rules */ }
}

/** Whether the other branch is part of a tree's history (the work's own branch, after the repair merged into it). */
export async function conflictBranchIsIn(cwd: string, repair: MergeConflictRepair): Promise<boolean> {
  return branchIsIn(cwd, repair.branch);
}
