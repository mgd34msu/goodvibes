import type { Observed } from '@goodvibes/engine/errors';
import { readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { kindOfProductWorktree, productWorktreePath, productWorktreeRoot, productWorktreeSegments } from '../../git/product-worktree-marker.js';
import { isContractId, isTerminalContractStatus, type Contract } from '../../contract/types.js';
import type { WorktreeOwnerInfo } from './retention.js';

/** The slice of the contract store the owner lookup needs; tests pass a plain object. */
export interface ContractLookup {
  load(contractId: string): Observed<Pick<Contract, 'status' | 'completedAt' | 'baseBranch' | 'inputSnapshot' | 'branch'>>;
}

/**
 * The contract a fix planner's view belongs to: the directory is
 * `<contract id>-<view id>`; an older view named by the contract id alone is
 * read as before.
 */
function plannerContractId(name: string): string {
  return /^(ctr-(?:[0-9a-f]{8}|[0-9a-p]{8}(?:-[0-9a-p]{4}){3}-[0-9a-p]{12}))-./.exec(name)?.[1] ?? name;
}

const UNKNOWN: WorktreeOwnerInfo = { state: 'unknown' };

/** The path with symlinks followed when it exists, so two spellings of one directory compare equal. */
function comparable(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** A work item's state as its workstream last saved it, read without the engine (no quarantine, no lock). */
interface SavedItem {
  readonly state?: unknown;
  readonly mergeState?: unknown;
  readonly completedAt?: unknown;
  readonly worktreePath?: unknown;
  readonly worktreeBranch?: unknown;
}

/** Item states after which no agent runs in the item's worktree again. */
const TERMINAL_ITEM_STATES: ReadonlySet<string> = new Set(['passed', 'failed']);

/**
 * Who holds each item worktree of the workstreams saved under
 * `.goodvibes/orchestration` (and its per-contract namespaces): an item that is
 * not finished, or passed and still waiting to merge, holds its worktree; a
 * finished one released it when it completed. Read once per resolver.
 */
function readWorkstreamOwners(workingDirectory: string, worktreesRoot: string): Map<string, WorktreeOwnerInfo> {
  const owners = new Map<string, WorktreeOwnerInfo>();
  const root = join(workingDirectory, '.goodvibes', 'orchestration');
  const files: string[] = [];
  let entries: Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return owners; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(join(root, entry.name));
    else if (entry.isDirectory()) {
      try {
        for (const name of readdirSync(join(root, entry.name))) if (name.endsWith('.json')) files.push(join(root, entry.name, name));
      } catch { /* an unreadable namespace holds nothing this lookup can use */ }
    }
  }
  for (const file of files) {
    let items: unknown;
    try { items = (JSON.parse(readFileSync(file, 'utf8')) as { workstream?: { items?: unknown } }).workstream?.items; } catch { continue; }
    if (!Array.isArray(items)) continue;
    for (const raw of items as SavedItem[]) {
      if (raw === null || typeof raw !== 'object') continue;
      const path = typeof raw.worktreePath === 'string' ? raw.worktreePath
        : typeof raw.worktreeBranch === 'string' ? join(worktreesRoot, ...raw.worktreeBranch.split('/'))
          : undefined;
      if (path === undefined) continue;
      const finished = typeof raw.state === 'string' && TERMINAL_ITEM_STATES.has(raw.state) && raw.mergeState !== 'pending';
      const owner: WorktreeOwnerInfo = !finished ? { state: 'running' }
        : typeof raw.completedAt === 'number' ? { state: 'ended', endedAt: raw.completedAt } : UNKNOWN;
      const key = comparable(path);
      // Two records naming one tree: a running one wins, so the tree is never taken from work still using it.
      if (owners.get(key)?.state !== 'running') owners.set(key, owner);
    }
  }
  return owners;
}

/**
 * Resolve the owner of a worktree under `.goodvibes/.worktrees`, for every
 * shape the product makes:
 * - `contract/<short>` (and anything nested under it, such as the contract's
 *   own work-item worktrees) and `contract-planner/<id>-<view>`: the contract.
 * - `contract-input/<snapshot id>`: the contract that captured that input,
 *   found through the contracts whose worktrees are on disk.
 * - `ws/...`, `ws-ns/...`, `ws-owned/...`: the work item of a saved workstream
 *   that records the worktree.
 * - `agent-*`: made only by versions before 3.3.0, whose agents lived inside
 *   their own process; no program of this version runs work in one, so its
 *   owner is `unknown` and the sweep's own in-use checks (git lock, recent
 *   activity, a session or task attached in the register) decide.
 * Anything that cannot be read is `unknown`: the retention sweep never treats
 * unknown as ended.
 */
export function createContractOwnerResolver(workingDirectory: string, contracts: ContractLookup): (path: string) => WorktreeOwnerInfo {
  const base = productWorktreeRoot(workingDirectory);
  type ContractOwner = WorktreeOwnerInfo & { readonly inputId?: string | undefined; readonly branch?: string | undefined };
  const loaded = new Map<string, ContractOwner>();
  const contractOwner = (id: string): ContractOwner => {
    const known = loaded.get(id);
    if (known) return known;
    let owner: ContractOwner = UNKNOWN;
    if (isContractId(id)) {
      try {
        const read = contracts.load(id);
        const contract = read.kind === 'present' ? read.value : null;
        if (contract) {
          // The captured input is the person's own checkout as it was: a commit made only to capture it is not work.
          const inputCommit = contract.inputSnapshot?.inputCommit;
          const shared = {
            baseBranch: contract.baseBranch, inputId: contract.inputSnapshot?.id, branch: contract.branch,
            ...(inputCommit ? { baseCommits: [inputCommit] } : {}),
          };
          owner = !isTerminalContractStatus(contract.status) ? { state: 'running', ...shared }
            : contract.completedAt === undefined ? { state: 'unknown', ...shared }
              : { state: 'ended', endedAt: contract.completedAt, ...shared };
        }
      } catch { /* unreadable: unknown */ }
    }
    loaded.set(id, owner);
    return owner;
  };
  let inputOwners: Map<string, WorktreeOwnerInfo> | undefined;
  const inputOwner = (snapshotId: string): WorktreeOwnerInfo => {
    if (!inputOwners) {
      inputOwners = new Map();
      let shorts: string[] = [];
      try { shorts = readdirSync(productWorktreePath(workingDirectory, 'contract')); } catch { /* no contract worktrees */ }
      for (const short of shorts) {
        const owner = contractOwner(`ctr-${short}`);
        if (owner.inputId !== undefined) inputOwners.set(owner.inputId, owner);
      }
    }
    return inputOwners.get(snapshotId) ?? UNKNOWN;
  };
  let workstreamOwners: Map<string, WorktreeOwnerInfo> | undefined;
  // A work item's tree nested in the contract's tree: work integrated into the contract's branch is kept there.
  const strip = (owner: ContractOwner, nested = false): WorktreeOwnerInfo => {
    const baseCommits = [...(owner.baseCommits ?? []), ...(nested && owner.branch ? [`refs/heads/${owner.branch}`] : [])];
    const bases = baseCommits.length > 0 ? { baseCommits } : {};
    return owner.state === 'ended' ? { state: 'ended', endedAt: owner.endedAt, baseBranch: owner.baseBranch, ...bases } : { state: owner.state, baseBranch: owner.baseBranch, ...bases };
  };
  return (path) => {
    const parts = productWorktreeSegments(workingDirectory, path);
    const kind = kindOfProductWorktree(workingDirectory, path);
    if (parts === null || kind === null) return UNKNOWN;
    try {
      switch (kind) {
        case 'contract': return parts.length >= 2 ? strip(contractOwner(`ctr-${parts[1]}`), parts.length > 2) : UNKNOWN;
        case 'contract-planner': return parts.length === 2 ? strip(contractOwner(plannerContractId(parts[1]!))) : UNKNOWN;
        case 'contract-input': return parts.length === 2 ? inputOwner(parts[1]!) : UNKNOWN;
        case 'ws':
        case 'ws-ns':
        case 'ws-owned':
          workstreamOwners ??= readWorkstreamOwners(workingDirectory, base);
          return workstreamOwners.get(comparable(path)) ?? UNKNOWN;
        case 'agent': return UNKNOWN;
        default: {
          // A kind added to the layout without an owner rule here does not compile.
          const unhandled: never = kind;
          return unhandled;
        }
      }
    } catch { /* unreadable: unknown */ }
    return UNKNOWN;
  };
}
