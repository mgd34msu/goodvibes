import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '@goodvibes/judgment';
import type { Contract } from './types.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import { assertContractInputAdmission, authorizeContractInputPath, createContractInputAuthority, revokeContractInputAuthority } from './input-authority.js';
import { assertContractInputOwner, captureContractInput, ContractInputBranchSwitchedError, type ContractInputSnapshot } from './input-snapshot.js';
import { goalObligationSource } from './goal-obligation-proof.js';
import { renderContractAnswer } from './answer.js';
import { mergePublicationTree } from './publication-merge.js';

export interface PublicationInputAdmission { readonly kind: 'publication-input-admission'; readonly publicationTree: string }
interface Admission {
  readonly contract: Contract;
  readonly original: ContractInputSnapshot;
  readonly owner: ContractInputSnapshot;
  readonly ownerSnapshot: ContractInputSnapshot;
  readonly resultHead: string;
  readonly publicationTree: string;
  readonly originalScope: JsonValue & object;
  readonly acceptedEvidence: ReturnType<typeof acceptedPublicationEvidence>;
  readonly assertCurrent: () => void;
  used: boolean;
}
const admissions = new WeakMap<PublicationInputAdmission, Admission>();
const getAdmission = WeakMap.prototype.get, setAdmission = WeakMap.prototype.set, applyAdmission = Reflect.apply, freezeAdmission = Object.freeze;
const readAdmission = (token: PublicationInputAdmission): Admission | undefined => applyAdmission(getAdmission, admissions, [token]) as Admission | undefined;
const acceptedPublicationEvidence = (contract: Contract) => [contract.answer ?? renderContractAnswer(contract), contract.checks.at(-1) ?? null] as const;

function gitBytes(root: string, args: readonly string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['--literal-pathspecs', '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('publication input Git metadata could not be established');
  return result.stdout;
}
const git = (root: string, args: readonly string[]) => gitBytes(root, args).toString('utf8');

/** Longest diff of one path sent for a compatibility reading; a longer one is cut and says so. */
const MAX_PATH_DIFF_CHARS = 32_000;

/** One path's change between two trees, as a unified diff without external drivers. */
function pathDiff(root: string, from: string, to: string, path: string): JsonValue {
  const text = git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to, '--', path]);
  return text.length <= MAX_PATH_DIFF_CHARS ? { success: true, diff: text }
    : { success: true, partial: true, diff: `${text.slice(0, MAX_PATH_DIFF_CHARS)}\n[... ${text.length - MAX_PATH_DIFF_CHARS} characters of this diff omitted ...]` };
}

function changedPaths(root: string, from: string, to: string): string[] {
  return git(root, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames', '-z', from, to, '--']).split('\0').filter(Boolean);
}

/**
 * The owner kept working while the contract ran. Git answers the structural
 * question: a three-way merge of the captured input, the owner's tree now and
 * the accepted result. When the owner's changes and the result touch different
 * paths and the merge is clean, the result is admitted with no model request.
 * Only paths both sides changed are read for compatibility, as three diffs
 * (owner's change, result's change, what publication would do to the owner's
 * file), never as whole files. A merge conflict throws
 * ContractPublicationConflictError naming the paths. The original task,
 * captured source, accepted units and result branch are never recaptured.
 */
export async function admitPublicationInput(contract: Contract, filter: ReadAccessFilter | undefined, signal: AbortSignal,
  judge: (evidence: JsonValue & object) => Promise<(() => void) | null>): Promise<PublicationInputAdmission | null> {
  assertContractInputAdmission(contract);
  const scope = goalObligationSource(contract), originalScope = structuredClone(scope), acceptedEvidence = structuredClone(acceptedPublicationEvidence(contract));
  const assertScope = () => {
    if (!isDeepStrictEqual(goalObligationSource(contract), originalScope)) throw new Error('original publication scope changed during assessment');
    if (!isDeepStrictEqual(acceptedPublicationEvidence(contract), acceptedEvidence)) throw new Error('accepted publication answer or check changed during assessment');
  };
  const original = contract.inputSnapshot, view = contract.worktreePath, branch = contract.branch;
  if (!original || !view || !branch || !filter) throw new Error('publication recovery requires its captured result and original-owner authority');
  const owner = await captureContractInput(original.sourceRoot, { signal });
  assertScope();
  if (owner.sourceIdentity !== original.sourceIdentity || owner.gitIdentity !== original.gitIdentity)
    throw new Error('publication recovery cannot replace the original owner repository');
  if (owner.ownerRef !== original.ownerRef) throw new ContractInputBranchSwitchedError(original.ownerRef, owner.ownerRef);
  const root = original.sourceRoot;
  const resultHead = git(view, ['rev-parse', 'HEAD']).trim();
  const ownerChanged = owner.inputTree === original.inputTree ? [] : changedPaths(root, original.inputTree, owner.inputTree);
  const targets = changedPaths(root, original.inputCommit, resultHead);
  const targetSet = new Set(targets);
  const overlap = ownerChanged.filter(path => targetSet.has(path));
  const publicationTree = owner.inputTree === original.inputTree ? git(view, ['rev-parse', `${resultHead}^{tree}`]).trim()
    : await mergePublicationTree(root, original.inputCommit, owner.inputCommit, resultHead, overlap.length > 0 ? overlap : targets, signal);
  const proposedPaths = changedPaths(root, owner.inputCommit, publicationTree);
  if (proposedPaths.some(path => !targetSet.has(path))) throw new Error('Publication merge changes a path outside the accepted result.');
  let assertCurrent: () => void = () => signal.throwIfAborted();
  if (overlap.length > 0) {
    // Only the overlapping paths' text leaves the host, after the owner's read policy allows each.
    const authority = await createContractInputAuthority(contract, view, { signal, mutable: true, branch });
    try {
      for (const path of overlap) await authorizeContractInputPath(authority, path, filter, signal);
      const observations: JsonValue[] = overlap.map(path => ({ path,
        currentOwner: [pathDiff(root, original.inputTree, owner.inputTree, path)],
        acceptedResult: [pathDiff(root, original.inputCommit, resultHead, path)],
        proposedPublication: [pathDiff(root, owner.inputTree, publicationTree, path)] }));
      if (git(view, ['rev-parse', 'HEAD']).trim() !== resultHead) throw new Error('accepted result changed during publication recovery');
      assertScope();
      const qualified = await judge({ originalScope: scope,
        acceptedResult: { answer: contract.answer ?? renderContractAnswer(contract), check: contract.checks.at(-1) as unknown as JsonValue ?? null,
          resultHead, resultPaths: targets },
        ownerChange: { originalInputTree: original.inputTree, currentOwnerTree: owner.inputTree, proposedPublicationTree: publicationTree, paths: overlap,
          observations, ownerHeadAdvanced: owner.ownerHead !== original.ownerHead,
          otherOwnerPaths: ownerChanged.length - overlap.length },
        meaning: 'Only the paths both the owner and the accepted result changed are shown; every other owner change touches files the result does not, and Git merged them cleanly. For each path: currentOwner.diff is the owner\'s change from the original captured input, acceptedResult.diff is the accepted result\'s change from that same input, and proposedPublication.diff is what publication would do to the owner\'s current file (the native three-way merge). A diff marked partial was cut for length. A clean merge is not semantic approval. Publication applies only that delta on accepted result paths after Git verifies it fits; other owner files, index and history remain untouched. This check must hold an invalidated behavior, stale answer claim or missing compatibility evidence; it does not execute publication.' });
      if (!qualified) return null;
      assertCurrent = qualified;
    } finally { revokeContractInputAuthority(authority); }
  }
  assertCurrent();
  assertScope();
  await assertContractInputOwner(owner, signal);
  assertContractInputAdmission(contract);
  if (git(view, ['rev-parse', 'HEAD']).trim() !== resultHead) throw new Error('accepted result changed after publication assessment');
  const token = freezeAdmission({ kind: 'publication-input-admission' as const, publicationTree });
  applyAdmission(setAdmission, admissions, [token, { contract, original, owner, ownerSnapshot: structuredClone(owner), resultHead,
    publicationTree, originalScope, acceptedEvidence, assertCurrent, used: false }]);
  return token;
}

export function publicationInputOwner(token: PublicationInputAdmission, contract: Contract): ContractInputSnapshot {
  const admission = readAdmission(token);
  if (!admission || admission.used || admission.contract !== contract || admission.original !== contract.inputSnapshot
    || admission.publicationTree !== token.publicationTree || !isDeepStrictEqual(admission.originalScope, goalObligationSource(contract))
    || !isDeepStrictEqual(admission.acceptedEvidence, acceptedPublicationEvidence(contract)) || !isDeepStrictEqual(admission.owner, admission.ownerSnapshot))
    throw new Error('publication input admission is stale or belongs to another result');
  assertContractInputAdmission(contract); admission.assertCurrent();
  if (!contract.worktreePath || git(contract.worktreePath, ['rev-parse', 'HEAD']).trim() !== admission.resultHead)
    throw new Error('publication result changed after its owner assessment');
  return admission.owner;
}

export function consumePublicationInput(token: PublicationInputAdmission, contract: Contract): void {
  publicationInputOwner(token, contract);
  readAdmission(token)!.used = true;
}
