/**
 * setup.ts
 *
 * Worktree cold-start setup, the per-project provisioning that makes an
 * isolated/worktree agent usable instead of broken-by-default. A fresh git
 * worktree is checked out from a committed branch, so it has NONE of the
 * working tree's installed dependencies, generated code, or untracked local
 * files. This module runs configured setup commands (install, codegen) in the
 * worktree and carries over configured untracked files (globs) from the source
 * working tree, capturing honest logs and an honest terminal state.
 *
 * Honesty contract: a command that exits non-zero stops the run and yields
 * state `failed` with the failing step's captured output, never a silent
 * best-effort. No commands AND no carry-over globs configured yields `skipped`
 * (there was nothing to do), which is distinct from `succeeded` (work ran and
 * passed).
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Per-project worktree setup configuration (resolved from the daemon config). */
export interface WorktreeSetupConfig {
  /** Shell command lines to run, in order, in the new worktree (e.g. `bun install`, `bun run codegen`). */
  readonly commands: readonly string[];
  /** Globs (relative to the source working tree) of UNTRACKED or git-ignored files to copy into the new worktree (e.g. `.env`, `.env.*`, `config/local.json`). */
  readonly carryOverGlobs: readonly string[];
  /** Which lists were derived from the repository (setting `auto`) rather than configured, so a failure names its source. */
  readonly derived?: { readonly commands: boolean; readonly carryOverGlobs: boolean } | undefined;
}

/**
 * One worktree setup list setting (`worktree.setup.commands` or
 * `worktree.setup.carryOverGlobs`): `auto` derives it from the repository
 * ({@link deriveWorktreeSetup}), `none` runs or copies nothing, and a list is
 * used as given. Stored as the list, or as `{ "mode": "auto" }` /
 * `{ "mode": "none" }`; an empty list reads as `auto`, the default.
 */
export type WorktreeSetupChoice =
  | { readonly mode: 'auto' }
  | { readonly mode: 'none' }
  | { readonly mode: 'list'; readonly values: readonly string[] };

/** The stored value of a choice: what a settings editor writes. */
export type WorktreeSetupListSetting = readonly string[] | { readonly mode: 'auto' | 'none' };

/** Read one worktree setup list setting as its stated mode. */
export function readWorktreeSetupChoice(value: unknown): WorktreeSetupChoice {
  if (value === 'none') return { mode: 'none' };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { readonly mode?: unknown }).mode === 'none') {
    return { mode: 'none' };
  }
  const values = readStringArray(value);
  return values.length > 0 ? { mode: 'list', values } : { mode: 'auto' };
}

/** The stored value for a choice; `auto` is stored as the empty default list. */
export function worktreeSetupSettingValue(choice: WorktreeSetupChoice): WorktreeSetupListSetting {
  return choice.mode === 'list' ? [...choice.values] : choice.mode === 'none' ? { mode: 'none' } : [];
}

/** The suffix a failed derived step carries, so nobody reads it as a configured one. */
function derivedNote(key: 'worktree.setup.commands' | 'worktree.setup.carryOverGlobs'): string {
  return ` (derived from the repository because ${key} is auto; set it to none or to a list to change it)`;
}

/** The honest terminal state of a setup run. */
export type WorktreeSetupState = 'skipped' | 'succeeded' | 'failed';

/** One step of a setup run, a single command, or the aggregate carry-over pass. */
export interface WorktreeSetupStep {
  readonly kind: 'command' | 'carry-over';
  /** The command line, or a human label for the carry-over pass. */
  readonly label: string;
  readonly ok: boolean;
  /** Process exit code for a command step; absent for carry-over. */
  readonly exitCode?: number | undefined;
  /** Captured combined stdout+stderr for a command, or the list of carried-over paths for carry-over. Bounded. */
  readonly output: string;
}

/** The full result of a setup run, persisted onto the worktree record and returned by the rerun verb. */
export interface WorktreeSetupResult {
  readonly state: WorktreeSetupState;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly steps: readonly WorktreeSetupStep[];
  /** Present only when state === 'failed': the honest reason (the failing command line, or an I/O error). */
  readonly error?: string | undefined;
}

/** Outcome of running one command: injectable so tests drive it without spawning real processes. */
export interface WorktreeCommandOutcome {
  readonly exitCode: number;
  readonly output: string;
  /** True when the command was stopped because it ran past its time limit. */
  readonly timedOut?: boolean | undefined;
}

/** Runs a single shell command line in `cwd`, returning its exit code and captured combined output. */
export type WorktreeCommandRunner = (commandLine: string, cwd: string, signal?: AbortSignal) => Promise<WorktreeCommandOutcome>;

/**
 * Whether one setup command may run, decided the way an `exec` tool call of
 * the same command is (the permission check). `reason` says why not.
 */
export type WorktreeSetupCommandAdmission = (commandLine: string, cwd: string) => Promise<{ readonly allowed: boolean; readonly reason?: string | undefined }>;

/**
 * Lists the files (relative paths) in the source working tree that are not
 * committed, the carry-over candidate set. That includes files git ignores,
 * since local config such as `.env` is almost always ignored; `globs` lets the
 * lister look only for what will be copied instead of walking every ignored
 * dependency folder. Injectable for tests.
 */
export type UntrackedFileLister = (sourceRoot: string, globs?: readonly string[]) => Promise<readonly string[]>;

export interface RunWorktreeSetupOptions {
  readonly runCommand?: WorktreeCommandRunner | undefined;
  readonly listUntracked?: UntrackedFileLister | undefined;
  readonly now?: (() => number) | undefined;
  /** Time limit for each setup command when the default runner is used. Defaults to {@link DEFAULT_SETUP_COMMAND_TIMEOUT_MS}. */
  readonly commandTimeoutMs?: number | undefined;
  /** Each command passes this check before it runs; a refused command fails the setup with the reason. */
  readonly admitCommand?: WorktreeSetupCommandAdmission | undefined;
  /** The run's cancellation: a command in progress is stopped and no later step starts. */
  readonly signal?: AbortSignal | undefined;
}

/** Ten minutes: long enough for a cold install on a slow link, short enough that a stalled one is reported rather than waited on forever. */
export const DEFAULT_SETUP_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** Cap captured command output so a chatty install never bloats the persisted record. */
const MAX_STEP_OUTPUT_BYTES = 16_384;

function clampOutput(text: string): string {
  if (text.length <= MAX_STEP_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_STEP_OUTPUT_BYTES)}\n…[truncated ${text.length - MAX_STEP_OUTPUT_BYTES} bytes]`;
}

/**
 * A command runner that stops a command still running after `timeoutMs`. The
 * command gets its own process group so the stop reaches what it started
 * (`bun install` spawns children), and no stdin, so a prompt cannot wait for a
 * keypress nobody will make.
 */
export function createWorktreeCommandRunner(timeoutMs: number = DEFAULT_SETUP_COMMAND_TIMEOUT_MS): WorktreeCommandRunner {
  return async (commandLine, cwd, signal) => {
    signal?.throwIfAborted();
    const proc = Bun.spawn(['sh', '-c', commandLine], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
      detached: true,
    });
    let timedOut = false;
    const stop = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, output: clampOutput([stdout, stderr].filter((s) => s.length > 0).join('\n')), ...(timedOut ? { timedOut } : {}) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  };
}

async function gitLines(sourceRoot: string, args: readonly string[]): Promise<string[]> {
  const proc = Bun.spawn(['git', ...args], { cwd: sourceRoot, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  // An empty list from a failed git would read as "nothing to carry over" and report success without the env files.
  if (exitCode !== 0) throw new Error(`git ${args[0]} exited ${exitCode} in ${sourceRoot}${err.trim() ? `: ${err.trim()}` : ''}`);
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Default lister: files git does not track, plus the git-IGNORED files that
 * match the globs (a repo's `.env` is nearly always ignored). Ignored files
 * are only listed through the globs as pathspecs, so a large ignored folder
 * such as `node_modules` is never walked unless a glob names it.
 */
const defaultListUntracked: UntrackedFileLister = async (sourceRoot, globs = []) => {
  const untracked = await gitLines(sourceRoot, ['ls-files', '--others', '--exclude-standard']);
  const pathspecs = globs.filter((glob) => glob.length > 0 && !glob.startsWith(':')).map((glob) => `:(glob)${glob}`);
  if (pathspecs.length === 0) return untracked;
  const ignored = await gitLines(sourceRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...pathspecs]);
  return [...new Set([...untracked, ...ignored])];
};

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  for (const pattern of globs) {
    try {
      if (new Bun.Glob(pattern).match(path)) return true;
    } catch {
      // An invalid glob never matches (and never throws the whole run).
    }
  }
  return false;
}

/**
 * Run cold-start setup for a freshly-created worktree. Runs each command in
 * order (stopping on the first non-zero exit), then copies untracked files
 * matching the carry-over globs from `sourceRoot` into `worktreePath`.
 */
export async function runWorktreeSetup(
  worktreePath: string,
  sourceRoot: string,
  config: WorktreeSetupConfig,
  options: RunWorktreeSetupOptions = {},
): Promise<WorktreeSetupResult> {
  const now = options.now ?? Date.now;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_SETUP_COMMAND_TIMEOUT_MS;
  const runCommand = options.runCommand ?? createWorktreeCommandRunner(commandTimeoutMs);
  const listUntracked = options.listUntracked ?? defaultListUntracked;
  const startedAt = now();
  const steps: WorktreeSetupStep[] = [];

  const hasCommands = config.commands.length > 0;
  const hasGlobs = config.carryOverGlobs.length > 0;
  if (!hasCommands && !hasGlobs) {
    return { state: 'skipped', startedAt, completedAt: now(), steps: [] };
  }

  for (const commandLine of config.commands) {
    if (options.signal?.aborted) {
      steps.push({ kind: 'command', label: commandLine, ok: false, output: 'not run: the work was cancelled' });
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup was cancelled before ${commandLine}` };
    }
    if (options.admitCommand) {
      const admission = await options.admitCommand(commandLine, worktreePath);
      if (!admission.allowed) {
        const why = admission.reason ?? 'the permission check refused it';
        steps.push({ kind: 'command', label: commandLine, ok: false, output: `not run: ${why}` });
        return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup command not allowed: ${commandLine} (${why})${config.derived?.commands ? derivedNote('worktree.setup.commands') : ''}` };
      }
    }
    let outcome: WorktreeCommandOutcome;
    try {
      outcome = await runCommand(commandLine, worktreePath, options.signal);
    } catch (err) {
      const output = summarizeError(err);
      steps.push({ kind: 'command', label: commandLine, ok: false, output: clampOutput(output) });
      logger.warn('runWorktreeSetup: command threw', { commandLine, worktreePath, error: output });
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup command failed to run: ${commandLine}${config.derived?.commands ? derivedNote('worktree.setup.commands') : ''}` };
    }
    const ok = outcome.exitCode === 0;
    steps.push({ kind: 'command', label: commandLine, ok, exitCode: outcome.exitCode, output: outcome.output });
    if (!ok) {
      logger.warn('runWorktreeSetup: command exited non-zero', { commandLine, worktreePath, exitCode: outcome.exitCode, timedOut: outcome.timedOut === true });
      const source = config.derived?.commands ? derivedNote('worktree.setup.commands') : '';
      if (outcome.timedOut) {
        return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup command was stopped after running longer than ${commandTimeoutMs >= 1000 ? `${Math.round(commandTimeoutMs / 1000)}s` : `${commandTimeoutMs}ms`}: ${commandLine}${source}` };
      }
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `setup command exited ${outcome.exitCode}: ${commandLine}${source}` };
    }
  }

  if (hasGlobs) {
    const carriedOver: string[] = [];
    let carryError: string | undefined;
    try {
      const untracked = await listUntracked(sourceRoot, config.carryOverGlobs);
      for (const relative of untracked) {
        if (!matchesAnyGlob(relative, config.carryOverGlobs)) continue;
        const from = join(sourceRoot, relative);
        const to = join(worktreePath, relative);
        if (!existsSync(from)) continue;
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
        carriedOver.push(relative);
      }
    } catch (err) {
      carryError = summarizeError(err);
    }
    if (carryError) {
      steps.push({ kind: 'carry-over', label: 'carry over untracked files', ok: false, output: clampOutput(carryError) });
      return { state: 'failed', startedAt, completedAt: now(), steps, error: `carry-over of untracked files failed: ${carryError}${config.derived?.carryOverGlobs ? derivedNote('worktree.setup.carryOverGlobs') : ''}` };
    }
    steps.push({
      kind: 'carry-over',
      label: 'carry over untracked files',
      ok: true,
      output: carriedOver.length > 0
        ? carriedOver.join('\n')
        : `no file in ${sourceRoot} matched the carry-over globs (${config.carryOverGlobs.join(', ')}); nothing was copied`,
    });
  }

  return { state: 'succeeded', startedAt, completedAt: now(), steps };
}

/**
 * The configured lists only, with no derivation: `worktree.setup.commands`
 * (command lines) and `worktree.setup.carryOverGlobs` (globs). `auto`, `none`
 * and malformed values read as empty, never a throw. What a new worktree gets
 * is {@link resolveEffectiveWorktreeSetup}.
 */
export function resolveWorktreeSetupConfig(get: (key: string) => unknown): WorktreeSetupConfig {
  return {
    commands: readStringArray(get('worktree.setup.commands')),
    carryOverGlobs: readStringArray(get('worktree.setup.carryOverGlobs')),
  };
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Injectable filesystem probes for derivation, so tests never need a real repo. */
export interface DeriveSetupIo {
  readonly fileExists: (path: string) => boolean;
  readonly listDir: (path: string) => readonly string[];
  /** The active virtual environment of the process that runs setup commands, if any. */
  readonly virtualEnv?: (() => string | undefined) | undefined;
}

const defaultDeriveIo: DeriveSetupIo = {
  virtualEnv: () => process.env['VIRTUAL_ENV'] || undefined,
  fileExists: (path) => existsSync(path),
  listDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/**
 * Lockfile → install command, grouped per ecosystem so a polyglot repo derives
 * one install per ecosystem (first match within a group wins, in the listed
 * precedence). The derived commands are lockfile-faithful (`npm ci`, frozen
 * lockfiles) so a worktree install can never rewrite the lockfile.
 */
const LOCKFILE_ECOSYSTEMS: ReadonlyArray<ReadonlyArray<{ readonly file: string; readonly command: string; readonly needsVirtualEnv?: true }>> = [
  // JavaScript/TypeScript, one package manager per repo.
  [
    { file: 'bun.lock', command: 'bun install' },
    { file: 'bun.lockb', command: 'bun install' },
    { file: 'package-lock.json', command: 'npm ci' },
    { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
    { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  ],
  // Python, uv's lock wins over a bare requirements file.
  [
    { file: 'uv.lock', command: 'uv sync' },
    // pip with no active virtual environment installs into the user's own
    // Python, so it is derived only when setup runs inside one.
    { file: 'requirements.txt', command: 'pip install -r requirements.txt', needsVirtualEnv: true },
  ],
  // Rust / Go.
  [{ file: 'Cargo.lock', command: 'cargo fetch' }],
  [{ file: 'go.sum', command: 'go mod download' }],
];

/**
 * Derive worktree setup from the repo itself: each ecosystem's lockfile yields
 * its install command, and the presence of `.env` / `.env.*` files at the repo
 * root yields the carry-over globs for them. A repo with no lockfile and no
 * env files derives NOTHING, setup stays an honest `skipped`, exactly as if
 * no config existed. `pip install -r requirements.txt` is derived only when a
 * virtual environment is active for the setup commands.
 */
export function deriveWorktreeSetup(sourceRoot: string, io: DeriveSetupIo = defaultDeriveIo): WorktreeSetupConfig {
  const commands: string[] = [];
  const inVirtualEnv = (io.virtualEnv ?? defaultDeriveIo.virtualEnv)?.() !== undefined;
  for (const ecosystem of LOCKFILE_ECOSYSTEMS) {
    const match = ecosystem.find((candidate) => (candidate.needsVirtualEnv !== true || inVirtualEnv) && io.fileExists(join(sourceRoot, candidate.file)));
    if (match) commands.push(match.command);
  }
  const rootEntries = io.listDir(sourceRoot);
  const hasEnvFiles = rootEntries.some((entry) => entry === '.env' || entry.startsWith('.env.'));
  return {
    commands,
    carryOverGlobs: hasEnvFiles ? ['.env', '.env.*'] : [],
  };
}

/**
 * The EFFECTIVE worktree setup, one stated mode per list: `auto` (the default)
 * derives it from the repository, `none` runs or copies nothing, a list is used
 * as given. The only reader the provisioning paths use, so the settings text,
 * `/worktree setup` and a new worktree agree.
 */
export function resolveEffectiveWorktreeSetup(
  get: (key: string) => unknown,
  sourceRoot: string,
  io: DeriveSetupIo = defaultDeriveIo,
): WorktreeSetupConfig {
  const commands = readWorktreeSetupChoice(get('worktree.setup.commands'));
  const globs = readWorktreeSetupChoice(get('worktree.setup.carryOverGlobs'));
  const derived = commands.mode === 'auto' || globs.mode === 'auto' ? deriveWorktreeSetup(sourceRoot, io) : undefined;
  const pick = (choice: WorktreeSetupChoice, fromRepo: readonly string[] | undefined): readonly string[] =>
    choice.mode === 'list' ? choice.values : choice.mode === 'none' ? [] : (fromRepo ?? []);
  return {
    commands: pick(commands, derived?.commands),
    carryOverGlobs: pick(globs, derived?.carryOverGlobs),
    derived: { commands: commands.mode === 'auto', carryOverGlobs: globs.mode === 'auto' },
  };
}
