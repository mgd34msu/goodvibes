/** Runtime bounded canonical validation stays independent of structural transport schemas. */
import { expect, test } from 'bun:test';
import { strictObject, string } from 'zod/v4';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import { workLedgerJsonSchema } from '../sdk/src/platform/control-plane/work-ledger-json-schema.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { buildOperatorContract } from '../sdk/src/platform/control-plane/operator-contract.js';
import { legacyWorkLedgerManifestSchema, workLedgerCommandSchema } from '../sdk/src/platform/workflow/work-ledger/types.js';
import { prepareLegacyWorkLedgerMigration, LEGACY_IMPORT_MAX_BYTES } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';

function manifest() {
  const prepared = prepareLegacyWorkLedgerMigration({ hostId: 'host', projectId: 'project', expectedLedgerRevision: 0,
    pendingLocalChanges: false, occupiedWorkIds: [], sources: [{ generation: 'kr-' + 'a'.repeat(32), source: {
      id: 'source-state', connectorId: 'goodvibes-project-planning', metadata: { projectPlanning: true, projectId: 'project',
        knowledgeSpaceId: 'space', planningArtifactKind: 'state', planningArtifactId: 'state',
        value: { id: 'state', projectId: 'project', knowledgeSpaceId: 'space', tasks: [], openQuestions: [], answeredQuestions: [], decisions: [], dependencies: [] } },
    } }] });
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  return prepared.manifest;
}

test('actual operator catalog builds input and output manifest contracts without invoking or weakening the transform', () => {
  const contract = buildOperatorContract(new GatewayMethodCatalog());
  const preparation = contract.operator.methods.find(method => method.id === 'workLedger.prepareLegacyImport');
  expect(preparation).toBeDefined();
  const value = manifest();
  expect(firstJsonSchemaFailure(preparation!.outputSchema!, { kind: 'prepared', manifest: value })).toBeUndefined();
  for (const io of ['input', 'output'] as const) {
    const schema = workLedgerJsonSchema(strictObject({ manifest: legacyWorkLedgerManifestSchema }), io);
    expect(firstJsonSchemaFailure(schema, { manifest: value })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { manifest: 5 })).toBeDefined();
    expect(firstJsonSchemaFailure(schema, {})).toBeDefined();
  }
});

test('only the original known manifest output transform is representable; unrelated transforms still refuse', () => {
  expect(() => workLedgerJsonSchema(string().transform(text => text.length))).toThrow('Transforms cannot be represented');
  const direction = string().default('fallback');
  expect(workLedgerJsonSchema(strictObject({ direction }), 'input').required ?? []).toEqual([]);
  expect(workLedgerJsonSchema(strictObject({ direction }), 'output').required).toEqual(['direction']);
});

test('runtime manifest parsing still detaches/freezes canonical sources and rejects malformed or oversized import data', () => {
  const original = manifest(), borrowed = structuredClone(original), parsed = legacyWorkLedgerManifestSchema.parse(borrowed);
  expect(parsed).toEqual(original); expect(parsed).not.toBe(borrowed); expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.sources)).toBe(true);
  expect(legacyWorkLedgerManifestSchema.safeParse({ ...borrowed, digest: 'incorrect-binding' }).success).toBe(false);
  expect(legacyWorkLedgerManifestSchema.safeParse({ ...borrowed, unexpected: true }).success).toBe(false);
  expect(workLedgerCommandSchema.safeParse({ type: 'import_legacy', requestId: 'request', expectedRevision: 0,
    manifest: { ...borrowed, extra: 'x'.repeat(LEGACY_IMPORT_MAX_BYTES + 1) } }).success).toBe(false);
});
