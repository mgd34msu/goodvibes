/** Actual preparation/foreign validation, no provider or product mock. Tests UNRUN. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { canonicalJson, toJson } from '@goodvibes-jev/judgment';
import {
  assertLegacyWorkLedgerSourcesCurrent, matchLegacyWorkLedgerManifest, prepareLegacyWorkLedgerMigration,
  replayLegacyWorkLedgerPreparation, validateLegacyWorkLedgerManifest, type LegacyMigrationInput, type LegacyMigrationManifest,
} from '../platform/src/platform/workflow/work-ledger/legacy-import.js';
import { workLedgerCommandSchema } from '../platform/src/platform/workflow/work-ledger/types.js';
import { createEmptyWorkLedgerState, createWorkLedger, readWorkLedgerState } from '../platform/src/platform/workflow/work-ledger/service.js';

function input() {
  const decision = { id: 'decision', title: 'Preserve the decision', text: 'Exact historical text', status: 'accepted' };
  const stateSource = { id: 'source-state', connectorId: 'goodvibes-project-planning', metadata: {
    projectPlanning: true, projectId: 'project', knowledgeSpaceId: 'space', planningArtifactKind: 'state', planningArtifactId: 'plan',
    value: { id: 'plan', projectId: 'project', knowledgeSpaceId: 'space', openQuestions: [], answeredQuestions: [], decisions: [decision], dependencies: [],
      tasks: [{ id: 'task', title: 'Exact historical task', status: 'completed' }] },
  } };
  const decisionSource = { id: 'source-decision', connectorId: 'goodvibes-project-planning', metadata: {
    projectPlanning: true, projectId: 'project', knowledgeSpaceId: 'space', planningArtifactKind: 'decision', planningArtifactId: decision.id, value: decision,
  } };
  return { hostId: 'host', projectId: 'project', expectedLedgerRevision: 0, pendingLocalChanges: false, occupiedWorkIds: [], sources: [
    { generation: 'kr-' + 'a'.repeat(32), source: stateSource },
    { generation: 'kr-' + 'b'.repeat(32), source: decisionSource },
  ] as const } satisfies LegacyMigrationInput;
}

function prepared(value: LegacyMigrationInput = input()) {
  const result = prepareLegacyWorkLedgerMigration(value);
  if (result.kind !== 'prepared') throw new Error(result.reason);
  return result.manifest;
}
function oldManifest(): LegacyMigrationManifest {
  // An independent writer of this fixed historical fixture. Do not call the
  // modern preparer only to discard its complete v2 commitment immediately.
  const original = input();
  const canonical = <T>(value: T): T => JSON.parse(canonicalJson(toJson(value))) as T;
  const stateSource = canonical(original.sources[0].source), decisionSource = canonical(original.sources[1].source);
  const state = stateSource.metadata.value, decision = decisionSource.metadata.value;
  const fragment = (sourceId: string, pointer: string, value: typeof decision | typeof state | typeof state.tasks[number]) =>
    ({ sourceId, pointer, original: value });
  const body = { version: 1 as const, hostId: original.hostId, projectId: original.projectId,
    expectedLedgerRevision: original.expectedLedgerRevision,
    sources: [
      { source: decisionSource, generation: original.sources[1].generation },
      { source: stateSource, generation: original.sources[0].generation },
    ].map(entry => ({ ...entry, digest: crypto.createHash('sha256').update(JSON.stringify(entry.source)).digest('hex') })),
    entities: [
      { kind: 'artifact' as const, id: decisionSource.id, fragments: [fragment(decisionSource.id, '/metadata/value', decision)], verification: 'unverified' as const },
      { kind: 'decision' as const, id: decision.id, fragments: [fragment(decisionSource.id, '/metadata/value', decision),
        fragment(stateSource.id, '/metadata/value/decisions/0', state.decisions[0]!)], verification: 'unverified' as const },
      { kind: 'artifact' as const, id: stateSource.id, fragments: [fragment(stateSource.id, '/metadata/value', state)], verification: 'unverified' as const },
      { kind: 'work' as const, id: state.tasks[0]!.id, fragments: [fragment(stateSource.id, '/metadata/value/tasks/0', state.tasks[0]!)],
        reportedState: 'complete' as const, verification: 'unverified' as const },
    ], links: [], executionAuthority: 'none' as const, persistence: 'not-imported' as const };
  return { ...body, digest: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

test('fresh preparation hashes only its complete saved review commitment, including duplicate decision fields', () => {
  const fresh = input(), hashing = spyOn(crypto, 'createHash');
  try {
    const manifest = prepared({ ...fresh, sources: [...fresh.sources, fresh.sources[0]!] });
    expect(manifest.version).toBe(2); expect(manifest.sources.every(entry => !Object.hasOwn(entry, 'digest'))).toBe(true);
    expect(manifest.entities.find(entity => entity.kind === 'decision')?.fragments).toHaveLength(2);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    hashing.mockClear();
    expect(validateLegacyWorkLedgerManifest(manifest)).toBe(manifest);
    const command = workLedgerCommandSchema.parse({ type: 'import_legacy', requestId: 'request', expectedRevision: 0, manifest });
    if (command.type !== 'import_legacy') throw new Error('Expected an import command');
    expect(command.manifest).toBe(manifest);
    const byId = new Map(manifest.sources.map(entry => [String(entry.source.id), entry]));
    for (let i = 0; i < 5; i++) assertLegacyWorkLedgerSourcesCurrent(manifest, id => byId.get(id)!);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});

test('copied manifest receives one complete foreign validation and then owns only its detached frozen projection', () => {
  const original = prepared(), copied = structuredClone(original), hashing = spyOn(crypto, 'createHash');
  try {
    const adopted = validateLegacyWorkLedgerManifest(copied);
    expect(adopted).not.toBe(copied); expect(Object.isFrozen(adopted)).toBe(true); expect(Object.isFrozen(adopted.sources[0]!.source)).toBe(true);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    hashing.mockClear(); expect(validateLegacyWorkLedgerManifest(adopted)).toBe(adopted);
    expect(matchLegacyWorkLedgerManifest(structuredClone(adopted), adopted)).toBe(adopted);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    const forged = structuredClone(adopted); Object.assign(forged.sources[0]!.source, { extra: 'Caller substituted source bytes' });
    expect(() => matchLegacyWorkLedgerManifest(forged, adopted)).toThrow();
    expect(() => validateLegacyWorkLedgerManifest(forged)).toThrow();
  } finally { hashing.mockRestore(); }
});

test('source currentness checks complete exact bytes and generation independently of claimed commitments', () => {
  const manifest = prepared(), source = manifest.sources[0]!;
  const lookup = (id: string) => manifest.sources.find(entry => entry.source.id === id)!;
  expect(() => assertLegacyWorkLedgerSourcesCurrent(manifest, lookup)).not.toThrow();
  for (const replacement of [
    { source: { ...source.source, unexpected: 'changed without changing generation' }, generation: source.generation },
    { source: source.source, generation: source.generation + '-new' }, { source: null, generation: null },
  ]) expect(() => assertLegacyWorkLedgerSourcesCurrent(manifest, id => id === source.source.id ? replacement : lookup(id))).toThrow();
  expect(() => validateLegacyWorkLedgerManifest({ ...manifest, version: 3 })).toThrow('Unsupported');
  expect(() => validateLegacyWorkLedgerManifest({ ...manifest, sources: manifest.sources.map(entry => ({ ...entry, digest: 'a'.repeat(64) })) })).toThrow();
});

test('actual historical format1 retains its exact per-source commitment and preparation replay recipe', () => {
  const hashing = spyOn(crypto, 'createHash');
  let old: LegacyMigrationManifest;
  try {
    old = oldManifest();
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(3); // Two old source pins and the complete old manifest.
  } finally { hashing.mockRestore(); }
  const admitted = validateLegacyWorkLedgerManifest(old);
  expect(admitted).toEqual(old); expect(admitted.version).toBe(1); expect(admitted.sources.every(entry => entry.digest?.length === 64)).toBe(true);
  expect(replayLegacyWorkLedgerPreparation(admitted, input())).toEqual({ kind: 'prepared', manifest: admitted });
  const malformed = structuredClone(admitted); delete (malformed.sources[0] as { digest?: string }).digest;
  expect(() => validateLegacyWorkLedgerManifest(malformed)).toThrow();
});

test('getters and copied public fields cannot acquire private manifest validation provenance', () => {
  const original = prepared(), copied = structuredClone(original), has = WeakSet.prototype.has, apply = Reflect.apply; let invoked = 0;
  Object.defineProperty(copied, 'sources', { enumerable: true, get() { invoked++; return original.sources; } });
  let refused = false;
  try {
    WeakSet.prototype.has = () => true; Reflect.apply = () => true;
    try { validateLegacyWorkLedgerManifest(copied); } catch { refused = true; }
  } finally { WeakSet.prototype.has = has; Reflect.apply = apply; }
  expect(refused).toBe(true); expect(invoked).toBe(0);
});

test('actual saved JSON event and receipt projections preserve canonical plain data on cold replay', async () => {
  const manifest = prepared(), byId = new Map(manifest.sources.map(entry => [String(entry.source.id), entry]));
  let state = createEmptyWorkLedgerState('project');
  const ledger = createWorkLedger({ projectId: 'project', importHostId: 'host', clock: { now: () => 10, newId: () => { throw new Error('Historical import must not mint execution identities'); } }, storage: {
    async read() { return state; }, async transaction(decide) {
      const decision = decide(state, { readSource: id => byId.get(id)! });
      if (decision.next) state = decision.next;
      return decision.value;
    },
    subscribe() { return () => {}; },
  } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'owner', role: 'coordinator' });
  try {
    expect(await ledger.service.execute({ type: 'import_legacy', requestId: 'request', expectedRevision: 0, manifest }, actor)).toMatchObject({ kind: 'accepted' });
    const saved: unknown = JSON.parse(JSON.stringify(state));
    const cold = readWorkLedgerState(saved, 'project');
    expect(cold).toEqual(state); expect(cold.history[0]).toMatchObject({ type: 'import_legacy', manifest: { version: 2 } });
    expect(Object.getPrototypeOf(manifest.sources[0]!.source)).toBe(Object.prototype);
  } finally { await ledger.service.close(); }
});

test('historical manifest1 insertion order survives saved signature validation and exact restart lookup/retry', async () => {
  const manifest = validateLegacyWorkLedgerManifest(oldManifest()), byId = new Map(manifest.sources.map(entry => [String(entry.source.id), entry]));
  let state = createEmptyWorkLedgerState('project');
  const ledger = createWorkLedger({ projectId: 'project', importHostId: 'host', clock: { now: () => 10, newId: () => { throw new Error('No execution identities'); } }, storage: {
    async read() { return state; }, async transaction(decide) { const decision = decide(state, { readSource: id => byId.get(id)! }); if (decision.next) state = decision.next; return decision.value; }, subscribe() { return () => {}; },
  } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'owner', role: 'coordinator' });
  const command = { type: 'import_legacy' as const, requestId: 'old-request', expectedRevision: 0, manifest };
  try {
    const first = await ledger.service.execute(command, actor); expect(first).toMatchObject({ kind: 'accepted', replayed: false });
    // Actual historical unknown-schema field retained these insertion-order
    // bytes; only its canonical complete data, not its key order, was validated.
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    const savedSignature = JSON.stringify({ role: 'coordinator', command: { ...command, manifest: reordered } });
    state.receipts[0]!.signature = savedSignature;
    state = readWorkLedgerState(JSON.parse(JSON.stringify(state)), 'project');
    expect(state.receipts[0]!.signature).toBe(savedSignature);
    const hashing = spyOn(crypto, 'createHash');
    try {
      expect(await ledger.service.lookupLegacyImport(command, actor)).toMatchObject({ kind: 'accepted', replayed: true });
      expect(await ledger.service.execute(command, actor)).toMatchObject({ kind: 'accepted', replayed: true });
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    } finally { hashing.mockRestore(); }
    expect(state.receipts[0]!.signature).toBe(savedSignature);
    const changed = structuredClone(state), signature = JSON.parse(changed.receipts[0]!.signature);
    signature.command.manifest.sources[0].source.extra = 'Changed while keeping its old public digest';
    changed.receipts[0]!.signature = JSON.stringify(signature);
    expect(() => readWorkLedgerState(changed, 'project')).toThrow();
    const worker = ledger.authority.issueActor({ projectId: 'project', actorId: 'owner', role: 'worker' });
    expect(await ledger.service.execute(command, worker)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
    expect(await ledger.service.execute({ ...command, expectedRevision: 1 }, actor)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  } finally { await ledger.service.close(); }
});
