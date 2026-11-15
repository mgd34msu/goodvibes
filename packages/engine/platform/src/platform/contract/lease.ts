/**
 * The claim a process holds on each contract it runs, so a second process on the
 * same project root does not resume (and run) a contract that is already live.
 *
 * It is a cross-process lock held for the life of the run: a second claimant is
 * refused while the holder is alive, and a lock whose holder is proven dead is
 * taken over, so a process that died does not strand its contract.
 */
import { join } from 'node:path';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { contractsDir } from './store.js';

/** Where the claim for one contract lives. Outside the checkpoint files, so no contract listing sees it. */
export function contractLeasePath(projectRoot: string, contractId: string): string {
  return join(contractsDir(projectRoot), '.leases', `${contractId}.lock`);
}

/** Claims the contract for this process; the returned function releases it. Null when another live holder has it. */
export function claimContractLease(projectRoot: string, contractId: string): (() => void) | null {
  return tryAcquireCrossProcessLock(contractLeasePath(projectRoot, contractId));
}
