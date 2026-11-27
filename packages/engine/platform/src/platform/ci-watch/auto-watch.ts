import { nativeCiWatchOwner } from './native-owner.js';
import { captureCiWatchOwner } from './autonomous.js';
import { currentExternalOperationSource } from '../permissions/external-operation-scope.js';
import type { ExternalOperationSource } from '../permissions/external-request.js';
import { turnInputParty, type TurnInputParty } from '../security/turn-input-party.js';
/**
 * ci-watch/auto-watch.ts, CI watches mint themselves at the push/PR seam.
 *
 * Work done through the platform that pushes a branch (or opens a PR) in a CI
 * repo creates its own watch, no ceremony. The seam is tool execution: a
 * successful exec run whose commands include `git push` or `gh pr create`
 * mints a watch for the pushed branch (fire-and-forget; the tool-result path
 * is never blocked, mirroring the code-index reindex scheduler's contract).
 * A GitService-driven push can call `onGitPushed` directly for the same mint.
 *
 * Delivery defaults to the daemon's own operator-surface channel ('web', the
 * control-plane delivery the existing push-notification path rides), and the
 * verdict notification plus verdict-retirement behavior come free from
 * CiWatchService: the watch ends once its terminal verdict is delivered, or
 * with a "no verdict" notice when the branch is gone or no verdict came in time.
 * The scripted path (/ci watch → ci.watches.create) is untouched.
 */
import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CiWatchSubscription } from './types.js';
import type { CreateCiWatchInput } from './service.js';

/** The default delivery channel: the daemon's operator web surface (control-plane delivery). */
export const DEFAULT_AUTO_WATCH_CHANNEL = 'web';

/** The turn a tool ran in: its project folder, absent for the host's own folder (no project). */
export interface CiWatchTurn {
  readonly project?: string | undefined;
}

/** A push detected in an exec command list. */
export interface DetectedCiPush {
  readonly kind: 'push' | 'pr';
  /** The pushed branch when the command names one (else the current branch is resolved). */
  readonly branch?: string | undefined;
  /**
   * The repository directory the push ran in, from `git -C <dir>` and a `cd <dir>`
   * earlier on the line: absolute, or relative to the command's working directory.
   * Undefined when the push ran in the working directory itself.
   */
  readonly dir?: string | undefined;
}

/** Push flags after which there is no branch worth a CI watch: a delete, tags only, or a dry run that pushes nothing. */
const PUSH_FLAG_NO_BRANCH = new Set(['--delete', '--tags', '--dry-run']);

const PUSH_FLAG_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--repo', '--exec']);

/** git's global options (before the subcommand) that take their value as the next word. */
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** git's global options that move the repository somewhere this parser does not follow. */
const GIT_GLOBAL_ELSEWHERE = /^--(?:git-dir|work-tree)(?:=|$)/;

/** A directory word read as written: no expansion, quoting or substitution the shell would change. */
function literalDirectory(word: string | undefined): string | null {
  if (!word) return null;
  const unquoted = /^'[^']*'$|^"[^"$`\\]*"$/.test(word) ? word.slice(1, -1) : word;
  return unquoted && !unquoted.startsWith('-') && /^[A-Za-z0-9._/+@:,=-]+$/.test(unquoted) ? unquoted : null;
}

/** `next` taken from `dir`, as a shell or `git -C` would. */
function enterDirectory(dir: string | undefined, next: string): string {
  return dir === undefined || isAbsolute(next) ? next : join(dir, next);
}

/**
 * Where git's subcommand is (the first word after `git` that is not a global
 * option or its value) and the directory the `-C` options lead to, each
 * relative to the one before; null when the repository is moved by
 * `--git-dir`/`--work-tree` or a `-C` this parser cannot read.
 */
function gitSubcommand(tokens: readonly string[], dir: string | undefined): { readonly index: number; readonly dir: string | undefined } | null {
  let current = dir;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith('-')) return { index: i, dir: current };
    if (GIT_GLOBAL_ELSEWHERE.test(token)) return null;
    if (token === '-C') {
      const target = literalDirectory(tokens[i + 1]);
      if (target === null) return null;
      current = enterDirectory(current, target);
    }
    if (GIT_GLOBAL_WITH_VALUE.has(token)) i += 1;
  }
  return { index: -1, dir: current };
}

/**
 * Detect a CI-relevant push in one exec command line: `git push ...` or
 * `gh pr create ...`. Only simple top-level forms are matched, a compound
 * line still matches when a segment starts with the command. The push's
 * directory follows `git -C` and a `cd` earlier on the line; a push whose
 * directory cannot be read literally detects nothing, so no watch is minted
 * for a guessed repository.
 */
export function detectCiPushInCommand(command: string): DetectedCiPush | null {
  let dir: string | undefined;
  let dirUnknown = false;
  // Split compound shells and pipelines; each segment is inspected alone.
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
      const target = tokens.length === 2 ? literalDirectory(tokens[1]) : null;
      if (target === null) dirUnknown = true;
      else if (isAbsolute(target)) { dir = target; dirUnknown = false; }
      else dir = enterDirectory(dir, target);
      continue;
    }
    // A subshell's directory change is not followed.
    if (/^\(+(?:cd|pushd)$/.test(tokens[0]!)) { dirUnknown = true; continue; }
    if (tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'create') {
      return dirUnknown ? null : { kind: 'pr', ...(dir !== undefined ? { dir } : {}) };
    }
    if (tokens[0] !== 'git') continue;
    // `push` must be git's subcommand, not a word later on the line
    // (`git stash push`, `git log --grep push`).
    const subcommand = gitSubcommand(tokens, dir);
    if (subcommand === null || subcommand.index === -1 || tokens[subcommand.index] !== 'push') {
      if (subcommand === null && tokens.includes('push')) return null;
      continue;
    }
    const pushIndex = subcommand.index;
    // Positional args after `push`, skipping flags (and their values where known):
    // the first positional is the remote, the second the refspec/branch.
    const positionals: string[] = [];
    let skipped = false;
    for (let i = pushIndex + 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith('-')) {
        // Deleting a ref, pushing only tags or a dry run leaves no branch whose CI will run.
        if (PUSH_FLAG_NO_BRANCH.has(token) || /^-[a-zA-Z]*[dn][a-zA-Z]*$/.test(token)) skipped = true;
        if (PUSH_FLAG_WITH_VALUE.has(token)) i += 1;
        continue;
      }
      positionals.push(token);
    }
    if (skipped) continue;
    const branch = branchFromRefspec(positionals[1]);
    if (branch === null) continue;
    if (dirUnknown) return null;
    return { kind: 'push', branch, ...(subcommand.dir !== undefined ? { dir: subcommand.dir } : {}) };
  }
  return null;
}

/**
 * The branch a refspec pushes to; undefined when it names none and the current
 * branch should be resolved (`HEAD`, nothing); null when the push has no branch
 * to watch (a delete such as `:branch`, or a tag or other non-branch ref). A
 * leading `+` (force) and `refs/heads/` are not part of the branch name.
 */
function branchFromRefspec(refspec: string | undefined): string | undefined | null {
  if (!refspec) return undefined;
  let target = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  if (target.includes(':')) {
    const [source, destination] = target.split(':', 2);
    if (!source) return null;
    target = destination ?? '';
  }
  if (target.startsWith('refs/heads/')) target = target.slice('refs/heads/'.length);
  else if (target.startsWith('refs/')) return null;
  return !target || target === 'HEAD' ? undefined : target;
}

/** Extract the command strings from exec-tool args ({ commands: [{cmd}] } or strings). */
export function execCommandsFromArgs(args: Record<string, unknown>): string[] {
  const commands = args.commands;
  if (!Array.isArray(commands)) return [];
  const out: string[] = [];
  for (const entry of commands) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as { cmd?: unknown }).cmd === 'string') {
      out.push((entry as { cmd: string }).cmd);
    }
  }
  return out;
}

/** Parse a git remote URL into a GitHub owner/name slug, or null when not GitHub. */
export function parseGitHubSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/(?:^|[/@])github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/** Runs a git command in cwd and yields trimmed stdout, or null on any failure. */
function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

export interface CiWatchAutoMintDeps {
  readonly service: {
    createWatch(input: CreateCiWatchInput, operation?: ExternalOperationSource): Promise<CiWatchSubscription>;
    listWatches(): Promise<CiWatchSubscription[]>;
  };
  /** The host's own folder (the daemon's): not a project, so a turn there makes no watch. */
  readonly workingDirectory: string;
  /** Delivery channel for minted watches; defaults to the operator web surface. */
  readonly deliveryChannel?: string | undefined;
  /** Injectable repo-slug resolver (tests); default shells `git remote get-url`. */
  readonly resolveRepoSlug?: ((cwd: string) => Promise<string | null>) | undefined;
  /** Injectable current-branch resolver (tests); default shells `git rev-parse`. */
  readonly resolveCurrentBranch?: ((cwd: string) => Promise<string | null>) | undefined;
}

/**
 * The self-minting tap. `onToolExecuted` has the exact shape of the shared
 * tool-execution observer seam; `onGitPushed` serves GitService-path callers.
 * Minting is asynchronous and best-effort, it never blocks or fails the
 * caller, and a repo that is not a GitHub remote is a silent no-op (the gh
 * status source could not watch it honestly).
 */
export class CiWatchAutoMinter {
  private mintQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: CiWatchAutoMintDeps) {}

  /**
   * Tool-execution observer: mints on a successful exec containing a push/PR-create. The watch belongs to the project of
   * the turn that ran it (`turn.project`), and its repair works there; a turn in no project (the daemon's own folder)
   * makes no watch.
   */
  onToolExecuted(toolName: string, args: Record<string, unknown>, success: boolean, turn?: CiWatchTurn): void {
    if (toolName !== 'exec' || !success) return;
    const project = turn?.project;
    if (!project || resolve(project) === resolve(this.deps.workingDirectory)) return;
    for (const command of execCommandsFromArgs(args)) {
      const detected = detectCiPushInCommand(command);
      if (!detected) continue;
      const execCwd = typeof args.working_dir === 'string' && args.working_dir.trim()
        ? resolve(project, args.working_dir)
        : project;
      // The push's own directory (`git -C`, a `cd` before it) names the repository, not the exec's.
      const cwd = detected.dir !== undefined ? resolve(execCwd, detected.dir) : execCwd;
      try {
        // Whose input the pushing turn acted on, read now, in its scope (the owner's own chat: the owner's; anyone else's:
        // theirs): the watch's repair is decided and runs as that party.
        void this.mint(cwd, detected, captureCiWatchOwner(currentExternalOperationSource()), project, turnInputParty()).catch((error) => {
          logger.warn('[ci-watch] auto-mint failed', { command, error: summarizeError(error) });
        });
      } catch (error) { logger.warn('[ci-watch] auto-mint refused', { error: summarizeError(error) }); }
      return; // one mint per exec call is enough
    }
  }

  /** GitService-path tap: a platform push through GitService mints the same way, for the project it names. */
  onGitPushed(input: { readonly cwd: string; readonly branch?: string | undefined; readonly project?: string | undefined }): void {
    if (!input.project || resolve(input.project) === resolve(this.deps.workingDirectory)) return;
    try {
      void this.mint(input.cwd, { kind: 'push', branch: input.branch }, captureCiWatchOwner(currentExternalOperationSource()), input.project, turnInputParty()).catch((error) => {
        logger.warn('[ci-watch] auto-mint failed', { cwd: input.cwd, error: summarizeError(error) });
      });
    } catch (error) { logger.warn('[ci-watch] auto-mint refused', { error: summarizeError(error) }); }
  }

  private mint(cwd: string, detected: DetectedCiPush, operation: ExternalOperationSource | undefined, project: string, party: TurnInputParty): Promise<CiWatchSubscription | null> {
    const pending = this.mintQueue.then(() => this.mintOwned(cwd, detected, operation, project, party));
    this.mintQueue = pending.catch(() => {}); return pending;
  }
  private async mintOwned(cwd: string, detected: DetectedCiPush, operation: ExternalOperationSource | undefined, project: string, party: TurnInputParty): Promise<CiWatchSubscription | null> {
    const repo = await (this.deps.resolveRepoSlug
      ? this.deps.resolveRepoSlug(cwd)
      : runGit(cwd, ['remote', 'get-url', 'origin']).then((url) => (url ? parseGitHubSlug(url) : null)));
    if (!repo) return null;

    const branch = detected.branch ?? await (this.deps.resolveCurrentBranch
      ? this.deps.resolveCurrentBranch(cwd)
      : runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']));
    if (!branch || branch === 'HEAD') return null;

    // Keep repeated pushes within one owner deduplicated. A genuine native successor
    // has its own issued lifetime, even while the previous verdict is retiring.
    const existing = await this.deps.service.listWatches();
    const nativeOwner = nativeCiWatchOwner(operation);
    if (existing.some((watch) => watch.repo === repo && watch.ref === branch
      && (!nativeOwner || !watch.continuationId || watch.continuationId === nativeOwner.id))) return null;

    const watch = await this.deps.service.createWatch({
      repo,
      ref: branch,
      deliveryChannel: this.deps.deliveryChannel ?? DEFAULT_AUTO_WATCH_CHANNEL,
      project,
      party,
    }, operation);
    logger.info('[ci-watch] watch self-minted at the push seam', { repo, ref: branch, id: watch.id });
    return watch;
  }
}
