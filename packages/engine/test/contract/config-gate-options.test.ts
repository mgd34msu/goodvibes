/** A gate with a wrong-shaped completion option is left out of the config; the reader never throws and the other gates stay. */
import { expect, test } from 'bun:test';
import { readContractConfig, type ContractConfigReader } from '../../platform/src/platform/contract/index.js';

function reader(category: Record<string, unknown>): ContractConfigReader {
  return { get: () => undefined, getCategory: (name: string) => (name === 'contract' ? category : undefined) } as unknown as ContractConfigReader;
}

test('gates with a non-boolean required or an unknown verification are dropped without throwing', () => {
  const good = { name: 'lint', command: 'eslint .', enabled: true, required: true, verification: 'command' } as const;
  const config = reader({
    gates: [
      { name: 'test', command: 'bun test', enabled: true, required: 'yes' },
      { name: 'build', command: 'make', enabled: true, verification: 'trust-me' },
      good,
    ],
  });
  expect(readContractConfig(config).gates).toEqual([good]);
});
