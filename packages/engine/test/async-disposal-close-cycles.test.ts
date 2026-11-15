import { expect, test } from 'bun:test';
import { createAsyncDisposalScope } from '../platform/src/platform/runtime/async-disposal.ts';

test('a successful late cleanup is not reported with the failure an earlier close already reported', async () => {
  const scope = createAsyncDisposalScope('fixture');
  scope.registry.add('first', () => { throw new Error('first failed'); });
  await expect(scope.close()).rejects.toMatchObject({ code: 'DISPOSAL_FAILED', failures: [{ label: 'first' }] });
  scope.registry.add('late', async () => {});
  await expect(scope.close()).resolves.toBeUndefined();
});

test('a later close reports only the failures of its own cycle', async () => {
  const scope = createAsyncDisposalScope('fixture');
  scope.registry.add('first', () => { throw new Error('first failed'); });
  await expect(scope.close()).rejects.toThrow();
  scope.registry.add('second', () => { throw new Error('second failed'); });
  const error = await scope.close().then(() => undefined, (caught: unknown) => caught);
  expect(error).toMatchObject({ failures: [{ label: 'second' }] });
});
