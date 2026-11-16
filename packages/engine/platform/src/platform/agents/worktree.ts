import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { execFile } from 'node:child_process';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation, type FileObservation } from '../utils/file-observation.js';
// `simple-git` is an optionalDependency and is built through
// git/optional-simple-git.ts at the call that needs it, never imported at
// module init. See utils/optional-dependency.ts.
import { createSimpleGit } from '../git/optional-simple-git.js';
import { GitService, readGitWorktreeCreation, type GitWorktreeCreationObservation } from '../git/service.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';


/**
 * Result of committing the working tree. `hash` is the commit sha, or null when
 * there was nothing to commit (empty ledger, all paths ignored/missing, or no
 * dirty changes). `skippedIgnored` lists scoped paths that were dropped because
 * git ignores them, deliberately excluded from staging so an ignored bookkeeping
 * path in a self-reported ledger cannot fail the whole commit. Callers surface
 * this as an honest note rather than a failure.
 */
export interface CommitWorkingTreeResult {
  readonly hash: string | null;
  readonly skippedIgnored: readonly string[];
}

function readIndex(path: string): FileObservation | null {
  try { return readFileObservation(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function assertIndex(path: string, original: FileObservation | null): void {
  try {
    const current = fileObservationIdentity(path);
    if (original === null || current !== original.physical) throw new Error('Original Git index changed');
  } catch (error) {
    if (original === null && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

const ownsIndexLock = (current: BigIntStats | undefined, original: BigIntStats): boolean => !!current
  && current.isFile() && !current.isSymbolicLink() && current.nlink === 1n
  && current.dev === original.dev && current.ino === original.ino && current.uid === original.uid
  && current.gid === original.gid && current.birthtimeNs === original.birthtimeNs;

function ignoredPaths(cwd: string, paths: readonly string[]): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['check-ignore', '--stdin', '-z'],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        // Git uses exit 1 when none of the supplied paths are ignored.
        if (error && error.code !== 1) { reject(error); return; }
        resolve(stdout.split('\0').filter(Boolean).map(path => path.slice(2)));
      });
    child.stdin?.on('error', () => { /* The command callback reports early Git refusal. */ });
    // Prefix filenames with ./ so a leading colon is never pathspec magic.
    // check-ignore rejects even Git's global --literal-pathspecs flag.
    child.stdin?.end(`${paths.map(path => `./${path}`).join('\0')}\0`);
  });
}

/**
 * Why a worktree and its branch hold work that exists nowhere else, or null
 * when nothing in them is unique: uncommitted changes, untracked files or
 * ignored files in the tree (`git worktree remove` deletes ignored files such
 * as `.env.local`, local databases and reports under an ignored directory,
 * and no commit holds them), commits the base does not have in the tree or on
 * the branch, or git state that cannot be read. A missing directory has no
 * uncommitted changes to lose. The one rule for every worktree class.
 */
export async function uniqueWork(rootDir: string, worktreePath: string, branch: string, base: string): Promise<string | null> {
  try {
    const root = await createSimpleGit({ baseDir: rootDir });
    const baseHead = (await root.raw(['rev-parse', '--verify', base])).trim();
    const ahead = async (git: Awaited<ReturnType<typeof createSimpleGit>>, tip: string): Promise<number> => {
      const count = parseInt((await git.raw(['rev-list', '--count', `${baseHead}..${tip}`])).trim(), 10);
      if (!Number.isFinite(count)) throw new Error('commit count unreadable');
      return count;
    };
    if (existsSync(worktreePath)) {
      const tree = await createSimpleGit({ baseDir: worktreePath });
      const status = await tree.raw(['status', '--porcelain', '--untracked-files=all', '--ignored']);
      const lines = status.split('\n').filter((line) => line.length > 0);
      if (lines.some((line) => !line.startsWith('!! '))) return 'it has uncommitted changes';
      if (lines.length > 0) return `it has ignored files no commit holds (${lines.slice(0, 3).map((line) => line.slice(3)).join(', ')}${lines.length > 3 ? `, +${lines.length - 3} more` : ''})`;
      if (await ahead(tree, 'HEAD') > 0) return 'it has commits the base branch does not have';
    }
    let branchExists = true;
    try { await root.raw(['rev-parse', '--verify', '--quiet', branch]); } catch { branchExists = false; }
    if (branchExists && await ahead(root, branch) > 0) return `branch ${branch} has commits the base branch does not have`;
    return null;
  } catch (error) {
    return `its git state could not be read (${summarizeError(error)})`;
  }
}

/** Ignored files an eviction commit carries at most, in bytes; past it the rest are listed as dropped. */
const EVICTION_IGNORED_BYTES = 8 * 1024 * 1024;

/**
 * The paths `git status --porcelain=v1 -z` lists: every changed, deleted and
 * untracked path, and both sides of a rename or copy (so the old side's
 * deletion is staged with the new side).
 */
function changedStatusPaths(status: string): string[] {
  const entries = status.split('\0');
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (code.includes('R') || code.includes('C')) {
      const source = entries[index + 1];
      if (source !== undefined && source.length > 0) paths.add(source);
      index += 1;
    }
  }
  return [...paths];
}

/**
 * AgentWorktree, the scoped commit and HEAD reading on one working tree: the
 * shared project tree of an orchestration phase, an item's own worktree
 * (through IsolatedWorktree.commit), or a contract's result tree.
 */
export class AgentWorktree {
  private readonly git: GitService;

  constructor(cwd: string) {
    this.git = new GitService(cwd);
  }

  /**
   * @param paths When provided (non-empty), stage only these paths instead of sweeping the
   * whole working tree. Paths are self-reported LLM claims, not ground truth, so they are
   * filtered before staging:
   *  - a path that exists on disk (created/modified) is kept outright;
   *  - a path that does not exist is kept only if `git ls-files` shows it as tracked (a real
   *    deletion), otherwise it is a hallucinated path and dropped, `git add -A -- <path>`
   *    throws "pathspec did not match any files" for a path neither on disk nor known to git;
   *  - a path that git IGNORES (e.g. the product's own `.goodvibes/` bookkeeping written by a
   *    memory/preference tool) is dropped and reported in `skippedIgnored`. This is load-bearing:
   *    `git add -A -- <ignored>` exits non-zero ("paths are ignored") AFTER staging its valid
   *    siblings, so a single ignored path in the ledger would both fail the whole batch and
   *    leave the real deliverables staged in the user's index.
   * On commit failure the original index is restored only while it still belongs
   * to this staging attempt. Omit (or pass an empty array) to keep the legacy
   * `git add --all` sweep for back-compat.
   */
  async commitWorkingTree(message: string, paths?: string[], beforeCommit?: () => void): Promise<CommitWorkingTreeResult> {
    const scoped = paths && paths.length > 0 ? [...paths] : null;
    const root = captureExistingDirectory(this.git.getCwd());
    const cwd = root.canonical;
    const git = await createSimpleGit({ baseDir: cwd });
    const sourceGit = new GitService(cwd);
    root.assertCurrent();
    let stagedPathspecs: string[];
    let addFlag: '-A' | '--all';
    const skippedIgnored: string[] = [];

    if (scoped) {
      const onDisk = scoped.filter((p) => existsSync(join(cwd, p)));
      const maybeDeleted = scoped.filter((p) => !onDisk.includes(p));
      let trackedDeleted: string[] = [];
      if (maybeDeleted.length > 0) {
        const tracked: string = await git.raw(['ls-files', '-z', '--', ...maybeDeleted.map(path => `:(literal)${path}`)]);
        root.assertCurrent();
        const trackedSet = new Set(tracked.split('\0').filter(Boolean));
        trackedDeleted = maybeDeleted.filter((p) => trackedSet.has(p));
      }
      const existingPaths = [...onDisk, ...trackedDeleted];
      // check-ignore consumes filenames, not staging pathspecs. Keep leading
      // dashes/pathspec-like names literal and preserve whitespace with NULs.
      const ignored = existingPaths.length > 0
        ? await ignoredPaths(cwd, existingPaths)
        : [];
      root.assertCurrent();
      const ignoredSet = new Set(ignored);
      const stageable = existingPaths.filter((p) => !ignoredSet.has(p));
      skippedIgnored.push(...existingPaths.filter((p) => ignoredSet.has(p)));
      if (skippedIgnored.length > 0) {
        logger.debug('AgentWorktree.commitWorkingTree: dropping gitignored scoped paths before staging', {
          skippedIgnored,
        });
      }
      if (stageable.length === 0) {
        logger.debug('AgentWorktree.commitWorkingTree: no committable scoped paths after filtering (missing/ignored)', {
          claimedPaths: scoped,
          skippedIgnored,
        });
        return { hash: null, skippedIgnored };
      }
      // -A (not plain add) scoped to just these pathspecs so confirmed deletions are staged
      // too (plain `git add <path>` silently no-ops on a path that no longer exists on disk).
      stagedPathspecs = stageable.map(path => `:(literal)${path}`);
      addFlag = '-A';
    } else {
      // Stage exactly the paths git reports as changed (modified, deleted,
      // renamed, untracked; ignored files are not listed), so the command line
      // grows with the change, not with the repository. Negative pathspecs
      // naming an ignored directory can make git add fail after staging its
      // valid siblings, so the paths are named one by one, literally.
      const changed = changedStatusPaths(await git.raw([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        '.',
        ':(exclude).goodvibes',
        ':(exclude).goodvibes/**',
      ]));
      root.assertCurrent();
      stagedPathspecs = changed.filter((path) => path !== '.goodvibes' && !path.startsWith('.goodvibes/')).map((path) => `:(literal)${path}`);
      if (stagedPathspecs.length === 0) {
        logger.debug('AgentWorktree.commitWorkingTree: no direct working tree changes');
        return { hash: null, skippedIgnored };
      }
      addFlag = '--all';
    }

    const reportedIndex = (await git.raw(['rev-parse', '--git-path', 'index'])).trim();
    root.assertCurrent();
    const indexDirectory = captureExistingDirectory(dirname(resolve(cwd, reportedIndex)));
    const indexPath = join(indexDirectory.canonical, basename(reportedIndex));
    const originalIndex = readIndex(indexPath), originalHead = await new AgentWorktree(cwd).currentHead();
    root.assertCurrent(); indexDirectory.assertCurrent(); assertIndex(indexPath, originalIndex);
    let stagedIndex: FileObservation | undefined;
    try {
      root.assertCurrent(); indexDirectory.assertCurrent();
      await git.raw(['add', addFlag, '--', ...stagedPathspecs]);
      root.assertCurrent(); indexDirectory.assertCurrent();
      const observedIndex = readIndex(indexPath);
      if (observedIndex === null) throw new Error('Index disappeared after staging');
      stagedIndex = observedIndex;
      const result = await sourceGit.commit(message, {
        fallbackIdentity: { name: 'GoodVibes', email: 'goodvibes@local' },
        paths: stagedPathspecs,
      }, () => {
        root.assertCurrent(); indexDirectory.assertCurrent();
        beforeCommit?.();
        root.assertCurrent(); indexDirectory.assertCurrent();
      });
      root.assertCurrent(); indexDirectory.assertCurrent();
      if (result.hash) {
        logger.debug('AgentWorktree.commitWorkingTree: committed direct working tree changes', {
          hash: result.hash,
          skippedIgnored,
        });
        return { hash: result.hash, skippedIgnored };
      }
      // simple-git RESOLVES a rejected commit (e.g. a failing pre-commit hook) with an empty hash
      // rather than throwing. Distinguish that from a genuine no-op: if changes are still staged,
      // a hook/verification step rejected the commit, throw so the catch below restores the index
      // and the caller can report an honest warning. If nothing is staged, it was a true no-op.
      const stagedAfter = (await git.raw(['diff', '--cached', '--name-only', '--', ...stagedPathspecs])).trim();
      root.assertCurrent(); indexDirectory.assertCurrent();
      if (stagedAfter.length > 0) {
        throw new Error('git created no commit despite staged changes (a pre-commit hook or verification step likely rejected the commit)');
      }
      logger.debug('AgentWorktree.commitWorkingTree: no committable changes after staging');
      return { hash: null, skippedIgnored };
    } catch (error) {
      const reason = summarizeError(error).toLowerCase();
      if (reason.includes('nothing to commit') || reason.includes('no changes added to commit')) {
        logger.debug('AgentWorktree.commitWorkingTree: no committable changes after staging');
        return { hash: null, skippedIgnored };
      }
      // Any other failure (rejected add, rejected commit, hook/identity/disk error) must not leave
      // the caller's staging area mutated by a commit we could not complete, restore what we staged.
      if (stagedIndex !== undefined) await this._restoreIndex(indexPath, originalIndex, stagedIndex, originalHead, cwd,
        () => { root.assertPhysicalCurrent(); indexDirectory.assertPhysicalCurrent(); });
      else logger.warn('AgentWorktree.commitWorkingTree: staging did not establish an owned index; preserving its current contents');
      throw error;
    }
  }

  /**
   * Restore the exact original index, including partial staging and index flags.
   * A hook, concurrent Git operation or completed commit may retire our source;
   * never overwrite its newer index. Use Git's native lock before replacing it.
   * Rollback failure must not mask the original commit error.
   */
  private async _restoreIndex(path: string, original: FileObservation | null, staged: FileObservation, head: string | null,
    cwd: string, assertPhysicalCurrent: () => void): Promise<void> {
    let lock: number | undefined;
    let originalLock: BigIntStats | undefined;
    let published = false;
    try {
      assertPhysicalCurrent();
      if (await new AgentWorktree(cwd).currentHead() !== head) throw new Error('HEAD changed during the commit attempt');
      assertPhysicalCurrent(); assertIndex(path, staged);
      lock = openSync(`${path}.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const lockDescriptor = lock;
      originalLock = fstatSync(lock, { bigint: true });
      const current = () => {
        assertPhysicalCurrent(); assertIndex(path, staged);
        if (!originalLock || !ownsIndexLock(fstatSync(lockDescriptor, { bigint: true }), originalLock)
          || !ownsIndexLock(lstatSync(`${path}.lock`, { bigint: true }), originalLock)) throw new Error('Original Git index lock changed');
      };
      current();
      if (original === null) unlinkSync(path);
      else {
        writeFileSync(lock, original.bytes);
        current();
        renameSync(`${path}.lock`, path);
        published = true;
      }
      logger.debug('AgentWorktree.commitWorkingTree: restored original index after failed commit');
    } catch (err) {
      logger.warn('AgentWorktree.commitWorkingTree: index restore after failed commit did not complete', {
        error: summarizeError(err),
      });
    } finally {
      if (lock !== undefined) {
        try { closeSync(lock); } catch { /* Descriptor cleanup must not replace the original commit failure. */ }
      }
      if (originalLock && !published) {
        try {
          assertPhysicalCurrent();
          if (ownsIndexLock(lstatSync(`${path}.lock`, { bigint: true, throwIfNoEntry: false }), originalLock)) unlinkSync(`${path}.lock`);
        } catch { /* Preserve a foreign lock or a lock under a replaced parent. */ }
      }
    }
  }

  async currentHead(): Promise<string | null> {
    try {
      const git = await createSimpleGit({ baseDir: this.git.getCwd() });
      return (await git.raw(['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      logger.warn('AgentWorktree.currentHead failed', { error: summarizeError(error) });
      return null;
    }
  }
}

/** Outcome of integrating an item branch back into the base branch (see IsolatedWorktree.integrate). */
export type IntegrationOutcome =
  /** Clean merge, `hash` is the merge commit on the base branch. */
  | { readonly status: 'merged'; readonly hash: string }
  /** The base merge conflicted; `files` names the conflicting paths. The base tree is restored (merge --abort) so the lane can continue. */
  | { readonly status: 'conflict'; readonly files: readonly string[] }
  /** The item branch carried no commits beyond base, nothing to merge (an honest no-op, not a failure). */
  | { readonly status: 'empty' };

/**
 * IsolatedWorktree, one work item's dedicated git worktree for the
 * orchestration engine's `worktree` isolation mode (see WorkstreamIsolation).
 *
 * Unlike {@link AgentWorktree} (a scoped commit on an existing working tree),
 * an IsolatedWorktree models the full per-item
 * lifecycle the engine drives:
 *
 *   create()   , add a git worktree at `path` on a fresh branch `branch`,
 *                 branched from the base branch (the root tree's current HEAD).
 *   commit()   , scoped-commit the item's touched paths onto `branch`, INSIDE
 *                 the worktree (delegates to AgentWorktree.commitWorkingTree
 *                 bound to `path`, so the ignored/hallucinated/deletion
 *                 filtering is reused verbatim).
 *   isClean()  , whether the worktree holds uncommitted, untracked or ignored files.
 *   uniqueWork(), why the tree or branch holds work that exists nowhere else
 *                 (drives the fail/kill cleanup rule: remove only when null).
 *   integrate(), merge `branch` into the base branch IN THE ROOT TREE. The
 *                 root tree stays checked out on base; a different branch being
 *                 merged never needs the worktree removed first. On conflict it
 *                 runs `merge --abort` to restore the root index so the single
 *                 sequential integration lane can proceed to the next item.
 *   remove()   , remove the worktree dir and delete `branch` (post-merge, or
 *                 a clean tree after fail/kill).
 *   keepInPlace()/uniqueCommitCount(), inspection helpers for KEPT worktrees.
 *
 * Location: worktrees live under `<root>/.goodvibes/.worktrees/`, the same
 * gitignored bookkeeping area AgentWorktree and WorktreeRegistry already use,
 * chosen over the system temp dir deliberately: (1) crash cleanup, a worktree
 * under the repo is discoverable by `git worktree list` and the existing
 * WorktreeRegistry path scan, so an orphan left by a crashed process can be
 * reconciled; a temp-dir worktree is invisible to repo-relative reconciliation
 * and can be swept out from under a KEPT (dirty) tree by an OS temp cleaner,
 * losing data. (2) gitignore interplay, `.goodvibes/` is already ignored and
 * the commit path already excludes it, so a nested worktree checkout there
 * never pollutes the parent's tracked status nor gets accidentally committed.
 */
const isolatedWorktreeCreations = new WeakMap<IsolatedWorktree, GitWorktreeCreationObservation>();
/** Original native receipt; copies of an instance or parsed facts cannot mint it. */
export function readIsolatedWorktreeCreation(instance: IsolatedWorktree): GitWorktreeCreationObservation | undefined {
  const observation = isolatedWorktreeCreations.get(instance);
  if (!observation || observation.facts.path !== instance.path || observation.facts.branch !== instance.branch) return undefined;
  observation.assertCurrent(); return observation;
}

export class IsolatedWorktree {
  readonly path: string;
  readonly branch: string;
  private readonly rootGit: GitService;
  private readonly baseBranch: string;

  /**
   * @param rootDir     the repository root (base tree), merges land here.
   * @param path        absolute path for this item's worktree directory.
   * @param branch      the item branch name to create/check out in the worktree.
   * @param baseBranch  the branch merges integrate into (the root tree's branch).
   */
  constructor(rootDir: string, path: string, branch: string, baseBranch: string) {
    this.path = path;
    this.branch = branch;
    this.baseBranch = baseBranch;
    this.rootGit = new GitService(rootDir);
  }

  /** Add the worktree on a fresh `branch` branched from base (the root tree's current HEAD). */
  async create(startPoint?: string, checkout = true, beforeMutation?: () => void): Promise<void> {
    logger.debug('IsolatedWorktree.create', { path: this.path, branch: this.branch });
    try { await this.rootGit.worktreeAdd(this.path, this.branch, startPoint, checkout, beforeMutation); }
    finally {
      // A post hook can reject after real creation. Retain the real receipt for
      // owned recovery/cleanup; a fake successful public method has no receipt.
      const created = readGitWorktreeCreation(this.rootGit, this.path, this.branch);
      if (created) isolatedWorktreeCreations.set(this, created);
    }
  }

  /**
   * Scoped-commit the item's touched paths onto the item branch, inside the
   * worktree. Reuses AgentWorktree.commitWorkingTree (bound to the worktree
   * path) so the ignored/hallucinated/confirmed-deletion filtering is identical
   * to shared mode. A fresh worktree starts clean, so in worktree mode the
   * launch-dirty snapshot is per-worktree and trivially empty (see the engine).
   */
  async commit(message: string, paths?: string[], beforeCommit?: () => void): Promise<CommitWorkingTreeResult> {
    return new AgentWorktree(this.path).commitWorkingTree(message, paths, beforeCommit);
  }

  /** HEAD of the item branch (inside the worktree), or null if it can't be read. */
  async currentHead(): Promise<string | null> {
    try {
      const wgit = await createSimpleGit({ baseDir: this.path });
      return (await wgit.raw(['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      logger.warn('IsolatedWorktree.currentHead failed', { path: this.path, error: summarizeError(error) });
      return null;
    }
  }

  /**
   * True when the worktree holds nothing that removing its directory would
   * lose: no uncommitted change, no untracked file and no ignored file
   * (`git worktree remove` deletes ignored files and no commit holds them).
   * Missing dir ⇒ treated as clean.
   */
  async isClean(): Promise<boolean> {
    if (!existsSync(this.path)) return true;
    try {
      const wgit = await createSimpleGit({ baseDir: this.path });
      const status = (await wgit.raw(['status', '--porcelain', '--untracked-files=all', '--ignored'])).trim();
      return status.length === 0;
    } catch (error) {
      // If we can't read status, treat as DIRTY (keep the tree), data safety.
      logger.warn('IsolatedWorktree.isClean: status failed, treating as dirty', { path: this.path, error: summarizeError(error) });
      return false;
    }
  }

  /** Why this worktree and its branch cannot be removed, or null when nothing in them is unique ({@link uniqueWork} against the base branch). */
  async uniqueWork(): Promise<string | null> {
    return uniqueWork(this.rootGit.getCwd(), this.path, this.branch, this.baseBranch);
  }

  /** How many commits the item branch carries beyond base, or null when git cannot say (callers must then keep the branch). */
  async uniqueCommitCount(): Promise<number | null> {
    try {
      const wgit = await createSimpleGit({ baseDir: this.rootGit.getCwd() });
      const count = parseInt((await wgit.raw(['rev-list', '--count', `${this.baseBranch}..${this.branch}`])).trim(), 10);
      return Number.isFinite(count) ? count : null;
    } catch (error) {
      logger.warn('IsolatedWorktree.uniqueCommitCount: rev-list failed', { branch: this.branch, error: summarizeError(error) });
      return null;
    }
  }

  /**
   * Merge the item branch into the base branch in the ROOT tree. Returns an
   * honest {@link IntegrationOutcome}: `merged` (with the merge commit hash),
   * `conflict` (with the conflicting files, the merge is aborted so the root
   * is restored and the lane can continue), or `empty` (no commits to merge). Throws when git cannot count the
   * commits, so an unreadable branch is never reported as empty.
   * Never auto-resolves a conflict.
   */
  async integrate(beforeMutation?: () => void): Promise<IntegrationOutcome> {
    // The restriction is checked by the merge itself, on entry and after its last await; counting commits mutates nothing.
    const unique = await this.uniqueCommitCount();
    if (unique === null) {
      // git could not compare the branches (base ref moved, transient failure):
      // reporting "empty" would mark unmerged work as merged.
      throw new Error(`cannot tell whether branch ${this.branch} has commits beyond ${this.baseBranch}; leaving it unmerged`);
    }
    if (unique === 0) {
      logger.debug('IsolatedWorktree.integrate: branch has no commits beyond base, nothing to merge', { branch: this.branch });
      return { status: 'empty' };
    }
    const wgit = await createSimpleGit({ baseDir: this.rootGit.getCwd() });
    const before = (await wgit.raw(['rev-parse', 'HEAD'])).trim();
    const result = await this.rootGit.merge(this.branch, beforeMutation);
    if (result.success) {
      const hash = (await wgit.raw(['rev-parse', 'HEAD'])).trim();
      // A fast-forward or an already-merged branch can leave HEAD unmoved; a
      // fresh merge commit moves it. Either way the branch content is now in
      // base, report the current base HEAD as the integration point.
      logger.debug('IsolatedWorktree.integrate: merged', { branch: this.branch, before, hash });
      return { status: 'merged', hash };
    }
    // Conflict, restore the root tree so the sequential lane can continue.
    const files = [...(result.conflicts ?? [])];
    try {
      beforeMutation?.();
      await wgit.raw(['merge', '--abort']);
    } catch (err) {
      logger.warn('IsolatedWorktree.integrate: merge --abort did not complete after conflict', { branch: this.branch, error: summarizeError(err) });
    }
    logger.debug('IsolatedWorktree.integrate: conflict, base restored', { branch: this.branch, files });
    return { status: 'conflict', files };
  }

  /**
   * The diff this item branch introduced over the base branch (base...branch,
   * changes on the branch since it diverged). The existing diff plumbing behind
   * a best-of-N candidate: returns the changed files, the unified diff text, and
   * the diffstat. A read error degrades to an empty diff, never throws.
   */
  async diff(): Promise<{ files: string[]; unifiedDiff: string; stat: string }> {
    const range = `${this.baseBranch}...${this.branch}`;
    try {
      const wgit = await createSimpleGit({ baseDir: this.rootGit.getCwd() });
      const names = (await wgit.raw(['diff', '--name-only', range])).trim();
      const files = names.length > 0 ? names.split('\n').filter(Boolean) : [];
      const unifiedDiff = await wgit.raw(['diff', range]);
      const stat = (await wgit.raw(['diff', '--stat', range])).trim();
      return { files, unifiedDiff, stat };
    } catch (error) {
      logger.warn('IsolatedWorktree.diff: could not compute branch diff', { branch: this.branch, error: summarizeError(error) });
      return { files: [], unifiedDiff: '', stat: '' };
    }
  }

  /** Remove the worktree directory and delete the item branch (post-merge, or a clean tree after fail/kill). */
  async remove(beforeRemove?: () => void, beforeRepositoryWrite?: () => void): Promise<void> {
    logger.debug('IsolatedWorktree.remove', { path: this.path, branch: this.branch });
    await this.removeDirectory(beforeRemove);
    try {
      const wgit = await createSimpleGit({ baseDir: this.rootGit.getCwd() });
      beforeRepositoryWrite?.();
      // `-d` refuses a branch whose commits are not in the current branch, so a
      // commit that exists nowhere else is never dropped by this path.
      await wgit.raw(['branch', '-d', this.branch]);
    } catch (err) {
      logger.warn('IsolatedWorktree.remove: branch kept (it has commits not merged into the current branch, or deleting it failed)', { branch: this.branch, error: summarizeError(err) });
    }
  }

  /**
   * Evict this worktree under the kept-worktree cap. Eviction bounds DISK
   * usage, never work: any uncommitted state (modified and untracked files)
   * is first committed onto the item branch, then ONLY the directory is
   * removed. Ignored files are carried too, force-added, up to
   * {@link EVICTION_IGNORED_BYTES} in total; an ignored directory or a file
   * past that bound is not committed and is returned in `droppedIgnored` so
   * the caller can say what was let go. The branch is deliberately KEPT, so a
   * conflicted/dirty tree evicted past the cap stays recoverable with
   * `git worktree add <path> <branch>` / `git show <branch>:<file>`.
   *
   * When the preservation commit cannot be created, the directory is NOT
   * removed (the error propagates), leaving an over-cap directory on disk is
   * always preferred over destroying uncommitted work.
   *
   * @returns the preservation commit hash, or null when the tree was already
   *          clean (nothing needed preserving), and the ignored paths not kept.
   */
  async evict(beforeEvict?: () => void, beforeRepositoryWrite?: () => void): Promise<{ preservedCommit: string | null; droppedIgnored: readonly string[] }> {
    beforeRepositoryWrite?.(); beforeEvict?.();
    logger.debug('IsolatedWorktree.evict', { path: this.path, branch: this.branch });
    let preservedCommit: string | null = null;
    const droppedIgnored: string[] = [];
    if (existsSync(this.path) && !(await this.isClean())) {
      const wgit = await createSimpleGit({ baseDir: this.path });
      beforeRepositoryWrite?.(); beforeEvict?.();
      await wgit.raw(['add', '-A']);
      const ignored = (await wgit.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']))
        .split('\0').filter((entry) => entry.startsWith('!! ')).map((entry) => entry.slice(3));
      const carried: string[] = [];
      let bytes = 0;
      for (const path of ignored) {
        const stats = path.endsWith('/') ? undefined : lstatSync(join(this.path, path), { throwIfNoEntry: false });
        if (stats === undefined || !stats.isFile() || bytes + stats.size > EVICTION_IGNORED_BYTES) { droppedIgnored.push(path); continue; }
        bytes += stats.size;
        carried.push(path);
      }
      if (carried.length > 0) {
        beforeRepositoryWrite?.(); beforeEvict?.();
        await wgit.raw(['add', '-f', '--', ...carried.map((path) => `:(literal)${path}`)]);
      }
      const message = 'preserve uncommitted work at kept-cap eviction';
      try {
        beforeRepositoryWrite?.(); beforeEvict?.();
        await wgit.raw(['commit', '--no-verify', '-m', message]);
      } catch (err) {
        // Most common cause: no committer identity configured in this
        // environment. Preservation must not depend on host config, retry
        // with an explicit fallback identity rather than lose the tree.
        logger.debug('IsolatedWorktree.evict: commit failed, retrying with fallback identity', { path: this.path, error: summarizeError(err) });
        beforeRepositoryWrite?.(); beforeEvict?.();
        await wgit.raw(['-c', 'user.email=goodvibes@localhost', '-c', 'user.name=goodvibes-eviction', 'commit', '--no-verify', '-m', message]);
      }
      preservedCommit = (await wgit.raw(['rev-parse', 'HEAD'])).trim();
    }
    beforeRepositoryWrite?.();
    await this.removeDirectory(beforeEvict);
    // The branch is KEPT deliberately, no `branch -D` on the eviction path.
    return { preservedCommit, droppedIgnored };
  }

  /** Native plain removal protects work added after a cleanliness check.
   * Failure never escalates into destructive force removal. */
  private async removeDirectory(beforeRemove?: () => void): Promise<void> {
    if (!existsSync(this.path)) return;
    await this.rootGit.worktreeRemove(this.path, beforeRemove);
  }
}
