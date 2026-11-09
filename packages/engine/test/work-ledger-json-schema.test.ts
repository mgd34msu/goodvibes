/** Runtime bounded canonical validation stays independent of structural transport schemas. */
import { expect, test } from 'bun:test';
import { strictObject, string } from 'zod/v4';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import { workLedgerJsonSchema } from '../platform/src/platform/control-plane/work-ledger-json-schema.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { buildOperatorContract } from '../platform/src/platform/control-plane/operator-contract.js';
import { legacyWorkLedgerManifestSchema, workLedgerCommandSchema } from '../platform/src/platform/workflow/work-ledger/types.js';
import { prepareLegacyWorkLedgerMigration, LEGACY_IMPORT_MAX_BYTES } from '../platform/src/platform/workflow/work-ledger/legacy-import.js';
import { NATIVE_CONTINUATION_OPAQUE_PATTERN, nativeConversationContinuationRefSchema } from '../platform/src/platform/workflow/work-ledger/native-continuation-context.js';
import { nativeConversationIntakeResultSchema } from '../platform/src/platform/workflow/work-ledger/native-intake-wire.js';

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

test('actual intake contracts admit exact historical and opaque continuation revisions without relaxing regex admission', () => {
  const contract = buildOperatorContract(new GatewayMethodCatalog());
  const historical = { sessionId: 'hosted-session', revision: 'a'.repeat(64) };
  const current = { version: 2 as const, sessionId: 'hosted-session', revision: 'abcdefgh-abcd-efgh-ijkl-abcdefghijkl' };
  const oldOpaqueGrammar = /^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/;
  const malformed = [current.revision.slice(1), current.revision + 'a', current.revision.toUpperCase(),
    current.revision.replace('abcd-', 'abc-'), current.revision.replace('ijkl', 'ijkq'), 'g'.repeat(64)];
  for (const revision of [current.revision, ...malformed]) {
    expect(NATIVE_CONTINUATION_OPAQUE_PATTERN.test(revision)).toBe(oldOpaqueGrammar.test(revision));
  }
  for (const methodId of ['workLedger.intake.capture', 'workLedger.intake.admit', 'workLedger.intake.get']) {
    const method = contract.operator.methods.find(candidate => candidate.id === methodId);
    expect(method?.outputSchema).toBeDefined();
    if (!method?.outputSchema) throw new Error(`Missing actual intake output schema: ${methodId}`);
    for (const continuation of [historical, current]) {
      const sourceRef = { version: 1 as const, inputId: 'input', sourceId: 'source', sourceRevision: 'source-revision', sessionId: 'native-session', continuation };
      for (const result of [
        { kind: 'captured', projectId: 'project', requestId: 'request', sourceRef },
        { kind: 'turn', projectId: 'project', requestId: 'request', sourceRef, route: 'answer', text: 'Exact continuation.', continuation: { ...continuation, messages: [] } },
      ]) {
        expect(nativeConversationIntakeResultSchema.safeParse(result).success).toBe(true);
        expect(firstJsonSchemaFailure(method.outputSchema, result)).toBeUndefined();
        for (const revision of malformed) {
          expect(firstJsonSchemaFailure(method.outputSchema, { ...result, sourceRef: { ...sourceRef, continuation: { ...continuation, revision } } })).toBeDefined();
        }
      }
    }
  }
  // Runtime refinement still binds the revision representation to its version.
  expect(nativeConversationContinuationRefSchema.safeParse({ ...current, revision: historical.revision }).success).toBe(false);
  expect(nativeConversationContinuationRefSchema.safeParse({ ...historical, revision: current.revision }).success).toBe(false);
  for (const pattern of ['(a+)+$', '(a{1,8})+$', '(a)\\1', '(?<=a)b']) {
    expect(() => firstJsonSchemaFailure({ type: 'string', pattern }, 'a'.repeat(10_000) + '!')).toThrow('too expensive');
  }
});
