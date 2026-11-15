import { join, relative, sep } from 'node:path';
import { isContractId, isTerminalContractStatus, type Contract } from '../../contract/types.js';
import type { WorktreeOwnerInfo } from './retention.js';

/** The slice of the contract store the owner lookup needs; tests pass a plain object. */
export interface ContractLookup {
  load(contractId: string): Pick<Contract, 'status' | 'completedAt' | 'baseBranch'> | null;
}

/**
 * Resolve the owner of a worktree under `.goodvibes/.worktrees` from the
 * contract that created it (`contract/<short>`, `contract-planner/<id>`).
 * Other shapes, and any contract that cannot be read, are `unknown`: the
 * retention sweep never treats unknown as ended.
 */
export function createContractOwnerResolver(workingDirectory: string, contracts: ContractLookup): (path: string) => WorktreeOwnerInfo {
  const base = join(workingDirectory, '.goodvibes', '.worktrees');
  return (path) => {
    const parts = relative(base, path).split(sep);
    const id = parts[0] === 'contract' && parts.length === 2 ? `ctr-${parts[1]}`
      : parts[0] === 'contract-planner' && parts.length === 2 ? parts[1]
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
