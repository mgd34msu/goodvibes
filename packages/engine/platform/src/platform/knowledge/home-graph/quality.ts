import { SQLiteObservationRetiredError } from '../../state/sqlite-store.js';
import { SemanticIdentityHeldError } from '../store-semantic-fact-selector.js';
import { createHomeGraphQualityIssueIdentities } from './quality/issue-identities.js';
import { requireDecisionFeature } from '../../runtime/decision-policy.js';
import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { isLegacyHomeGraphQualityIssue, KnowledgeIssueReplacementHeldError } from '../store-issue-replacement.js';
import { buildHomeGraphMetadata, readRecord } from './helpers.js';
import { readHomeGraphState, sourcesLinkedToNode } from './state.js';
import { readHomeGraphQuality, HomeGraphQualityHeldError, HOME_GRAPH_QUALITY_LIMITS, type HomeGraphQualityQuestion, type HomeGraphQualityReading, type HomeGraphQualityInput } from './quality/reader.js';
import { HOME_GRAPH_QUALITY_FINGERPRINT_VERSION, homeGraphQualitySubjectFingerprint, preserveLegacyQualityAuthority } from './quality/fingerprint.js';
import { projectHomeGraphQualityInput, readHomeGraphDeclaredBoolean } from './quality/projection.js';

const QUALITY_NAMESPACE_PREFIX = 'homegraph';
export function homeGraphQualityNamespace(spaceId: string): string {
  return `${QUALITY_NAMESPACE_PREFIX}:${spaceId}:quality`;
}

export async function refreshHomeGraphQualityIssues(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<readonly KnowledgeIssueRecord[]> {
  return (await refreshHomeGraphQualityReport(store, spaceId, installationId, options)).issues;
}

export async function refreshHomeGraphQualityReport(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<{ readonly issues: readonly KnowledgeIssueRecord[]; readonly retainedLegacyIssues: number }> {
  requireDecisionFeature('semantic Home Graph quality assessment');
  await store.init();
  const originalState = readHomeGraphState(store, spaceId);
  const originals = new Map(originalState.nodes.map(node => [node.id,node]));
  const state = structuredClone(originalState);
  // Capture the full read-set, including hidden/terminal issues, BEFORE readings.
  const allIssues = structuredClone(store.listIssuesInSpace(spaceId));
  const version = JSON.stringify({ state, issues: allIssues });
  for (const issue of allIssues) if (issue.metadata.namespace === homeGraphQualityNamespace(spaceId)
    && (issue.metadata.homeGraphQualityIdentityVersion !== undefined && issue.metadata.homeGraphQualityIdentityVersion !== 1
      || issue.metadata.qualityFingerprintVersion !== undefined && ![1,2].includes(issue.metadata.qualityFingerprintVersion as number))) throw new HomeGraphQualityHeldError('malformed');
  const identities = createHomeGraphQualityIssueIdentities(store, spaceId, homeGraphQualityNamespace(spaceId));
  const legacy = allIssues.filter((issue) => isLegacyHomeGraphQualityIssue(issue, spaceId));
  const tuples = new Set<string>();
  for (const issue of [...allIssues.filter(issue => issue.metadata.namespace === homeGraphQualityNamespace(spaceId)), ...legacy]) {
    if (!['homegraph.device.missing_manual','homegraph.device.unknown_battery'].includes(issue.code) || !issue.nodeId) continue;
    const tuple = JSON.stringify([issue.code,issue.nodeId]);
    if (tuples.has(tuple) || !['open','resolved'].includes(issue.status)) throw new HomeGraphQualityHeldError('malformed');
    tuples.add(tuple);
  }
  const guard = () => {
    if (options.signal?.aborted) throw new HomeGraphQualityHeldError('aborted');
    if (JSON.stringify({ state: readHomeGraphState(store, spaceId), issues: store.listIssuesInSpace(spaceId) }) !== version) {
      throw new HomeGraphQualityHeldError('stale');
    }
  };
  guard();
  const devices = state.nodes.filter((node) => node.kind === 'ha_device');
  if (devices.length > HOME_GRAPH_QUALITY_LIMITS.devices) throw new HomeGraphQualityHeldError('budget');
  const selected = devices.map((node, index) => {
    const battery = readNonEmptyString(node.metadata.batteryType) ? false : readHomeGraphDeclaredBoolean(node.metadata.batteryPowered);
    const manual = sourcesLinkedToNode(node.id, state).length > 0 ? false : readHomeGraphDeclaredBoolean(node.metadata.manualRequired);
    const questions: HomeGraphQualityQuestion[] = [];
    if (battery === undefined) questions.push('batteryApplicable');
    if (manual === undefined) questions.push('manualApplicable');
    const reference = `device-${index + 1}`;
    const entities = relatedEntities(node,state);
    const input: HomeGraphQualityInput = questions.length
      ? projectHomeGraphQualityInput(reference, node, entities, [], questions)
      : { reference, subject: { kind: 'ha_device', title: 'Declared device' }, entities: [], facts: [], questions: [] };
    return { node, battery, manual, input, original: originals.get(node.id), related: entities.map(entity => originals.get(entity.id)) };
  });
  const readings = await readHomeGraphQuality(selected.map(({ input }) => input), { ...options, assertCurrent: guard });
  guard();
  const issues: KnowledgeIssueUpsertInput[] = [];
  try { store.assertRecordSnapshotFrame(() => {
    for (const [index, { node, battery, manual, input, original, related }] of selected.entries()) {
      const reading = readings[index]!;
      const append = (code: string, message: string) => {
        const identity = identities.prepare(code,node.id);
        // No new digest/publication can establish a content change for this
        // earlier reviewed format. Keep it exactly, without needless hashing.
        if (preserveLegacyQualityAuthority(identity.original)) return;
        issues.push(qualityIssue(spaceId, installationId, identity.id, code, message, node, reading, input, identity.original, original, related));
      };
      if (manual ?? reading.answers.manualApplicable) append('homegraph.device.missing_manual', `${node.title} has no linked manual or source.`);
      if (battery ?? reading.answers.batteryApplicable) append('homegraph.device.unknown_battery', `${node.title} has no known battery type.`);
    }
    return undefined;
  }); } catch (error) {
    if (error instanceof SQLiteObservationRetiredError || error instanceof SemanticIdentityHeldError) throw new HomeGraphQualityHeldError('stale');
    throw error;
  }
  const previous = new Map(allIssues.map((issue) => [issue.id, issue]));
  const retainedLegacyIssues = allIssues.filter((issue) => (issue.metadata.namespace === homeGraphQualityNamespace(spaceId)
    || isLegacyHomeGraphQualityIssue(issue, spaceId)) && preserveLegacyQualityAuthority(issue)).length;
  let written: readonly KnowledgeIssueRecord[];
  try { written = await store.replaceIssuesGuarded(issues.filter((issue) => !preserveLegacyQualityAuthority(previous.get(issue.id!))
      && !isSuppressedGeneratedIssue(previous.get(issue.id!) ?? null, issue)),
    homeGraphQualityNamespace(spaceId), () => { guard(); identities.assertCurrent(); for (const reading of readings) reading.assertCurrent(); }, legacy); }
  catch (error) { if (error instanceof KnowledgeIssueReplacementHeldError) throw new HomeGraphQualityHeldError(error.reason);
    if (error instanceof SQLiteObservationRetiredError || error instanceof SemanticIdentityHeldError) throw new HomeGraphQualityHeldError('stale'); throw error; }
  return { issues: written, retainedLegacyIssues };
}

function qualityIssue(
  spaceId: string,
  installationId: string,
  id: string,
  code: string,
  message: string,
  node: KnowledgeNodeRecord,
  reading: HomeGraphQualityReading,
  input: HomeGraphQualityInput,
  existing: KnowledgeIssueRecord | undefined,
  original: KnowledgeNodeRecord | undefined,
  related: readonly (KnowledgeNodeRecord | undefined)[],
): KnowledgeIssueUpsertInput {
  const issue: KnowledgeIssueUpsertInput = { id, code, severity: 'warning', message, nodeId: node.id,
    metadata: buildHomeGraphMetadata(spaceId,installationId,{ namespace: homeGraphQualityNamespace(spaceId), subjectId: node.id }) };
  const question = code === 'homegraph.device.unknown_battery' ? 'batteryApplicable' : 'manualApplicable';
  const observedLifecycle = readRecord(existing?.metadata.issueLifecycle).id;
  return {
    ...issue,
    metadata: {
      ...(issue.metadata ?? {}),
      namespace: homeGraphQualityNamespace(spaceId),
      generated: true,
      // Current lifecycle observation only. Store-owned protected fields remain
      // authoritative; a delayed old source cannot supply a newer observation.
      ...(typeof observedLifecycle === 'string' ? { issueLifecycle: { id: observedLifecycle } } : {}),
      subjectFingerprint: memoizedQualityFingerprint(node,code,input,original,related),
      homeGraphQualityIdentityVersion: 1,
      qualityFingerprintVersion: HOME_GRAPH_QUALITY_FINGERPRINT_VERSION,
      qualityReading: input.questions.includes(question)
        ? { origin: 'automatic-judgment', question, answer: reading.answers[question], ...reading.provenance[question] }
        : { origin: 'declared-fields' },
    },
  };
}

interface QualityCommitmentMemo {
  readonly semantic: boolean;
  readonly dependencies: readonly WeakRef<KnowledgeNodeRecord>[];
  readonly fingerprint: string;
}
const memoGet = WeakMap.prototype.get, memoSet = WeakMap.prototype.set, memoApply = Reflect.apply, memoDeref = WeakRef.prototype.deref;
const qualityCommitments = new WeakMap<KnowledgeNodeRecord, Map<string,QualityCommitmentMemo>>();
/** Native store nodes are deeply frozen by retainKnowledgeNodeRecord, including
 * hydration. Keep only the digest and WEAK related-object references; hard
 * deletion does not retain a private old body merely to save a hash operation.
 * This is a data memo, never semantic or operator admission evidence. */
function memoizedQualityFingerprint(node: KnowledgeNodeRecord, code: string, input: HomeGraphQualityInput,
  original: KnowledgeNodeRecord | undefined, related: readonly (KnowledgeNodeRecord | undefined)[]): string {
  const semantic = input.questions.includes(code === 'homegraph.device.unknown_battery' ? 'batteryApplicable' : 'manualApplicable');
  const immutable = (value: KnowledgeNodeRecord | undefined): value is KnowledgeNodeRecord => !!value
    && Object.isFrozen(value) && Object.isFrozen(value.metadata) && Object.isFrozen(value.aliases);
  if (!immutable(original) || semantic && related.some(record => !immutable(record))) return homeGraphQualitySubjectFingerprint(node,code,input);
  const dependencies = semantic ? related.filter(immutable).sort((left,right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : [];
  let memo = memoApply(memoGet,qualityCommitments,[original]) as Map<string,QualityCommitmentMemo> | undefined;
  const previous = memo?.get(code);
  if (previous?.semantic === semantic && previous.dependencies.length === dependencies.length
    && previous.dependencies.every((reference,index) => memoApply(memoDeref,reference,[]) === dependencies[index])) return previous.fingerprint;
  const fingerprint = homeGraphQualitySubjectFingerprint(node,code,input);
  if (!memo) { memo = new Map(); memoApply(memoSet,qualityCommitments,[original,memo]); }
  memo.set(code,Object.freeze({ semantic, dependencies: Object.freeze(dependencies.map(record => new WeakRef(record))), fingerprint }));
  return fingerprint;
}

function isSuppressedGeneratedIssue(
  existing: KnowledgeIssueRecord | null,
  input: KnowledgeIssueUpsertInput,
): boolean {
  if (!existing || existing.status !== 'resolved') return false;
  const existingFingerprint = typeof existing.metadata.subjectFingerprint === 'string'
    ? existing.metadata.subjectFingerprint
    : undefined;
  const inputFingerprint = typeof input.metadata?.subjectFingerprint === 'string'
    ? input.metadata.subjectFingerprint
    : undefined;
  return existingFingerprint === inputFingerprint;
}


function relatedEntities(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): KnowledgeNodeRecord[] {
  const byId = new Map(state.nodes.map((entry) => [entry.id, entry]));
  return state.edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === node.id && edge.relation === 'belongs_to_device')
    .flatMap((edge) => {
      const entry = byId.get(edge.fromId);
      return entry?.kind === 'ha_entity' ? [entry] : [];
    });
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
