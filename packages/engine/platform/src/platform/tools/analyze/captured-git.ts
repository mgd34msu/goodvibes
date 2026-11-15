/** Historical comparison inputs are pinned objects, never a mount of the owner's Git directory. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertCapturedInputPathContext,
  assertContractInputGitAuthority,
  contractInputAuthoritySourceRoot,
  contractInputAuthorityRoot,
  isCapturedInputPath,
  registerContractInputReadAssertion,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { GitService } from '../../git/service.js';
import { assertCapturedToolAccessCurrent, assertCapturedToolReadAccess, hasCapturedToolInvocation } from '../shared/captured-input-tools.js';

interface CapturedAnalysis {
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly signal?: AbortSignal | undefined;
}
const active = new AsyncLocalStorage<CapturedAnalysis>();
const OID = /^[0-9a-f]{40,64}$/;

export function withCapturedAnalyzeInput<T>(
  authority: ContractInputAuthority,
  root: string,
  signal: AbortSignal | undefined,
  operation: () => T,
): T {
  return active.run({ authority, root, signal }, operation);
}

export function capturedAnalyzeSignal(): AbortSignal | undefined {
  return active.getStore()?.signal;
}

interface ComparisonInputs {
  readonly kind: 'captured-git-comparison';
  readonly captured_head: string;
  readonly before: { readonly ref: string; readonly commit: string };
  readonly after: { readonly ref: string; readonly commit: string };
}
export interface AnalyzeGitReader {
  readonly comparisonInputs?: ComparisonInputs;
  diffBetween(before: string, after: string, files?: string[]): Promise<string>;
  /** `files` narrows a captured reader's stat; the live reader reports the whole range and callers narrow it. */
  diffStat(before: string, after: string, files?: string[]): Promise<string>;
  /** The stat and the patch from one pass (one name listing, one authorization sweep), when the reader can. */
  diffWithStat?(before: string, after: string, files?: string[]): Promise<{ readonly stat: string; readonly patch: string }>;
}

/** Longest a fixed Git read may run, and the most output it may produce. */
const GIT_READ_TIMEOUT_MS = 60_000;
const GIT_READ_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Only fixed metadata/diff commands reach this helper. Never inherit Git routing or executable diff drivers.
 * Git runs asynchronously, so a slow or locked repository holds this call, never the process; it is killed at
 * GIT_READ_TIMEOUT_MS or as soon as its output passes GIT_READ_MAX_BYTES, and when `signal` aborts.
 */
function git(cwd: string, args: readonly string[], gitDir?: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', [
      '--no-replace-objects', '--no-optional-locks', '-C', cwd,
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false',
      '-c', 'diff.orderFile=/dev/null',
      ...(gitDir === undefined ? [] : [`--git-dir=${gitDir}`, '--bare']), ...args,
    ], {
      env: {
        ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error): void => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new Error('captured historical Git read timed out')), GIT_READ_TIMEOUT_MS);
    const abort = (): void => stop(signal?.reason instanceof Error ? signal.reason : new Error('captured historical Git read was cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_READ_MAX_BYTES) stop(new Error('captured historical Git output is too large'));
      else chunks.push(chunk);
    });
    const settle = (code: number | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Neither subprocess diagnostics nor partially read bytes are deliverable on failure.
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error('captured historical Git read failed')); return; }
      const bytes = Buffer.concat(chunks);
      const output = bytes.toString('utf8');
      if (!Buffer.from(output).equals(bytes)) { reject(new Error('captured historical Git output is not UTF-8')); return; }
      resolvePromise(output);
    };
    child.on('error', (error) => { failure ??= error; settle(null); });
    child.on('close', settle);
  });
}

const registeredGitAssertions = new WeakMap<ContractInputAuthority, Set<string>>();

function identity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('captured historical Git directory was redirected');
  return `${stat.dev}:${stat.ino}`;
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' &&
      !CONTRACT_INPUT_EXCLUSIONS.includes(part as (typeof CONTRACT_INPUT_EXCLUSIONS)[number]));
}

/** Preserve Git's metadata-only selectors while refusing predicates that consult live attributes. */
function capturedSelector(file: string, projectRoot: string, root: string): string {
  if (file.length > 4096 || file.includes('\0') || file.includes('\\'))
    throw new Error('unsupported captured comparison path');
  if (file === ':') return file; // Git's existing "no pathspec" form; Git rejects mixing it with other selectors.
  let pattern = file;
  let magic: string[] = [];
  if (file.startsWith(':(')) {
    const closing = file.indexOf(')');
    if (closing === -1) throw new Error('unsupported captured comparison selector');
    magic = file.slice(2, closing).split(',').filter(Boolean);
    pattern = file.slice(closing + 1);
  } else if (file.startsWith(':')) {
    let index = 1;
    while (index < file.length && '/!^'.includes(file[index]!)) {
      magic.push(file[index] === '/' ? 'top' : 'exclude');
      index++;
    }
    if (file[index] === ':') index++;
    pattern = file.slice(index);
  }
  if (magic.some((name) => !['top', 'literal', 'glob', 'icase', 'exclude'].includes(name)))
    throw new Error('unsupported captured comparison selector: live attribute predicates are unavailable');
  const path = relative(root, resolve(magic.includes('top') ? root : projectRoot, pattern)).split(sep).join('/');
  // Exclusions can remove runtime paths from a comparison; only the resulting changed names grant candidates.
  const permitted = path === '' || (magic.includes('exclude')
    ? path.length > 0 && !isAbsolute(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    : safeRelativePath(path));
  if (!permitted) throw new Error('unsupported captured comparison path');
  return `${magic.length > 0 ? `:(${magic.join(',')})` : ''}${path || '.'}`;
}

/** HEAD belongs to this authorized view; explicit refs become separately identified immutable inputs. */
export async function createAnalyzeGitReader(projectRoot: string, before: string, after: string): Promise<AnalyzeGitReader> {
  assertCapturedInputPathContext(projectRoot);
  const context = active.getStore();
  if (!context) {
    if (isCapturedInputPath(projectRoot)) throw new Error('captured Git analysis requires its owned invocation');
    return new GitService(projectRoot);
  }
  if (!hasCapturedToolInvocation() || contractInputAuthorityRoot(context.authority) !== resolve(context.root))
    throw new Error('captured Git analysis requires the matching owned tool invocation');
  await assertContractInputGitAuthority(context.authority, context.signal);
  const prefix = relative(context.root, resolve(projectRoot));
  if (isAbsolute(prefix) || prefix === '..' || prefix.startsWith(`..${sep}`))
    throw new Error('captured Git analysis belongs to another view');
  const source = contractInputAuthoritySourceRoot(context.authority);
  const signal = context.signal;
  const [sourceDir, viewDir, head] = await Promise.all([
    git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], undefined, signal),
    git(context.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], undefined, signal),
    git(context.root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], undefined, signal).then((text) => text.trim()),
  ]);
  const gitDir = realpathSync(sourceDir.trim());
  if (realpathSync(viewDir.trim()) !== gitDir)
    throw new Error('captured Git view belongs to another repository');
  const directoryIdentity = identity(gitDir);
  const pin = async (ref: string): Promise<string> => {
    if (ref.length > 512 || ref.startsWith('-')) throw new Error('invalid captured comparison ref');
    const anchored = ref.replace(/^(?:HEAD|@)(?=$|[~^])/, head);
    // Worktree-local explicit refs/reflogs retain their ordinary meaning, then become immutable OIDs.
    const oid = (await git(context.root, ['rev-parse', '--verify', '--end-of-options', `${anchored}^{commit}`], undefined, signal)).trim();
    if (!OID.test(oid)) throw new Error('captured comparison ref is not a commit');
    return oid;
  };
  // Pin both refs to commits before any path-permission callback runs, so none can move them.
  if (!OID.test(head)) throw new Error('captured view HEAD is not a commit');
  const [beforeCommit, afterCommit] = await Promise.all([pin(before), pin(after)]);
  const comparisonInputs: ComparisonInputs = Object.freeze({
    kind: 'captured-git-comparison', captured_head: head,
    before: Object.freeze({ ref: before, commit: beforeCommit }),
    after: Object.freeze({ ref: after, commit: afterCommit }),
  });
  const objectsCurrent = (signal: AbortSignal | undefined) => async (): Promise<void> => {
    await assertContractInputGitAuthority(context.authority, signal);
    if (identity(gitDir) !== directoryIdentity) throw new Error('captured Git directory changed');
    signal?.throwIfAborted();
  };
  // The authority's later read sweeps outlive this call: register one
  // assertion per Git directory, bound to the authority alone, so a cancelled
  // call cannot fail every later sweep and repeated calls add nothing.
  const assertionKey = `${gitDir}\0${directoryIdentity}`;
  let registeredKeys = registeredGitAssertions.get(context.authority);
  if (!registeredKeys) registeredGitAssertions.set(context.authority, registeredKeys = new Set());
  if (!registeredKeys.has(assertionKey)) {
    registerContractInputReadAssertion(context.authority, objectsCurrent(undefined));
    registeredKeys.add(assertionKey);
  }
  const assertObjectsCurrent = objectsCurrent(context.signal);
  const assertCurrent = async (): Promise<void> => {
    await assertObjectsCurrent();
    await assertCapturedToolAccessCurrent();
  };
  /** One name listing and one authorization sweep, then the requested output in one Git run. */
  const diff = async (output: '--stat' | '-p' | '--patch-with-stat', files?: string[]): Promise<string> => {
    await assertCurrent();
    const selection = files?.map((file) => capturedSelector(file, projectRoot, context.root));
    const base = ['diff-tree', '--no-commit-id', '-r', '--no-ext-diff', '--no-textconv', '--no-renames'];
    // --name-only does not open blobs. Authorize both sides of every selected change before diff/stat reads them.
    const names = (await git(source, [...base, '--name-only', '-z', beforeCommit, afterCommit,
      ...(selection?.length ? ['--', ...selection] : [])], gitDir, signal)).split('\0').filter(Boolean);
    for (const path of names) {
      if (!safeRelativePath(path)) throw new Error('captured comparison contains an excluded or ambiguous path');
      await assertCapturedToolReadAccess(join(context.root, path));
    }
    await assertCurrent();
    if (names.length === 0) return '';
    // Reuse the pinned comparison selectors after authorizing every selected
    // path. Expanding names into argv would hit the OS argument-size limit.
    const text = await git(source, [...base, '--submodule=short', output, beforeCommit, afterCommit,
      ...(selection?.length ? ['--', ...selection] : [])], gitDir, signal);
    await assertCurrent();
    return text;
  };
  return {
    comparisonInputs,
    diffBetween: async (_before: string, _after: string, files?: string[]) => diff('-p', files),
    diffStat: async (_before: string, _after: string, files?: string[]) => diff('--stat', files),
    diffWithStat: async (_before: string, _after: string, files?: string[]) => {
      const text = await diff('--patch-with-stat', files);
      const at = text.startsWith('diff --git') ? 0 : text.indexOf('\ndiff --git');
      return at < 0 ? { stat: text, patch: '' } : { stat: text.slice(0, at).replace(/\n---\n?$/, '\n'), patch: text.slice(at === 0 ? 0 : at + 1) };
    },
  };
}
