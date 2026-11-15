/**
 * The claim a runner holds on each contract it runs, so a second runner on the
 * same project root (another process, or another runner in this one) does not
 * resume and run a contract that is already live: two runs of one contract
 * would write the same worktree and checkpoint and pay for the work twice.
 *
 * It is a kernel-released lock held for the life of the run: a second claimant
 * is refused while the holder runs, and the operating system frees it when the
 * holder exits, so a process that died does not strand its contract and no
 * stale-holder rule is needed. Cost: one open and two statements per run.
 */
import { holdProcessLock } from '../utils/process-lock.js';
import { contractLeasePath } from './store.js';

export { contractLeasePath } from './store.js';

/** Claims the contract for this runner; the returned function releases it. Null when another holder has it. */
export function claimContractLease(projectRoot: string, contractId: string): (() => void) | null {
  const held = holdProcessLock(contractLeasePath(projectRoot, contractId));
  return held === null ? null : () => held.release();
}
