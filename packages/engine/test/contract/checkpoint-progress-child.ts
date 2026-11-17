/**
 * A second process for the contract checkpoint proofs. Usage:
 *   bun checkpoint-progress-child.ts loop <projectRoot> <contractId>
 *     loads the contract and saves `progressStep(contract, n)` for n = 1, 2, ...,
 *     printing `saved n` after each save returns, until it is killed;
 *   bun checkpoint-progress-child.ts hold <projectRoot> <contractId>
 *     loads the contract, saves one step, prints `saved`, then keeps the
 *     contract's writer until its standard input closes.
 */
import { ContractStore } from '../../platform/src/platform/contract/store.js';
import { progressStep } from './checkpoint-progress-support.js';

const [mode, projectRoot, contractId] = process.argv.slice(2);
if (projectRoot === undefined || contractId === undefined) throw new Error('usage: loop|hold <projectRoot> <contractId>');
const store = new ContractStore({ projectRoot, sweepIntervalMs: 0 });
const contract = store.load(contractId);
if (contract === null) throw new Error('the contract is not saved');
store.hold(contract);

if (mode === 'loop') {
  for (let step = 1; ; step++) {
    progressStep(contract, step);
    if (!store.write(contractId)) throw new Error(`save ${step} failed: ${store.writeFailure(contractId)?.message}`);
    process.stdout.write(`saved ${step}\n`);
  }
} else if (mode === 'hold') {
  progressStep(contract, 1);
  if (!store.write(contractId)) throw new Error(`save failed: ${store.writeFailure(contractId)?.message}`);
  process.stdout.write('saved\n');
  for await (const _chunk of Bun.stdin.stream()) { /* wait for the parent to close standard input */ }
  store.dispose();
} else {
  throw new Error(`unknown mode ${mode}`);
}
