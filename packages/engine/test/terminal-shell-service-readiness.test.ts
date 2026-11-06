import { expect, test } from 'bun:test';
import { collectServiceReadiness } from '@goodvibes-jev/engine/terminal-shell/health-findings';
import type { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';

test('service readiness awaits credential inspections and skips removed services', async () => {
  const config = { name: 'Example', authType: 'basic', baseUrl: '' };
  const inspections: string[] = [];
  const registry = {
    getAll: () => ({ example: config, removed: config }),
    async inspect(name: string) {
      await Promise.resolve();
      inspections.push(name);
      return name === 'removed' ? null : { config, hasPrimaryCredential: false, hasPasswordCredential: false };
    },
  } as unknown as Pick<ServiceRegistry, 'getAll' | 'inspect'>;
  expect(await collectServiceReadiness(registry, ': ')).toEqual({
    configured: 2,
    issues: ['Example: missing primary credential', 'Example: missing password credential', 'Example: no baseUrl configured'],
  });
  expect(inspections).toEqual(['example', 'removed']);
});

test('service inspection failure remains operational instead of becoming a healthy report', async () => {
  const failure = new Error('inspection unavailable');
  const registry = {
    getAll: () => ({ example: {} }),
    inspect: async () => {
      throw failure;
    },
  } as unknown as Pick<ServiceRegistry, 'getAll' | 'inspect'>;
  await expect(collectServiceReadiness(registry, ': ')).rejects.toBe(failure);
});

test('failed health inspections retain sibling credential reads until they settle', async () => {
  const sibling = Promise.withResolvers<null>();
  const failure = new Error('inspection unavailable');
  let finished = false;
  const registry = {
    getAll: () => ({ failing: {}, sibling: {} }),
    inspect(name: string) {
      if (name === 'failing') throw failure;
      return sibling.promise;
    },
  } as unknown as Pick<ServiceRegistry, 'getAll' | 'inspect'>;
  const pending = collectServiceReadiness(registry, ': ').then(
    () => {
      throw new Error('Expected inspection failure');
    },
    (error) => {
      finished = true;
      return error;
    },
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(finished).toBe(false);
  sibling.resolve(null);
  expect(await pending).toBe(failure);
});
