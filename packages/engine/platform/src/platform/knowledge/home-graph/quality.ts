import { SQLiteObservationRetiredError } from '../../state/sqlite-store.js';
import { SemanticIdentityHeldError } from '../store-semantic-fact-selector.js';
import { KnowledgeRecordAdmissionHeldError } from '../store-record-snapshot.js';
import { createHomeGraphQualityIssueIdentities } from './quality/issue-identities.js';
import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { isLegacyHomeGraphQualityIssue, KnowledgeIssueReplacementHeldError } from '../store-issue-replacement.js';
import { buildHomeGraphMetadata, readRecord } from './helpers.js';
import { readHomeGraphState, sourcesLinkedToNode } from './state.js';
import { readHomeGraphQuality, HomeGraphQualityHeldError, type HomeGraphQualityQuestion, type HomeGraphQualityReading, type HomeGraphQualityInput } from './quality/reader.js';
import { captureHomeGraphRows } from './rows-current.js';
import { preserveLegacyQualityAuthority } from './quality/fingerprint.js';
import { createQualityRevisionPlans, readQualitySubjectState, type QualityRevisionPlan } from './quality/revision.js';
import { projectHomeGraphQualityInput, readHomeGraphDeclaredBoolean } from './quality/projection.js';
import type { HomeGraphQualityAnswerMemo } from './quality-answer-memo.js';
import { withOrWithoutDecisionModel } from '../decision-policy.js';

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

type QualityReportOptions = { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined; readonly answers?: HomeGraphQualityAnswerMemo | undefined };
type QualityReport = { readonly issues: readonly KnowledgeIssueRecord[]; readonly retainedLegacyIssues: number; readonly unansweredDeviceIds: readonly string[] };

/**
 * The quality report of the space. Without a decision model the declared fields
 * still settle issues in code; a device whose questions need a reading keeps its
 * issues and is reported unanswered. When the set model fails during the pass
 * under Hybrid, the pass runs again that way instead of being held.
 */
export function refreshHomeGraphQualityReport(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  options: QualityReportOptions = {},
): Promise<QualityReport> {
  const pass = () => refreshHomeGraphQualityReportOnce(store, spaceId, installationId, options);
  return withOrWithoutDecisionModel(pass, pass, options.signal);
}

async function refreshHomeGraphQualityReportOnce(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  options: QualityReportOptions,
): Promise<QualityReport> {
  await store.init();
  const state = readHomeGraphState(store, spaceId);
  const originals = new Map(state.nodes.map(node => [node.id,node]));
  // Capture the full read-set, including hidden/terminal issues, BEFORE readings.
  const originalIssues = store.listIssuesInSpace(spaceId);
  const allIssues = originalIssues;
  for (const issue of allIssues) if (issue.metadata.namespace === homeGraphQualityNamespace(spaceId)
    && (issue.metadata.homeGraphQualityIdentityVersion !== undefined && issue.metadata.homeGraphQualityIdentityVersion !== 1
      || issue.metadata.qualityFingerprintVersion !== undefined && ![1,2].includes(issue.metadata.qualityFingerprintVersion as number)
      || issue.metadata.homeGraphQualityRevisionVersion !== undefined && issue.metadata.homeGraphQualityRevisionVersion !== 1)) throw new HomeGraphQualityHeldError('malformed');
  const identities = createHomeGraphQualityIssueIdentities(store, spaceId, homeGraphQualityNamespace(spaceId));
  // The old published ID recipe belongs to the actual saved row. Detached
  // read-set snapshots must not repeat that independent compatibility check.
  const legacyIds = new Set(originalIssues.filter(issue => isLegacyHomeGraphQualityIssue(issue, spaceId)).map(issue => issue.id));
  const legacy = allIssues.filter(issue => legacyIds.has(issue.id));
  const tuples = new Set<string>();
  const previousBySubject = new Map<string, KnowledgeIssueRecord>();
  for (const issue of [...allIssues.filter(issue => issue.metadata.namespace === homeGraphQualityNamespace(spaceId)), ...legacy]) {
    if (!['homegraph.device.missing_manual','homegraph.device.unknown_battery'].includes(issue.code) || !issue.nodeId) continue;
    const tuple = JSON.stringify([issue.code,issue.nodeId]);
    if (tuples.has(tuple) || !['open','resolved'].includes(issue.status)) throw new HomeGraphQualityHeldError('malformed');
    tuples.add(tuple);
    readQualitySubjectState(issue);
    previousBySubject.set(tuple, issue);
  }
  const revisions = createQualityRevisionPlans(store);
  const devices = state.nodes.filter((node) => node.kind === 'ha_device');
  // The rows this pass reads: each device, its entities, its linked sources and
  // the links at each device. A write anywhere else in the space does not make
  // this pass stale. Compared before the first reading and at the commit.
  const rowsCurrent = captureHomeGraphRows(store, {
    nodes: devices.flatMap((node) => [node.id, ...relatedEntities(node, state).map((entity) => entity.id)]),
    sources: devices.flatMap((node) => sourcesLinkedToNode(node.id, state).map((source) => source.id)),
    edgeEndpoints: devices.map((node) => `node:${node.id}`),
  }, () => new HomeGraphQualityHeldError('stale'));
  // Issues are what this pass replaces: an operator review or any other issue
  // write in the space since the read stops it (ids and update times, no bodies).
  const issueStamp = (issues: readonly KnowledgeIssueRecord[]) => issues.map((issue) => `${issue.id}:${issue.updatedAt}`).join('|');
  const originalIssueStamp = issueStamp(originalIssues);
  const aborted = () => { if (options.signal?.aborted) throw new HomeGraphQualityHeldError('aborted'); };
  const guard = () => {
    aborted();
    rowsCurrent();
    if (issueStamp(store.listIssuesInSpace(spaceId)) !== originalIssueStamp) throw new HomeGraphQualityHeldError('stale');
    try { store.assertRecordSnapshotFrame(() => { revisions.assertCurrent(); return undefined; }); }
    catch (error) {
      if (error instanceof SQLiteObservationRetiredError || error instanceof KnowledgeRecordAdmissionHeldError) throw new HomeGraphQualityHeldError('stale');
      throw error;
    }
  };
  guard();
  const selected = devices.map((node, index) => {
    const battery = readNonEmptyString(node.metadata.batteryType) ? false : readHomeGraphDeclaredBoolean(node.metadata.batteryPowered);
    const manual = sourcesLinkedToNode(node.id, state).length > 0 ? false : readHomeGraphDeclaredBoolean(node.metadata.manualRequired);
    const questions: HomeGraphQualityQuestion[] = [];
    if (battery === undefined && !preserveLegacyQualityAuthority(previousBySubject.get(JSON.stringify(['homegraph.device.unknown_battery',node.id])))) questions.push('batteryApplicable');
    if (manual === undefined && !preserveLegacyQualityAuthority(previousBySubject.get(JSON.stringify(['homegraph.device.missing_manual',node.id])))) questions.push('manualApplicable');
    const reference = `device-${index + 1}`;
    const entities = relatedEntities(node,state);
    const input: HomeGraphQualityInput = questions.length
      ? projectHomeGraphQualityInput(reference, node, entities, [], questions)
      : { reference, subject: { kind: 'ha_device', title: 'Declared device' }, entities: [], facts: [], questions: [] };
    return { node, battery, manual, input, original: originals.get(node.id), related: entities.map(entity => originals.get(entity.id)) };
  });
  const plans = new Map<string, QualityRevisionPlan>();
  try { store.assertRecordSnapshotFrame(() => {
    for (const { node, battery, manual, input, original, related } of selected) {
      if (!original || related.some(member => !member)) throw new HomeGraphQualityHeldError('stale');
      for (const [code, applicable] of [['homegraph.device.missing_manual', manual], ['homegraph.device.unknown_battery', battery]] as const) {
        const key = JSON.stringify([code,node.id]), previous = previousBySubject.get(key);
        if (applicable === false || preserveLegacyQualityAuthority(previous)) continue;
        plans.set(key,revisions.prepare(code,original,related.filter((member): member is KnowledgeNodeRecord => member !== undefined),input,previous));
      }
    }
    return undefined;
  }); } catch (error) {
    if (error instanceof SQLiteObservationRetiredError || error instanceof SemanticIdentityHeldError || error instanceof KnowledgeRecordAdmissionHeldError) throw new HomeGraphQualityHeldError('stale');
    throw error;
  }
  const readingOptions = { signal: options.signal, timeoutMs: options.timeoutMs, assertCurrent: aborted, leaveUnsettledUnanswered: true };
  const inputs = selected.map(({ input }) => input);
  const readings = options.answers ? await options.answers.read(inputs, readingOptions) : await readHomeGraphQuality(inputs, readingOptions);
  const issues: KnowledgeIssueUpsertInput[] = [];
  const unansweredDeviceIds: string[] = [];
  try { store.assertRecordSnapshotFrame(() => {
    for (const [index, { node, battery, manual, input }] of selected.entries()) {
      const reading = readings[index]!;
      const append = (code: string, message: string) => {
        const identity = identities.prepare(code,node.id);
        // Historical digests cannot revoke an operator's reviewed authority.
        if (preserveLegacyQualityAuthority(identity.original)) return;
        const plan = plans.get(JSON.stringify([code,node.id]));
        if (!plan) throw new HomeGraphQualityHeldError('stale');
        issues.push(qualityIssue(spaceId, installationId, identity.id, code, message, node, reading, input, identity.original, plan));
      };
      if (manual ?? reading.answers.manualApplicable) append('homegraph.device.missing_manual', `${node.title} has no linked manual or source.`);
      if (battery ?? reading.answers.batteryApplicable) append('homegraph.device.unknown_battery', `${node.title} has no known battery type.`);
      if (reading.unanswered) {
        unansweredDeviceIds.push(node.id);
        // The unsettled questions keep the issue this device already has instead of dropping it.
        for (const [code, declared] of [['homegraph.device.missing_manual', manual], ['homegraph.device.unknown_battery', battery]] as const) {
          const existing = declared === undefined ? identities.prepare(code, node.id).original : undefined;
          if (!existing || preserveLegacyQualityAuthority(existing)) continue;
          issues.push({ id: existing.id, severity: existing.severity, code: existing.code, message: existing.message, status: existing.status,
            sourceId: existing.sourceId, nodeId: existing.nodeId, metadata: existing.metadata });
        }
      }
    }
    return undefined;
  }); } catch (error) {
    if (error instanceof SQLiteObservationRetiredError || error instanceof SemanticIdentityHeldError) throw new HomeGraphQualityHeldError('stale');
    throw error;
  }
  const previous = new Map(allIssues.map((issue) => [issue.id, issue]));
  const retainedLegacyIssues = allIssues.filter((issue) => (issue.metadata.namespace === homeGraphQualityNamespace(spaceId)
    || legacyIds.has(issue.id)) && preserveLegacyQualityAuthority(issue)).length;
  let written: readonly KnowledgeIssueRecord[];
  try { written = await store.replaceIssuesGuarded(issues.filter((issue) => !preserveLegacyQualityAuthority(previous.get(issue.id!))
      && !isSuppressedGeneratedIssue(previous.get(issue.id!) ?? null, issue)),
    homeGraphQualityNamespace(spaceId), () => { guard(); identities.assertCurrent(); readings[0]?.assertCurrent(); }, legacy); }
  catch (error) { if (error instanceof KnowledgeIssueReplacementHeldError) throw new HomeGraphQualityHeldError(error.reason);
    if (error instanceof SQLiteObservationRetiredError || error instanceof SemanticIdentityHeldError) throw new HomeGraphQualityHeldError('stale'); throw error; }
  return { issues: written, retainedLegacyIssues, unansweredDeviceIds };
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
  revision: QualityRevisionPlan,
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
      ...revision.metadata(),
      homeGraphQualityIdentityVersion: 1,
      qualityReading: input.questions.includes(question)
        ? { origin: 'automatic-judgment', question, answer: reading.answers[question], ...reading.provenance[question],
          ...(reading.omitted ? { omitted: reading.omitted } : {}) }
        : { origin: 'declared-fields' },
    },
  };
}

function isSuppressedGeneratedIssue(
  existing: KnowledgeIssueRecord | null,
  input: KnowledgeIssueUpsertInput,
): boolean {
  if (!existing || existing.status !== 'resolved') return false;
  const existingRevision = typeof existing.metadata.subjectRevision === 'string'
    ? existing.metadata.subjectRevision
    : undefined;
  const inputRevision = typeof input.metadata?.subjectRevision === 'string'
    ? input.metadata.subjectRevision
    : undefined;
  return existingRevision !== undefined && existingRevision === inputRevision;
}


function relatedEntities(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): KnowledgeNodeRecord[] {
  const byId = new Map(state.nodes.map((entry) => [entry.id, entry]));
  const entities = state.edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === node.id && edge.relation === 'belongs_to_device')
    .flatMap((edge) => {
      const entry = byId.get(edge.fromId);
      return entry?.kind === 'ha_entity' ? [entry] : [];
    });
  return [...new Map(entities.map(entity => [entity.id,entity] as const)).values()]
    .sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
