import { expect, test } from 'bun:test';
import { contractWorkReceipts } from '../platform/src/platform/contract/work-receipts.js';
import { makeContract, makeUnit } from './contract/fixtures.js';

const CARD = '4111111111111111';

function commandsFor(command: { command: string; head: string }) {
  const contract = makeContract({ units: [makeUnit({ id: 'u1', commandEvidence: [{ ...command, success: true, agentId: 'a1', turn: 1, callIndex: 0, callId: 'c1' }] })] });
  const work = contractWorkReceipts(contract, { readObservations: true });
  return JSON.stringify(work.units[0]!.commands);
}

test('a card-shaped number in the command line never reaches the planner receipt', () => {
  const receipt = commandsFor({ command: `curl -d card=${CARD} https://example.test`, head: 'ok' });
  expect(receipt).not.toContain(CARD);
  expect(receipt).toContain('WITHHELD:card-shaped-number');
});

test('a card-shaped number in the other fields of the exec envelope is withheld too', () => {
  const envelope = JSON.stringify({ cmd: 'env', exit_code: 0, success: true, stdout: 'fine', stderr: '', environment: { CARD } });
  const receipt = commandsFor({ command: 'env', head: envelope });
  expect(receipt).not.toContain(CARD);
  expect(receipt).toContain('WITHHELD:card-shaped-number');
});

test('output with no card-shaped number is passed through unchanged', () => {
  const receipt = commandsFor({ command: 'ls -l', head: 'total 0' });
  expect(receipt).toContain('ls -l');
  expect(receipt).not.toContain('WITHHELD');
});
