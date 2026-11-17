import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/**
 * The project's installed dependencies (`node_modules`) as a read-only mount
 * for captured commands. Nothing is copied: the source tree is bound where the
 * member's view expects it, and the owner's read rules over it become mount
 * masks, computed once per admission (the first command that needs them).
 * Each command checks that the source root is still the admitted directory
 * (one `lstat` and one `realpath`). No prefix is a read grant.
 */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority,
  contractInputAuthoritySourceRoot,
  contractInputAuthorityRoot,
  registerContractInputReadAssertion,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import type { CapturedExecAuthority } from './captured-exec.js';
import { computeCapturedMasks, type CapturedMasks } from './captured-exec-masks.js';

export interface CapturedExecDependencyRoot {
  readonly sourceRoot: string;
  readonly targetRelativePath: string;
}
/** Serialization or model arguments cannot manufacture an admitted input. */
export interface CapturedExecDependencyInput { readonly kind: 'captured-exec-dependency-input' }
type Binding = Pick<CapturedExecAuthority, 'authority' | 'root' | 'readAccessFilter' | 'signal' | 'retainInputResource'>;
interface Admission {
  readonly binding: Binding;
  readonly sourceRoot: string;
  readonly target: string;
  /** The owner's rules over the tree, read once on first use. */
  masks: Promise<CapturedMasks> | undefined;
  readonly check: (signal?: AbortSignal) => Promise<void>;
}
const admissions = new WeakMap<CapturedExecDependencyInput, Admission>();
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function excluded(path: string): boolean {
  return path.split(sep).some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number]));
}

/** An empty directory left as a mount point by an earlier command is not dependency material. */
async function holdsCapturedBytes(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    return !stat.isDirectory() || (await readdir(target)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function admitCapturedExecDependency(
  binding: Binding,
  declaration: CapturedExecDependencyRoot,
): Promise<CapturedExecDependencyInput | undefined> {
  binding = Object.freeze({ ...binding });
  declaration = Object.freeze({ ...declaration });
  const filter = binding.readAccessFilter;
  if (!filter) throw new Error('dependency input requires original-owner read authorization');
  await assertContractInputAuthority(binding.authority, binding.root, binding.signal);
  const owner = contractInputAuthoritySourceRoot(binding.authority);
  const sourceRoot = resolve(declaration.sourceRoot);
  const rel = relative(owner, sourceRoot);
  const target = resolve(binding.root, declaration.targetRelativePath);
  if (!rel || !contained(owner, sourceRoot) || excluded(rel) || relative(binding.root, target) !== rel || !contained(binding.root, target))
    throw new Error('dependency declaration is outside admitted owner/view mapping');
  let rootStat;
  try { rootStat = await lstat(sourceRoot, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(sourceRoot) !== sourceRoot)
    throw new Error('dependency source root is redirected');
  // Dependencies the member's own view already holds always win over the project's.
  if (await holdsCapturedBytes(target)) return undefined;
  const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
  const check = async (signal: AbortSignal | undefined = binding.signal): Promise<void> => {
    signal = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
    signal?.throwIfAborted();
    if (contractInputAuthorityRoot(binding.authority) !== resolve(binding.root)) throw new Error('dependency authority root changed');
    const stat = await lstat(sourceRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(sourceRoot) !== sourceRoot || `${stat.dev}:${stat.ino}` !== rootIdentity)
      throw new Error('dependency source root changed');
    if (!await executePolicyCheck(() => filter(sourceRoot), signal) || !await executePolicyCheck(() => filter(target), signal))
      throw new Error('dependency input is access-restricted');
  };
  await check();
  const token = Object.freeze({ kind: 'captured-exec-dependency-input' as const });
  admissions.set(token, { binding, sourceRoot, target, masks: undefined, check });
  // Provider delivery of dependency-derived output rechecks the root too (O(1)).
  registerContractInputReadAssertion(binding.authority, check);
  return token;
}

/**
 * The read-only mounts and masks of a command's admitted dependencies. The
 * masks are computed on the first command and reused: they are the owner's
 * rules over a tree no captured command can write.
 */
export async function projectCapturedExecDependencies(
  binding: CapturedExecAuthority,
  signal: AbortSignal,
): Promise<{ readonly mounts: readonly { source: string; target: string }[]; readonly argv: readonly string[]; readonly check: () => Promise<void> }> {
  const combined = binding.signal ? AbortSignal.any([binding.signal, signal]) : signal;
  const states: Admission[] = [];
  for (const token of binding.dependencyInputs ?? []) {
    const state = admissions.get(token);
    if (!state || state.binding.authority !== binding.authority || state.binding.root !== binding.root || state.binding.readAccessFilter !== binding.readAccessFilter)
      throw new Error('dependency input has no matching construction-owned admission');
    if (states.some((other) => contained(other.target, state.target) || contained(state.target, other.target)))
      throw new Error('dependency inputs overlap');
    states.push(state);
  }
  const check = async (): Promise<void> => {
    combined.throwIfAborted();
    for (const state of states) await state.check(combined);
  };
  await check();
  const mounts: { source: string; target: string }[] = [];
  const argv: string[] = [];
  for (const state of states) {
    const filter = state.binding.readAccessFilter!;
    state.masks ??= computeCapturedMasks(state.sourceRoot, state.target, async (rel, current) =>
      await executePolicyCheck(() => filter(join(state.sourceRoot, rel)), current)
        && await executePolicyCheck(() => filter(join(state.target, rel)), current), binding.signal ?? new AbortController().signal);
    let masks: CapturedMasks;
    try { masks = await state.masks; }
    catch (error) { state.masks = undefined; throw error; }
    combined.throwIfAborted();
    mounts.push({ source: state.sourceRoot, target: state.target });
    argv.push('--ro-bind', state.sourceRoot, state.target, ...masks.argv);
  }
  return { mounts, argv, check };
}
