/**
 * A second process for contract-progress-restart.test.ts. Usage:
 *   bun contract-progress-child.ts hold <projectRoot> <contractId>
 *     loads the contract, saves one step, prints `saved`, then keeps the
 *     contract's writer until its standard input closes.
 */
import { ContractStore } from '../platform/src/platform/contract/store.js';
import { loaded, progressStep } from './contract-progress-support.js';

const [mode, projectRoot, contractId] = process.argv.slice(2);
if (projectRoot === undefined || contractId === undefined) throw new Error('usage: hold <projectRoot> <contractId>');
const store = new ContractStore({ projectRoot, sweepIntervalMs: 0 });
const contract = loaded(store, contractId);
store.hold(contract);

if (mode === 'hold') {
  progressStep(contract, 1);
  if (!store.write(contractId)) throw new Error(`save failed: ${store.writeFailure(contractId)?.message}`);
  process.stdout.write('saved\n');
  for await (const _chunk of Bun.stdin.stream()) { /* wait for the parent to close standard input */ }
  store.dispose();
} else {
  throw new Error(`unknown mode ${mode}`);
}
