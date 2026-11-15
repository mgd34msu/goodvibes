import { describe, expect, test } from 'bun:test';
import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { GoogleConfigPort, GoogleSecretPort } from '@goodvibes-jev/engine/platform/platform/google';
import { googleSetupWritePorts } from '../../input/commands/google-setup-effects.ts';

/** A secret store whose generation advances by `step` per committed write, the counter the setup ports must follow rather than assume. */
function secretStore(step: number) {
  let generation = 10;
  let pending = false;
  const values = new Map<string, string>();
  const manager = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, options: { readonly assertCurrent: () => void; readonly effect: (token: object) => { readonly assertCurrent: () => void; readonly committed: () => void } }) => {
      const token = {};
      const before = generation;
      transitions.set(token, { key, before, phase: 'prepared' });
      const owner = options.effect(token);
      transitions.get(token)!.phase = 'committed';
      pending = false;
      values.set(key, value);
      generation = before + step;
      owner.committed();
    },
    assertWriteTransition: () => {},
    inspectWriteTransition: (token: object) => {
      const found = transitions.get(token)!;
      return { key: found.key, beforeGeneration: found.before, phase: found.phase };
    },
    getCredentialMutationState: () => ({ generation, pending }),
  };
  const transitions = new Map<object, { key: string; before: number; phase: string }>();
  return { manager: manager as unknown as SecretsManager, bump: () => { generation += 1; }, values };
}

const configManager = { get: () => undefined, getConfigurationIncarnation: () => 1 } as unknown as ConfigManager;
const configPort: GoogleConfigPort = { get: () => undefined, set: () => {} };
const ownership = { assertCurrent: () => {}, consumeObservation: () => {}, committed: () => {} };

function ports(store: ReturnType<typeof secretStore>) {
  const secretPort: GoogleSecretPort = { get: store.manager.get.bind(store.manager), set: async () => { throw new Error('unowned write is not under test'); } };
  return googleSetupWritePorts(configManager, store.manager, configPort, secretPort, () => {});
}

describe('Google setup write ports', () => {
  for (const step of [1, 2, 3]) {
    test(`an owned credential write that advances the store generation by ${step} is accepted and the next read still validates`, async () => {
      const store = secretStore(step);
      const write = ports(store);
      await write.secrets.set('GOOGLE_TOKEN', 'value-1', ownership);
      expect(store.values.get('GOOGLE_TOKEN')).toBe('value-1');
      expect(() => write.assertCurrent()).not.toThrow();
      expect(await write.secrets.get('GOOGLE_TOKEN')).toBe('value-1');
    });
  }

  test('a credential change made by someone else after the write is refused as an ownership change', async () => {
    const store = secretStore(2);
    const write = ports(store);
    await write.secrets.set('GOOGLE_TOKEN', 'value-1', ownership);
    store.bump();
    expect(() => write.assertCurrent()).toThrow('The Google setup credential owner changed.');
  });

  test('a credential change made by someone else before the write is refused and nothing is written', async () => {
    const store = secretStore(2);
    const write = ports(store);
    store.bump();
    await expect(write.secrets.set('GOOGLE_TOKEN', 'value-1', ownership)).rejects.toThrow();
    expect(store.values.size).toBe(0);
  });
});
