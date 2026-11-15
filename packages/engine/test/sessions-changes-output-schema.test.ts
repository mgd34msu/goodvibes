import { expect, test } from 'bun:test';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.js';
import { SESSIONS_CHANGES_GET_OUTPUT_SCHEMA } from '../platform/src/platform/control-plane/operator-contract-schemas-fleet.js';

const base = {
  sessionId: 's1',
  checkpointCount: 2,
  checkpointIds: ['a', 'b'],
  from: 'a',
  to: 'b',
  files: ['x.ts'],
  unifiedDiff: '',
  stat: '',
};

test('the session changes output schema accepts the base and attribution flags the aggregate diff reports', () => {
  expect(firstJsonSchemaFailure(SESSIONS_CHANGES_GET_OUTPUT_SCHEMA, base)).toBeUndefined();
  expect(
    firstJsonSchemaFailure(SESSIONS_CHANGES_GET_OUTPUT_SCHEMA, {
      ...base,
      baseUnavailable: true,
      attributionApproximate: true,
    }),
  ).toBeUndefined();
});

test('the checkpoint restore result schema accepts the failed paths of a partly applied restore', async () => {
  const { CHECKPOINT_RESTORE_RESULT_SCHEMA } = await import('../platform/src/platform/control-plane/operator-contract-schemas-fleet.js');
  const result = { checkpointId: 'c', safetyCheckpointId: null, restoredFiles: ['a'], removedFiles: [] };
  expect(firstJsonSchemaFailure(CHECKPOINT_RESTORE_RESULT_SCHEMA, result)).toBeUndefined();
  expect(firstJsonSchemaFailure(CHECKPOINT_RESTORE_RESULT_SCHEMA, { ...result, failedPaths: [{ path: 'b', reason: 'absent' }] })).toBeUndefined();
  expect(firstJsonSchemaFailure(CHECKPOINT_RESTORE_RESULT_SCHEMA, { ...result, failedPaths: [{ path: 'b' }] })).toBeDefined();
});

test('the session changes output schema still rejects unknown fields and non-boolean flags', () => {
  expect(firstJsonSchemaFailure(SESSIONS_CHANGES_GET_OUTPUT_SCHEMA, { ...base, surprise: 1 })).toBeDefined();
  expect(firstJsonSchemaFailure(SESSIONS_CHANGES_GET_OUTPUT_SCHEMA, { ...base, attributionApproximate: 'yes' })).toBeDefined();
});
