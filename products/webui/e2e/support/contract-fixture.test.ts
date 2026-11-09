import { describe, expect, test } from 'bun:test';
import { assertFixtureMatchesOperatorContract, ContractShapeError } from './assert-contract-shape';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import { CONTRACT_FIXTURES, isTerminalFixture, WAITING_CONTRACT } from './contract-fixture';

describe('contract inspection fixtures match the engine wire contract', () => {
  test('all detail fixtures and both list scopes conform', () => {
    for (const contract of CONTRACT_FIXTURES) {
      expect(() => assertFixtureMatchesOperatorContract('contracts.get', contract)).not.toThrow();
    }
    for (const includeTerminal of [false, true]) {
      const contracts = CONTRACT_FIXTURES.filter((contract) => includeTerminal || !isTerminalFixture(contract));
      expect(() => assertFixtureMatchesOperatorContract('contracts.list', { contracts })).not.toThrow();
    }
    expect(() => assertFixtureMatchesOperatorContract('contracts.list', { contracts: [] })).not.toThrow();
  });

  test('fresh passing checks can omit an unused digest while supplied historical digests remain typed', () => {
    const check = { ...WAITING_CONTRACT.checks[0] } as Record<string, unknown>;
    delete check.evidenceDigest;
    check.result = 'pass';
    expect(() => assertFixtureMatchesOperatorContract('contracts.get', { ...WAITING_CONTRACT, checks: [check] })).not.toThrow();
    expect(() => assertFixtureMatchesOperatorContract('contracts.get', { ...WAITING_CONTRACT, checks: [{ ...check, evidenceDigest: 'saved-check-digest' }] })).not.toThrow();
    // The fixture shape helper checks field presence, not primitive types.
    // Validate supplied values through the actual canonical wire validator.
    const schema = operatorContract.operator.methods.find(method => method.id === 'contracts.get')?.outputSchema;
    if (!schema) throw new ContractShapeError('Missing contracts.get output schema');
    expect(firstJsonSchemaFailure(schema, { ...WAITING_CONTRACT, checks: [{ ...check, evidenceDigest: 42 }] })).not.toBeNull();
  });
});
