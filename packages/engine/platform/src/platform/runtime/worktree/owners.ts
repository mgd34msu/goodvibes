import { join, relative, sep } from 'node:path';
import { isContractId, isTerminalContractStatus, type Contract } from '../../contract/types.js';
import type { WorktreeOwnerInfo } from './retention.js';

/** The slice of the contract store the owner lookup needs; tests pass a plain object. */
export interface ContractLookup {
  load(contractId: string): Pick<Contract, 'status' | 'completedAt' | 'baseBranch'> | null;
}

/**
 * The contract a fix planner's view belongs to: the directory is
 * `<contract id>-<view id>`; an older view named by the contract id alone is
 * read as before.
 */
function plannerContractId(name: string): string {
  return /^(ctr-(?:[0-9a-f]{8}|[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}))-./.exec(name)?.[1] ?? name;
}

/**
 * Resolve the owner of a worktree under `.goodvibes/.worktrees` from the
 * contract that created it (`contract/<short>`, `contract-planner/<id>-<view>`).
 * Other shapes, and any contract that cannot be read, are `unknown`: the
 * retention sweep never treats unknown as ended.
 */
export function createContractOwnerResolver(workingDirectory: string, contracts: ContractLookup): (path: string) => WorktreeOwnerInfo {
  const base = join(workingDirectory, '.goodvibes', '.worktrees');
  return (path) => {
    const parts = relative(base, path).split(sep);
    const id = parts[0] === 'contract' && parts.length === 2 ? `ctr-${parts[1]}`
      : parts[0] === 'contract-planner' && parts.length === 2 ? plannerContractId(parts[1]!)
        : undefined;
    if (id === undefined || !isContractId(id)) return { state: 'unknown' };
    try {
      const contract = contracts.load(id);
      if (!contract) return { state: 'unknown' };
      const baseBranch = contract.baseBranch;
      if (!isTerminalContractStatus(contract.status)) return { state: 'running', baseBranch };
      return contract.completedAt === undefined ? { state: 'unknown', baseBranch } : { state: 'ended', endedAt: contract.completedAt, baseBranch };
    } catch {
      return { state: 'unknown' };
    }
  };
}
