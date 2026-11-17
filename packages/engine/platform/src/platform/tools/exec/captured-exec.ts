import { logger } from '../../utils/logger.js';
import { projectCapturedExecBunRuntime, type CapturedExecBunRuntimeInput } from './captured-bun-runtime-input.js';
import { resolveProcessCapturedBunRuntimeExecutable } from '../../runtime/captured-bun-runtime.js';
import { collectCommandNodes } from '../../runtime/permissions/normalization/ast.js';
import { parseAST } from '../../runtime/permissions/normalization/parser.js';
import { MAX_INPUT_LENGTH, MAX_TOKEN_COUNT, tokenize } from '../../runtime/permissions/normalization/tokenizer.js';
import { projectCapturedExecNodeRuntime, type CapturedExecNodeRuntimeInput } from './captured-exec-runtime-input.js';
import { assertCapturedPublicationOwner, type CapturedPublicationLease } from '../shared/captured-publication.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { discardCapturedTemporary } from './captured-exec-cleanup.js';
import { executeCapturedFileOperations } from './captured-exec-file-ops.js';
import { computeCapturedMasks } from './captured-exec-masks.js';
import { CapturedBoundaryRefusal, capturedRefusalText } from './captured-exec-refusal.js';
import { createSafeRegex } from '../../utils/safe-regex.js';
import { runInteractiveCommand, type ExecInteractionRuntime } from './interactive.js';
import { projectCapturedExecDependencies, type CapturedExecDependencyInput } from './captured-exec-dependencies.js';
/**
 * A captured command runs in one bubblewrap spawn that mounts the member's
 * view (its worktree) in place: read-write for a member that may change it,
 * read-only otherwise. The owner's read rules become mount masks computed once
 * per command (a denied or reserved directory is an empty tmpfs, a denied file
 * is /dev/null), dependencies and pinned runtimes are read-only binds, and
 * authority is proven once before the spawn and once before the result is
 * returned. Nothing is copied or compared. This is a filesystem boundary, not
 * another command/risk/retry evaluator.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthorityMutable,
  contractInputAuthoritySourceRoot,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import type { ReadAccessFilter } from '../shared/read-access.js';
import type { ExecCommandInput, ExecCommandResult, ExecFileOp } from './schema.js';

/** Characters of one stream held in memory; the rest is dropped and the result says so. */
export const MAX_CAPTURE_CHARS = 4_000_000;
/** The tail of the output an until pattern is tested against, so each chunk costs a bounded amount. */
export const UNTIL_PATTERN_WINDOW_CHARS = 65_536;

export interface CapturedExecAuthority {
  /** Actual host run owns staged input resources; never read from tool JSON. */
  readonly retainInputResource?: ((dispose: () => void) => void) | undefined;
  readonly bunRuntimeInput?: CapturedExecBunRuntimeInput | undefined;
  readonly bunRuntimeAdmission?: ((signal?: AbortSignal) => Promise<CapturedExecBunRuntimeInput>) | undefined;
  readonly nodeRuntimeInput?: CapturedExecNodeRuntimeInput | undefined;
  readonly nodeRuntimeAdmission?: ((signal?: AbortSignal) => Promise<CapturedExecNodeRuntimeInput>) | undefined;
  readonly nodeRuntimeUnavailable?: string | undefined;
  readonly dependencyInputs?: readonly CapturedExecDependencyInput[] | undefined;
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly readAccessFilter: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
}
export type CapturedExecAvailability =
  | { readonly available: true; readonly backend: 'linux-bwrap-projection' }
  | { readonly available: false; readonly reason: 'unsupported-platform' | 'unsupported-architecture' | 'missing-bwrap' | 'unusable-boundary'; readonly message: string };
const held = (reason: string): string => `Captured exec held: ${reason}. Output withheld; nothing was changed. Re-read the files you rely on, then rerun if still needed.`;
const cancelledNote = (wrote: boolean): string => wrote
  ? 'Captured exec cancelled. Output withheld; any file changes it made before it stopped are in the project, so read the files before rerunning.'
  : 'Captured exec cancelled before it ran. Output withheld; nothing was changed.';
const HELD_AFTER_RUN = 'Captured exec held after it ran: its file changes are in the project; only output is withheld. Do not rerun to repeat them; read the changed files instead.';
const timedOutNote = (timeoutMs: number, wrote: boolean): string => `Captured exec timed out after ${timeoutMs}ms and was stopped. Output withheld; ${wrote ? 'any file changes it made before it stopped are in the project' : 'nothing was changed'}.`;


/** These are not exec schema inputs; never pretend that supplied stdin ran. */
export function capturedExecUnsupportedOptions(input: Record<string, unknown>): string[] {
  return ['stdin', 'input'].filter((name) => Object.prototype.hasOwnProperty.call(input, name));
}

/** No socket creation (including io_uring), no alternate ABI. Seccomp keeps
 * network isolation enforceable when bwrap's loopback setup is unavailable.
 */
function socketFilter(network: 'enabled' | 'disabled' = 'disabled'): Buffer {
  const architecture = process.arch === 'x64' ? 0xc000003e : process.arch === 'arm64' ? 0xc00000b7 : undefined;
  if (architecture === undefined) throw new Error('unsupported captured sandbox architecture');
  const denied = network === 'enabled' ? [] : process.arch === 'x64' ? [41, 53, 425] : [198, 199, 425];
  const instructions: number[][] = [
    [0x20, 0, 0, 4], [0x15, 1, 0, architecture], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
  ];
  for (const syscall of denied) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    bytes.writeUInt16LE(code!, i * 8);
    bytes[i * 8 + 2] = yes!;
    bytes[i * 8 + 3] = no!;
    bytes.writeUInt32LE(value!, i * 8 + 4);
  });
  return bytes;
}
function runtimeArgv(nodeRuntime = false, bunRuntime = false): string[] {
  const argv = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
    '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib'];
  if (existsSync('/usr/lib64')) argv.push('--ro-bind', '/usr/lib64', '/usr/lib64', '--symlink', 'usr/lib64', '/lib64');
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/captured');
  if (!bunRuntime && resolveProcessCapturedBunRuntimeExecutable() === process.execPath && (process.versions.bun || !nodeRuntime))
    argv.push('--ro-bind', process.execPath, `/captured-runtime/bin/${process.versions.bun ? 'bun' : 'node'}`);
  return argv;
}

let provenBoundary = false;

function capturedHostRefusal(): CapturedExecAvailability | null {
  if (process.platform !== 'linux') return { available: false, reason: 'unsupported-platform', message: 'Captured exec currently requires Linux with bubblewrap; this host platform has no supported captured boundary.' };
  if (process.arch !== 'x64' && process.arch !== 'arm64') return { available: false, reason: 'unsupported-architecture', message: 'Captured exec currently supports Linux x64 and arm64 only.' };
  if (!existsSync('/usr/bin/bwrap')) return { available: false, reason: 'missing-bwrap', message: 'Captured exec requires bubblewrap at /usr/bin/bwrap.' };
  return null;
}

/**
 * Actual supported-host proof, not a PATH/existence claim. No host fallback.
 * The platform and bubblewrap checks run every time; the boundary run, which
 * spawns bubblewrap and writes a temporary file synchronously, is kept after it
 * succeeds once, since the host does not lose it between commands. A failed
 * proof is repeated, so a fixed host is noticed.
 */
export async function probeCapturedExecAvailability(): Promise<CapturedExecAvailability> {
  const refusal = capturedHostRefusal();
  if (refusal) return refusal;
  if (provenBoundary) return { available: true, backend: 'linux-bwrap-projection' };
  const probed = await probeCapturedExecBoundary();
  if (probed.available) provenBoundary = true;
  return probed;
}

async function probeCapturedExecBoundary(): Promise<CapturedExecAvailability> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'captured-exec-probe-'));
    const path = join(dir, 'sockets.bpf');
    await writeFile(path, socketFilter());
    const fd = openSync(path, 'r');
    try {
      const result = spawnSync('/usr/bin/bwrap', [...runtimeArgv(), '--chdir', '/tmp', '--seccomp', '3', '--', '/bin/true'], {
        env: {}, stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000,
      });
      if (result.status === 0) return { available: true, backend: 'linux-bwrap-projection' };
    } finally { closeSync(fd); }
  } catch { /* A fixed public capability diagnosis never includes host output. */ }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  return { available: false, reason: 'unusable-boundary', message: 'The captured exec bubblewrap mount/PID/seccomp boundary could not be established on this host. Host execution is unavailable as a fallback.' };
}
/** Validate an admitted interpreter in an empty boundary before project input
 * can run. A compiled product must never be treated as an ordinary Bun CLI.
 */
export async function probeCapturedBunRuntime(executable: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!(await probeCapturedExecAvailability()).available) return false;
  const temporary = await mkdtemp(join(tmpdir(), 'captured-bun-probe-'));
  let fd: number | undefined;
  try {
    const filter = join(temporary, 'sockets.bpf');
    await writeFile(filter, socketFilter());
    fd = openSync(filter, 'r');
    signal?.throwIfAborted();
    const argv = [...runtimeArgv(false, true), '--ro-bind', executable, '/captured-runtime/bin/bun',
      '--chdir', '/tmp', '--seccomp', '3', '--', '/captured-runtime/bin/bun', '--no-env-file', '--config=/dev/null',
      '--print', 'typeof Bun === "object" && typeof Bun.version === "string" ? "GOODVIBES_CAPTURED_ORDINARY_BUN" : "INVALID"'];
    const child = spawn('/usr/bin/bwrap', argv, { env: {}, stdio: ['ignore', 'pipe', 'ignore', fd] });
    closeSync(fd); fd = undefined;
    let output = ''; let stopped = false;
    const stop = (): void => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 5000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      child.stdout!.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 512) stop(); });
      const code = await new Promise<number | null>((resolveExit) => {
        child.once('error', () => resolveExit(null)); child.once('close', resolveExit);
      });
      signal?.throwIfAborted();
      return !stopped && code === 0 && output === 'GOODVIBES_CAPTURED_ORDINARY_BUN\n';
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    await rm(temporary, { recursive: true, force: true });
  }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export interface CapturedExecutionLease {
  readonly pid: number;
  readonly readOutput: () => Promise<ExecCommandResult>;
}
export interface CapturedExecutionObserver {
  /** Construction-owned source, mounted read-only for this invocation only. */
  readonly script?: { readonly name: string; readonly content: string } | undefined;
  /** Final construction-owned command admission, after all async preparation. */
  readonly beforeSpawn?: (() => void) | undefined;
  /** Final publication restriction; retained jobs supply their independent owner constraint. */
  readonly beforePublish?: (() => void) | undefined;
  /** Construction-only repair candidate: formatted in a private file over its path; nothing else is writable for that run. */
  readonly repairCandidate?: { readonly path: string; readonly content: string; readonly receive: (content: string) => void } | undefined;
  /** Construction-only owner for nested write/edit validators, never model input. */
  readonly publicationLease?: CapturedPublicationLease | undefined;
  readonly fileOps?: ExecFileOp[] | undefined;
  readonly onFileOperations?: ((result: Awaited<ReturnType<typeof executeCapturedFileOperations>>) => void) | undefined;
  readonly interaction?: ExecInteractionRuntime | undefined;
  readonly onUntilMatched?: (() => void) | undefined;
  readonly onStarted?: ((lease: CapturedExecutionLease) => void) | undefined;
}

/** Availability only: this never grants runtime/file/process authority. Keep
 * the existing simple Bun build/test and shell-primitive substrate lightweight.
 * Indirect Node use inside those Bun workflows remains unavailable unless this
 * command also requests the Node runtime. Unknown shell shapes take the full
 * construction-owned admission, never a guessed grant or a host fallback.
 */
function needsRuntime(command: string, input: ExecCommandInput, runtime: 'node' | 'bun'): boolean {
  if (input.env?.PATH !== undefined) return true;
  if (command.length >= MAX_INPUT_LENGTH || command.includes('\n') || command.includes('\r')) return true;
  const tokens = tokenize(command.trim());
  if (tokens.length === 0 || tokens.length >= MAX_TOKEN_COUNT) return true;
  if (tokens.some((token) => token.type === 'subshell' || token.value.startsWith('<<') ||
    (token.type !== 'operator' && token.type !== 'pipe' && /[$`\\&(){}#]/.test(token.value)))) return true;
  const nodes = collectCommandNodes(parseAST(tokens));
  const consumed = new Set(nodes.flatMap((node) => node.tokens.map((token) => token.position)));
  if (nodes.length === 0 || nodes.some((node) => node.parseError) ||
    tokens.some((token) => token.type !== 'operator' && token.type !== 'pipe' && !consumed.has(token.position))) return true;
  const literal = (value: string | undefined, word: string): boolean =>
    value === word || value === `'${word}'` || value === `"${word}"`;
  const primitives = new Set([':', 'true', 'false', 'echo', 'printf', 'sleep', 'pwd', 'cd', 'test', '[']);
  return nodes.some((node) => {
    if (node.tokens[0]?.type !== 'command' || !literal(node.tokens[0].value, node.command)) return true;
    if (primitives.has(node.command)) return false;
    if (runtime === 'bun') return true;
    const argument = (index: number, word: string): boolean =>
      node.tokens[index]?.type === 'argument' && literal(node.tokens[index]?.value, word);
    return node.command !== 'bun' || !(argument(1, 'build') || argument(1, 'test') ||
      (argument(1, 'run') && (argument(2, 'build') || argument(2, 'test'))));
  });
}

export async function runCapturedCommand(
  binding: CapturedExecAuthority,
  command: string,
  input: ExecCommandInput,
  workingDirectory: string,
  timeoutMs: number,
  signal?: AbortSignal,
  network: 'enabled' | 'disabled' = 'disabled',
  ambientEnvironment: Readonly<Record<string, string>> = {},
  observer: CapturedExecutionObserver = {},
): Promise<ExecCommandResult> {
  binding = Object.freeze({ ...binding, dependencyInputs: binding.dependencyInputs ? Object.freeze([...binding.dependencyInputs]) : undefined });
  input = structuredClone(input);
  observer = { ...observer, script: observer.script ? Object.freeze({ ...observer.script }) : undefined, repairCandidate: observer.repairCandidate ? Object.freeze({ ...observer.repairCandidate }) : undefined, fileOps: observer.fileOps ? structuredClone(observer.fileOps) : undefined };
  const start = Date.now();
  const root = resolve(binding.root);
  const cwd = resolve(workingDirectory, input.cwd ?? '.');
  const combined = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  const operations = new AbortController();
  const operationSignal = combined ? AbortSignal.any([combined, operations.signal]) : operations.signal;
  const mutable = contractInputAuthorityMutable(binding.authority);
  const candidate = observer.repairCandidate;
  let temporary: string | undefined;
  let placeholder: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killed = false;
  let timedOut = false;
  let untilMatched = false;
  let stop = (): void => {};
  let childCompletion: Promise<number | null> | undefined;
  let checkInputs = async (): Promise<void> => {};
  const authorize = (path: string, current: AbortSignal = operationSignal): Promise<string> => executePolicyCheck(
    () => authorizeContractInputPath(binding.authority, path, binding.readAccessFilter, current), current);
  // Authority is proven once before the command starts and once before its
  // result is returned; the mounts and masks hold the boundary in between.
  const check = async (): Promise<void> => executePolicyCheck(async () => {
    if (candidate) {
      if (!observer.publicationLease) throw new Error('repair requires its active publication owner');
      assertCapturedPublicationOwner(observer.publicationLease, binding.authority);
    }
    if (!binding.readAccessFilter) throw new Error('captured exec requires original-owner read authorization');
    await assertContractInputAuthority(binding.authority, root, combined);
    await checkInputs();
  }, operationSignal);
  // Once the command has started in a writable view, its writes are in the project.
  let wrote = false;
  // A timed-out PTY run reports the prompt it was waiting on, but only after
  // authority is proven again.
  let promptDiagnostics: Pick<ExecCommandResult, 'pending_prompt' | 'prompt_declined'> = {};
  try {
    if (!within(root, resolve(workingDirectory)) || !within(root, cwd)) throw new Error('outside captured working directory');
    if (['/usr', '/bin', '/lib', '/lib64', '/proc', '/dev'].some((path) => within(path, root) || within(root, path)))
      throw new Error('captured root overlaps runtime mounts');
    const unsupported = capturedExecUnsupportedOptions(input as unknown as Record<string, unknown>);
    if (unsupported.length > 0) return {
      cmd: command, cwd, exit_code: null, stdout: '', success: false, denied: true,
      stderr: 'Captured exec does not support stdin/input options; use a shell pipe or an authorized input file.',
      captured_exec_unsupported_options: unsupported,
    };
    if (input.background) throw new Error('captured background must be retained by its ProcessManager owner');
    await using untilPattern = input.until ? await createSafeRegex(input.until.pattern, '', { operation: 'exec until pattern', signal: operationSignal }) : undefined;
    const availability = await probeCapturedExecAvailability();
    if (!availability.available) return { cmd: command, cwd, exit_code: null, stdout: '', stderr: availability.message, success: false, denied: true,
      sandboxed: false, sandbox_boundary: 'captured boundary unavailable', captured_exec_availability: availability, duration_ms: Date.now() - start };
    if (cwd !== root) await authorize(cwd);
    // Runtime selection changes availability only. Fixed validators and every
    // selected command share the existing construction-owned pinned admission.
    if (!binding.nodeRuntimeInput && binding.nodeRuntimeAdmission && needsRuntime(command, input, 'node')) {
      try {
        const nodeRuntimeInput = await executePolicyCheck(() => binding.nodeRuntimeAdmission!(operationSignal), operationSignal);
        binding = Object.freeze({ ...binding, nodeRuntimeInput });
      } catch (error) {
        operationSignal.throwIfAborted();
        // The command still runs, with a stub that says the runtime is
        // unavailable; the cause is logged so it is not lost behind that stub.
        logger.warn('captured exec: Node runtime admission failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!binding.bunRuntimeInput && binding.bunRuntimeAdmission && needsRuntime(command, input, 'bun')) {
      try {
        const bunRuntimeInput = await executePolicyCheck(() => binding.bunRuntimeAdmission!(operationSignal), operationSignal);
        binding = Object.freeze({ ...binding, bunRuntimeInput });
      } catch (error) {
        operationSignal.throwIfAborted();
        logger.warn('captured exec: Bun runtime admission failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    temporary = await mkdtemp(join(tmpdir(), 'goodvibes-captured-exec-'));
    if (observer.fileOps?.some((operation) => operation.op !== 'delete' || !operation.dry_run) && !mutable)
      throw new Error('immutable captured input cannot apply file operations');
    const fileOperations = await executeCapturedFileOperations(root, observer.fileOps, authorize, () => { wrote = true; });
    observer.onFileOperations?.(fileOperations);
    // A repair candidate is formatted in a private file mounted over its path;
    // the rest of the view is read-only for that run and nothing is applied.
    let candidateRelative: string | undefined;
    let candidateFile: string | undefined;
    if (candidate) {
      if (!observer.publicationLease) throw new Error('repair requires its active publication owner');
      assertCapturedPublicationOwner(observer.publicationLease, binding.authority);
      const target = resolve(root, candidate.path);
      candidateRelative = relative(root, target);
      await authorize(target);
      const stat = await lstat(target).catch(() => undefined);
      if (!candidateRelative || !stat?.isFile() || stat.isSymbolicLink()) throw new Error('repair candidate requires one existing admitted file');
      candidateFile = join(temporary, 'repair-candidate');
      await writeFile(candidateFile, candidate.content, { encoding: 'utf8', mode: stat.mode & 0o777 });
    }
    const dependencies = await projectCapturedExecDependencies(binding, operationSignal);
    const nodeRuntime = await projectCapturedExecNodeRuntime(binding, temporary, operationSignal);
    const bunRuntime = await projectCapturedExecBunRuntime(binding, temporary, operationSignal);
    checkInputs = async () => { await dependencies.check(); await nodeRuntime.check(); await bunRuntime.check(); };
    // The owner's read rules over the view, as mount masks: one pass per command.
    const filter = binding.readAccessFilter;
    if (!filter) throw new Error('captured exec requires original-owner read authorization');
    const sourceRoot = contractInputAuthoritySourceRoot(binding.authority);
    const masks = await computeCapturedMasks(root, root, async (rel, current) =>
      await executePolicyCheck(() => filter(join(sourceRoot, rel)), current)
        && await executePolicyCheck(() => filter(join(root, rel)), current),
    operationSignal, { skip: new Set(dependencies.mounts.map((mount) => relative(root, mount.target))) });
    const script = observer.script;
    if (script && !/^\.goodvibes-repl-[a-f0-9-]+\.ts$/.test(script.name)) throw new Error('Invalid captured script name');
    if (script) {
      await writeFile(join(temporary, 'repl-source.ts'), script.content, { flag: 'wx', mode: 0o400 });
      // The source is mounted over an empty file of its own name, removed after the run.
      await writeFile(join(root, script.name), '', { flag: 'wx', mode: 0o400 });
      placeholder = join(root, script.name);
    }
    const filterPath = join(temporary, 'sockets.bpf');
    await writeFile(filterPath, socketFilter(network));
    // Masks can be many: bwrap reads them from a file descriptor, NUL-separated.
    const argsPath = join(temporary, 'mounts.args');
    const mountArgs = [...masks.argv, ...dependencies.argv,
      ...(script ? ['--ro-bind', join(temporary, 'repl-source.ts'), placeholder!] : []),
      ...(candidateFile ? ['--bind', candidateFile, join(root, candidateRelative!)] : []),
      ...(!mutable || candidate ? ['--remount-ro', root] : [])];
    await writeFile(argsPath, mountArgs.map((arg) => `${arg}\0`).join(''));
    await check();
    const fd = openSync(filterPath, 'r');
    const argsFd = openSync(argsPath, 'r');
    const argv = runtimeArgv(Boolean(binding.nodeRuntimeInput || binding.nodeRuntimeAdmission), Boolean(binding.bunRuntimeInput || binding.bunRuntimeAdmission));
    argv.push(...nodeRuntime.argv, ...bunRuntime.argv);
    argv.push('--bind', root, root, '--args', '4', '--chdir', cwd, '--seccomp', '3');
    const environment = { ...ambientEnvironment, PATH: '/captured-runtime/bin:/usr/bin:/bin', HOME: '/home/captured', TMPDIR: '/tmp', LANG: ambientEnvironment.LANG ?? 'C.UTF-8', ...input.env };
    const boundaryStop = new AbortController();
    const executionSignal = combined ? AbortSignal.any([combined, boundaryStop.signal]) : boundaryStop.signal;
    stop = () => { killed = true; operations.abort(); boundaryStop.abort(); };
    let stdout = ''; let stderr = '';
    let stdoutDropped = false; let stderrDropped = false;
    let exitCode: number | null;
    let modeResult: ExecCommandResult | undefined;
    if (observer.interaction) {
      try {
        wrote = wrote || (mutable && !candidate);
        modeResult = await runInteractiveCommand({
          cmdStr: command, cwd: undefined, env: environment, timeoutMs, startTime: start,
          sandboxArgv: ['/usr/bin/bwrap', ...argv, '--'], interaction: observer.interaction,
          signal: executionSignal, beforeSpawn: observer.beforeSpawn, extraStdio: [fd, argsFd], beforeOutput: check,
        });
        stdout = modeResult.stdout; stderr = modeResult.stderr; exitCode = modeResult.exit_code;
        timedOut = modeResult.timed_out === true;
        killed = killed || timedOut || modeResult.cancelled === true;
        if (timedOut && (modeResult.pending_prompt !== undefined || modeResult.prompt_declined)) {
          try {
            await check();
            promptDiagnostics = {
              ...(modeResult.pending_prompt !== undefined ? { pending_prompt: modeResult.pending_prompt } : {}),
              ...(modeResult.prompt_declined ? { prompt_declined: true } : {}),
            };
          } catch { /* Authority did not hold; the prompt stays withheld with the output. */ }
        }
        if (killed) operations.abort();
      } finally { closeSync(fd); closeSync(argsFd); }
    } else {
      argv.push('--', '/bin/sh', '-c', command);
      let child: ReturnType<typeof spawn>;
      try {
        executionSignal.throwIfAborted();
        if (candidate) assertCapturedPublicationOwner(observer.publicationLease!, binding.authority);
        observer.beforeSpawn?.();
        child = spawn('/usr/bin/bwrap', argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe', fd, argsFd] });
        wrote = wrote || (mutable && !candidate);
      } finally { closeSync(fd); closeSync(argsFd); }
      childCompletion = new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject); child.once('close', resolveExit);
      });
      void childCompletion.catch(() => {});
      stop = () => { killed = true; operations.abort(); child.kill('SIGKILL'); };
      const onAbort = (): void => { stop(); };
      executionSignal.addEventListener('abort', onAbort, { once: true });
      if (executionSignal.aborted) onAbort();
      const timeout = (): void => { timedOut = true; stop(); };
      const commandDeadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const untilTimeout = input.until?.timeout_ms ?? 0;
      const initialTimeout = Math.min(timeoutMs > 0 ? timeoutMs : Infinity, untilTimeout > 0 ? untilTimeout : Infinity);
      if (Number.isFinite(initialTimeout)) timer = setTimeout(timeout, initialTimeout);
      let untilDirty = false;
      let checkingUntil = false;
      let untilCompletion: Promise<void> = Promise.resolve();
      const capture = (data: Buffer, output: 'stdout' | 'stderr'): void => {
        // A command that prints without end must not grow the host process: keep a bounded prefix and say the rest was dropped.
        if (output === 'stdout') {
          const room = MAX_CAPTURE_CHARS - stdout.length; const text = data.toString();
          if (text.length > room) stdoutDropped = true;
          if (room > 0) stdout += text.length > room ? text.slice(0, room) : text;
        } else {
          const room = MAX_CAPTURE_CHARS - stderr.length; const text = data.toString();
          if (text.length > room) stderrDropped = true;
          if (room > 0) stderr += text.length > room ? text.slice(0, room) : text;
        }
        untilDirty = true;
        if (checkingUntil || !untilPattern || untilMatched) return;
        checkingUntil = true;
        untilCompletion = (async () => {
          try {
            while (untilDirty && !untilMatched) {
              untilDirty = false;
              if (await untilPattern.test((stdout.slice(-UNTIL_PATTERN_WINDOW_CHARS) + stderr.slice(-UNTIL_PATTERN_WINDOW_CHARS)).slice(-UNTIL_PATTERN_WINDOW_CHARS))) {
                // The readiness line is output a caller acts on: authority holds before it is reported.
                await check();
                untilMatched = true;
                clearTimeout(timer);
                if (input.until?.kill_after) child.kill('SIGKILL');
                else if (Number.isFinite(commandDeadline)) timer = setTimeout(timeout, Math.max(0, commandDeadline - Date.now()));
                observer.onUntilMatched?.();
              }
            }
          } catch { stop(); }
          finally { checkingUntil = false; }
        })();
      };
      child.stdout!.on('data', (data: Buffer) => capture(data, 'stdout'));
      child.stderr!.on('data', (data: Buffer) => capture(data, 'stderr'));
      observer.onStarted?.({ pid: child.pid!, readOutput: async () => {
        await check();
        return { cmd: command, cwd, exit_code: child.exitCode, stdout, stderr, success: true, sandboxed: true };
      } });
      exitCode = await childCompletion;
      await untilCompletion;
      clearTimeout(timer); executionSignal.removeEventListener('abort', onAbort);
    }
    if (killed) {
      return { cmd: command, cwd, exit_code: null, stdout: '', stderr: timedOut ? timedOutNote(timeoutMs, wrote) : cancelledNote(wrote), success: false, timed_out: timedOut,
        ...(timedOut ? promptDiagnostics : { cancelled: true }), ...(wrote ? { captured_changes_published: true } : {}), duration_ms: Date.now() - start };
    }
    // The one proof after the run: the view, its owner and the mounted inputs are still the admitted ones.
    await check();
    untilPattern?.assertCurrent();
    if (wrote) observer.beforePublish?.();
    if (candidate && candidateFile) {
      assertCapturedPublicationOwner(observer.publicationLease!, binding.authority);
      const bytes = await readFile(candidateFile);
      combined?.throwIfAborted();
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('repair candidate is not valid UTF-8');
      candidate.receive(text);
    }
    const failures: string[] = [];
    if (fileOperations.fileOpError) failures.push(fileOperations.fileOpError);
    if (input.expect?.exit_code !== undefined && exitCode !== input.expect.exit_code) failures.push('exit_code expectation failed');
    if (input.expect?.stdout_contains !== undefined && !stdout.includes(input.expect.stdout_contains)) failures.push('stdout expectation failed');
    if (input.expect?.stderr_contains !== undefined && !stderr.includes(input.expect.stderr_contains)) failures.push('stderr expectation failed');
    const hiddenNote = masks.hidden.length > 0
      ? `; ${masks.hidden.length} path${masks.hidden.length === 1 ? '' : 's'} hidden by the owner's read rules or reserved` : '';
    return { ...modeResult, cmd: command, cwd, exit_code: exitCode, stdout, stderr, ...(stdoutDropped ? { stdout_truncated: true } : {}), ...(stderrDropped ? { stderr_truncated: true } : {}), success: (input.until ? untilMatched : (modeResult?.success ?? exitCode === 0)) && failures.length === 0,
      duration_ms: Date.now() - start, sandboxed: true, sandbox_boundary: `captured view mounted ${mutable && !candidate ? 'read-write' : 'read-only'}${hiddenNote}; isolated PID/mounts; network ${network}`, sandbox_network: network,
      captured_exec_availability: availability, ...(failures.length ? { expectation_error: failures.join('; ') } : {}) };
  } catch (error) {
    stop();
    await childCompletion?.catch(() => {});
    const aborted = combined?.aborted === true;
    const reason = error instanceof Error ? error.message : String(error);
    if (!aborted) logger.warn('captured exec: held', {
      ...(error instanceof CapturedBoundaryRefusal ? { kind: error.kind, path: error.path } : {}), error: reason,
    });
    const refusal = !aborted && error instanceof CapturedBoundaryRefusal ? error : undefined;
    // A file-operation refusal (a link, a reserved path) keeps nothing to show;
    // an authority problem after the run withholds the output. Whether the
    // command already wrote decides whether a rerun is safe.
    const diagnosis = refusal ? capturedRefusalText(refusal, wrote, false)
      : wrote ? HELD_AFTER_RUN
        : aborted ? cancelledNote(false) : held(`the run could not be confirmed against the owner's current files (${reason})`);
    return { cmd: command, cwd, exit_code: null, stdout: '', stderr: diagnosis, success: false, denied: true,
      ...(refusal ? { captured_refusal: { kind: refusal.kind, path: refusal.path, reason: diagnosis } } : {}),
      ...(aborted ? { cancelled: true } : {}), ...(wrote ? { captured_changes_published: true } : {}), duration_ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
    if (placeholder) await rm(placeholder, { force: true }).catch((error: unknown) => {
      logger.warn('captured exec: could not remove the script mount point', { path: placeholder, error: error instanceof Error ? error.message : String(error) });
    });
    if (temporary) await discardCapturedTemporary(temporary);
  }
}
