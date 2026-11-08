import { AsyncLocalStorage } from 'node:async_hooks';
/** Construction-owned provenance. A captured path never grants permission by itself. */
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Contract } from './types.js';
import {
  assertContractExecutionView,
  assertContractInputObjects,
  assertContractInputGitIdentity,
  createContractInputViewAssertion,
  CONTRACT_INPUT_EXCLUSIONS,
  type ContractInputSnapshot,
} from './input-snapshot.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { checkCapturedInputsInBatches } from '../tools/exec/captured-exec-validation.js';
import { logger } from '../utils/logger.js';

/** Only tokens minted in this module are accepted; serialization cannot create one. */
export interface ContractInputAuthority {
  readonly kind: 'contract-input-authority';
}
/** A current read policy denied access, distinct from a changed or forged input. */
export class ContractInputReadDeniedError extends Error {
  constructor() { super('captured input path is access-restricted'); this.name = 'ContractInputReadDeniedError'; }
}
interface Admission {
  readonly receipt: ContractInputSnapshot;
  readonly serialized: string;
  readonly original: ContractInputSnapshot;
  readonly contract: Contract;
  readonly signal?: AbortSignal | undefined;
}
interface Authority {
  readonly admission: Admission;
  readonly root: string;
  readonly identity: string;
  readonly mutable: boolean;
  /** Exact construction-selected generation membership; never a read grant. */
  readonly inputFiles: readonly string[];
  readonly signal?: AbortSignal | undefined;
  readonly assertView: () => Promise<void>;
  readonly assertInputPath: ((path: string, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly batchable: boolean;
  revoked: boolean;
  readonly reads: Set<string>;
  readonly readAssertions: Set<() => Promise<void>>;
  readonly cleanups: Set<() => void>;
  removeAbortListeners: () => void;
}
const readBatches = new AsyncLocalStorage<ReadonlyMap<ContractInputAuthority, { active: boolean }>>();
const inReadBatch = (token: ContractInputAuthority): boolean => readBatches.getStore()?.get(token)?.active === true;
const admissions = new WeakMap<Contract, Admission>();
const authorities = new WeakMap<ContractInputAuthority, Authority>();
const bindings = new WeakMap<object, ContractInputAuthority>();
const activeInputAuthority = new AsyncLocalStorage<ContractInputAuthority>();
// Revocation never makes a previously captured root an ordinary live workspace.
const capturedRoots = new Set<string>();
const identity = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;

function assertAdmission(admission: Admission, compareContents = true): void {
  admission.signal?.throwIfAborted();
  if (
    admission.contract.inputSnapshot !== admission.original ||
    (compareContents && JSON.stringify(admission.contract.inputSnapshot) !== admission.serialized)
  )
    throw new Error('contract input receipt changed after admission');
}

/** Pin once, immediately after capture or validated restore, before external awaits. */
export function pinContractInputAdmission(contract: Contract, signal?: AbortSignal): void {
  const previous = admissions.get(contract);
  if (previous) {
    assertAdmission(previous);
    return;
  }
  const original = contract.inputSnapshot;
  if (!original) throw new Error('contract input authority requires a recorded receipt');
  const admission: Admission = {
    original,
    receipt: structuredClone(original),
    serialized: JSON.stringify(original),
    contract,
    signal,
  };
  assertAdmission(admission);
  admissions.set(contract, admission);
}

export function assertContractInputAdmission(contract: Contract): void {
  const admission = admissions.get(contract);
  if (!admission) throw new Error('contract input has no construction-owned admission');
  assertAdmission(admission);
}

export async function createContractInputAuthority(
  contract: Contract,
  root: string,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly mutable?: boolean | undefined;
    readonly branch?: string | undefined;
    readonly snapshot?: ContractInputSnapshot | undefined;
    readonly assertView?: (() => Promise<void>) | undefined;
  } = {},
): Promise<ContractInputAuthority> {
  pinContractInputAdmission(contract, options.signal);
  const admission = admissions.get(contract)!;
  const view = resolve(root);
  const snapshot = options.snapshot === undefined ? admission.receipt : structuredClone(options.snapshot);
  const immutableView = options.assertView === undefined && !options.mutable
    ? createContractInputViewAssertion(snapshot, options.signal, view) : undefined;
  const assertView =
    options.assertView ??
    immutableView ??
      (async () => {
        if (!options.mutable || !options.branch) throw new Error('member authority requires its recorded branch');
        assertContractExecutionView(admission.receipt, view, options.branch);
      });
  assertAdmission(admission);
  assertContractInputObjects(admission.receipt, admission.receipt.sourceRoot);
  if ((await realpath(view)) !== view) throw new Error('captured input root is redirected');
  const stat = await lstat(view, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('captured input root is not a directory');
  await assertView();
  assertAdmission(admission);
  const token = Object.freeze({ kind: 'contract-input-authority' as const });
  const state: Authority = {
    admission,
    root: view,
    identity: identity(stat),
    mutable: options.mutable === true,
    inputFiles: Object.freeze(snapshot.files.filter(file => file.kind === 'file').map(file => file.path)),
    assertView,
    assertInputPath: immutableView?.assertPath,
    batchable: options.assertView === undefined,
    signal: options.signal,
    revoked: false,
    reads: new Set(),
    readAssertions: new Set(),
    cleanups: new Set(),
    removeAbortListeners: () => {},
  };
  authorities.set(token, state);
  const signals = [...new Set([options.signal, admission.signal].filter((value): value is AbortSignal => value !== undefined))];
  const retired = () => {
    try { revokeContractInputAuthority(token); }
    catch { logger.warn('Captured input cleanup failed after cancellation'); }
  };
  state.removeAbortListeners = () => { for (const signal of signals) signal.removeEventListener('abort', retired); };
  for (const signal of signals) signal.addEventListener('abort', retired, { once: true });
  if (signals.some(signal => signal.aborted)) {
    revokeContractInputAuthority(token);
    for (const signal of signals) signal.throwIfAborted();
  }
  capturedRoots.add(view);
  return token;
}

export function getContractInputAuthority(target: object): ContractInputAuthority | undefined {
  return bindings.get(target);
}
export function bindContractInputAuthority<T extends object>(target: T, token: ContractInputAuthority | undefined): T {
  if (token !== undefined) {
    if (!authorities.has(token)) throw new Error('unrecognized contract input authority');
    bindings.set(target, token);
  }
  return target;
}
export function revokeContractInputAuthority(token: ContractInputAuthority): void {
  const state = authorities.get(token);
  if (!state || state.revoked) return;
  state.revoked = true;
  state.removeAbortListeners();
  state.readAssertions.clear(); state.reads.clear();
  const errors: unknown[] = [];
  for (const cleanup of state.cleanups) {
    try { cleanup(); } catch (error) { errors.push(error); }
  }
  state.cleanups.clear();
  if (errors.length) throw new AggregateError(errors, 'Captured input resource cleanup failed');
}

/** Transfer a construction-owned resource only while this input owner is live.
 * The caller still owns disposal if registration throws. Revoke/cancellation
 * disposes every registered resource, including when another disposer fails.
 */
export function registerContractInputCleanup(token: ContractInputAuthority, cleanup: () => void): () => void {
  if (typeof cleanup !== 'function') throw new Error('Captured input cleanup must be construction-owned code');
  const state = stateOf(token);
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    state.cleanups.delete(dispose);
    cleanup();
  };
  state.cleanups.add(dispose);
  return dispose;
}

export function markCapturedInputPath(path: string): void {
  capturedRoots.add(resolve(path));
}

export function isCapturedInputPath(path: string): boolean {
  let absolute = resolve(path);
  try {
    absolute = realpathSync(absolute);
  } catch {
    /* A missing reserved view still fails closed below. */
  }
  if ([...capturedRoots].some((root) => absolute === root || absolute.startsWith(`${root}${sep}`))) return true;
  // Reserved runtime views also fail closed before a restored lease is rebound.
  // This is only a denial check; prefixes never confer original-owner authority.
  return /[/\\]\.goodvibes[/\\]\.worktrees[/\\](?:contract-input|contract-planner|contract)(?:[/\\]|$)/.test(absolute);
}

function stateOf(token: ContractInputAuthority): Authority {
  const state = authorities.get(token);
  if (!state || state.revoked) throw new Error('captured input authority is missing or revoked');
  state.signal?.throwIfAborted();
  assertAdmission(state.admission, !inReadBatch(token));
  return state;
}
export async function assertContractInputAuthority(
  token: ContractInputAuthority,
  root?: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const state = stateOf(token);
  if (root !== undefined && resolve(root) !== state.root)
    throw new Error('captured input authority belongs to another view');
  const source = await lstat(state.admission.receipt.sourceRoot, {
    bigint: true,
  });
  if (
    !source.isDirectory() ||
    source.isSymbolicLink() ||
    identity(source) !== state.admission.receipt.sourceIdentity ||
    (await realpath(state.admission.receipt.sourceRoot)) !== state.admission.receipt.sourceRoot
  )
    throw new Error('original input root identity changed');
  const stat = await lstat(state.root, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    identity(stat) !== state.identity ||
    (await realpath(state.root)) !== state.root
  )
    throw new Error('captured input root identity changed');
  if (!inReadBatch(token)) await state.assertView();
  signal?.throwIfAborted();
  stateOf(token);
}
/** Whole-view validation surrounds a batch; every path still checks owner policy,
 * root identity, aliases and immutable content before and after callbacks.
 * Avoid recursively rescanning the entire repository for each directory entry.
 */
export async function withContractInputReadBatch<T>(token: ContractInputAuthority, operation: () => Promise<T>): Promise<T> {
  if (!stateOf(token).batchable) return operation();
  const active = readBatches.getStore();
  if (inReadBatch(token)) return operation();
  await assertContractInputAuthority(token);
  const lease = { active: true };
  const scope = new Map(active); scope.set(token, lease);
  let result: T;
  try { result = await readBatches.run(scope, operation); }
  finally { lease.active = false; }
  await assertContractInputAuthority(token);
  return result;
}

async function assertBatchedInputPath(token: ContractInputAuthority, rel: string, signal?: AbortSignal): Promise<void> {
  if (!inReadBatch(token)) return;
  const state = stateOf(token);
  if (state.mutable) return;
  if (!state.assertInputPath) throw new Error('captured input has no verified path owner');
  await state.assertInputPath(rel.split(sep).join('/'), signal);
}

/** Repository provenance for bounded historical-object readers; never a path/read grant. */
export async function assertContractInputGitAuthority(token: ContractInputAuthority, signal?: AbortSignal): Promise<void> {
  await assertContractInputAuthority(token, undefined, signal);
  await assertContractInputGitIdentity(stateOf(token).admission.receipt);
  signal?.throwIfAborted();
  stateOf(token);
}

export function contractInputAuthorityRoot(token: ContractInputAuthority): string {
  return stateOf(token).root;
}
/** Original construction-owned provenance; this accessor grants no read permission. */
export function contractInputAuthoritySourceRoot(token: ContractInputAuthority): string {
  return stateOf(token).admission.receipt.sourceRoot;
}
export function contractInputAuthorityMutable(token: ContractInputAuthority): boolean {
  return stateOf(token).mutable;
}

/** Immutable consumers may discover only the selected receipt's files. Mutable members enumerate their own authorized current files. */
export function contractInputAuthorityFiles(token: ContractInputAuthority): readonly string[] | undefined {
  const state = stateOf(token);
  return state.mutable ? undefined : state.inputFiles;
}

/** Reject aliases and excluded runtime paths before any backend opens bytes. */
async function checkedPath(root: string, relativePath: string): Promise<string> {
  const pieces = relativePath.split(sep);
  let current = root;
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('captured input symlink access needs an authorized alias backend');
      if (i < pieces.length - 1 && !stat.isDirectory()) throw new Error('captured input parent is not a directory');
      if (i === pieces.length - 1 && !stat.isFile() && !stat.isDirectory())
        throw new Error('captured input special-file access is unsupported');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return join(root, relativePath);
}

export async function authorizeContractInputPath(
  token: ContractInputAuthority,
  rawPath: string,
  filter: ReadAccessFilter | undefined,
  signal?: AbortSignal,
): Promise<string> {
  await assertContractInputAuthority(token, undefined, signal);
  const state = stateOf(token);
  if (!filter) throw new Error('captured input requires original-owner read authorization');
  const path = resolve(state.root, rawPath);
  const rel = relative(state.root, path);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel
      .split(sep)
      .some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as (typeof CONTRACT_INPUT_EXCLUSIONS)[number]))
  )
    throw new Error('path is outside authorized captured input');
  const original = await checkedPath(state.admission.receipt.sourceRoot, rel);
  await checkedPath(state.root, rel);
  await assertBatchedInputPath(token, rel, signal);
  if (!(await executePolicyCheck(() => filter(original), signal)) ||
      !(await executePolicyCheck(() => filter(path), signal))) throw new ContractInputReadDeniedError();
  // Recheck both roots and paths after permission callbacks can yield/revoke.
  await assertContractInputAuthority(token, undefined, signal);
  await checkedPath(state.admission.receipt.sourceRoot, rel);
  await checkedPath(state.root, rel);
  await assertBatchedInputPath(token, rel, signal);
  signal?.throwIfAborted();
  stateOf(token);
  state.reads.add(path);
  return path;
}

/** Includes initial map provenance before the Agent's own tool readset exists. */
export function registerContractInputReadAssertion(token: ContractInputAuthority, assertion: () => Promise<void>): void {
  if (typeof assertion !== 'function') throw new Error('captured read assertion must be construction-owned code');
  stateOf(token).readAssertions.add(assertion);
}

/** Recheck every recorded path, including paths added by a callback during
 * this sweep. Bounded parallelism changes no permission or identity checks. */
export async function assertContractInputReadSet(
  token: ContractInputAuthority,
  paths: ReadonlySet<string>,
  filter: ReadAccessFilter | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!filter) throw new Error('captured input requires original-owner read authorization');
  await withContractInputReadBatch(token, async () => {
    let checked = 0;
    while (checked < paths.size) {
      const pending = [...paths].slice(checked);
      await checkCapturedInputsInBatches(pending, async (path, current) => {
        await authorizeContractInputPath(token, path, filter, current);
      }, signal);
      checked += pending.length;
    }
  });
}

export async function assertContractInputReadAccess(
  token: ContractInputAuthority,
  filter: ReadAccessFilter | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!filter) throw new Error('captured input requires original-owner read authorization');
  // Runtime/dependency assertions belong to this same bracketed sweep. Leaving
  // them outside it serializes the complete receipt again for every entry.
  await withContractInputReadBatch(token, async () => {
    await assertContractInputReadSet(token, stateOf(token).reads, filter, signal);
    for (const assertion of [...stateOf(token).readAssertions]) {
      signal?.throwIfAborted();
      await executePolicyCheck(assertion, signal);
      stateOf(token);
    }
  });
  signal?.throwIfAborted();
}

/** Denial-only boundary for ordinary tools encountering retained captured paths. */
export function assertCapturedInputPathContext(path: string): void {
  if (!isCapturedInputPath(path)) return;
  const token = activeInputAuthority.getStore();
  if (!token) throw new Error('captured input path requires a construction-owned authority');
  const state = stateOf(token);
  let actual = resolve(path);
  try {
    actual = realpathSync(actual);
  } catch {
    /* New member files are checked by the guarded write path. */
  }
  const rel = relative(state.root, actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('captured input path belongs to another authority');
}

export function withContractInputAuthority<T>(token: ContractInputAuthority, operation: () => T): T {
  stateOf(token);
  return activeInputAuthority.run(token, operation);
}
