import { createKnowledgeIssueOperatorMutation } from '../store-lifecycle-authority.js';
import { createKnowledgeNodeOperatorMutation } from '../store-node-authority.js';
import { GoodVibesError, RefusalError, refusal } from '@goodvibes/engine/errors';
import type {
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { belongsToSpace, buildHomeGraphMetadata, readRecord, readString } from './helpers.js';
import type { HomeGraphReviewInput } from './types.js';

export interface HomeGraphReviewResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly issue?: KnowledgeIssueRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly suppression?: Record<string, unknown> | undefined;
  readonly appliedFacts?: Record<string, unknown> | undefined;
}

export async function reviewHomeGraphFact(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  input: HomeGraphReviewInput,
): Promise<HomeGraphReviewResult> {
  if (!['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'].includes(input.action)) {
    throw new GoodVibesError('Invalid Home Graph review action.', {
      category: 'bad_request', source: 'runtime', operation: 'homegraph.review',
    });
  }
  const reviewedAt = Date.now();
  if (input.issueId) {
    const issue = store.getIssue(input.issueId);
    if (!issue || !belongsToSpace(issue, spaceId)) {
      throw new GoodVibesError(`Unknown Home Graph issue: ${input.issueId}`, {
        category: 'not_found',
        source: 'runtime',
        operation: 'homegraph.review',
      });
    }
    const issueMutation = createKnowledgeIssueOperatorMutation(issue);
    const subjectNode = issue.nodeId ? store.getNode(issue.nodeId) : null;
    if (input.action === 'forget' && Object.keys(normalizeReviewFacts(input)).length === 0) {
      refuseNoEffect('issue', issue.id, 'forget', ISSUE_ACTIONS);
    }
    const appliedFacts = await applyHomeGraphReviewFacts(store, spaceId, issue, subjectNode, input);
    const suppression = buildSuppression(input, issue, reviewedAt);
    const updatedIssue = await store.upsertIssue({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      status: issueStatusForAction(input.action, issue.status),
      sourceId: issue.sourceId,
      nodeId: issue.nodeId,
      metadata: { ...buildHomeGraphMetadata(spaceId, installationId, {
        review: reviewMetadata(input, reviewedAt),
        ...(suppression ? { suppression } : {}),
      }), ...(typeof issue.metadata.namespace === 'string' ? { namespace: issue.metadata.namespace } : {}) },
    }, issueMutation).catch((error: unknown) => {
      if (!appliedFacts) throw error;
      // The node write and the issue write are separate stores calls. Say so
      // instead of reporting a plain failure; repeating the review is safe
      // because it writes the same values.
      throw new GoodVibesError(`Home Graph fact review was applied to node ${appliedFacts.node?.id ?? issue.nodeId}, but the issue ${issue.id} was not updated (${error instanceof Error ? error.message : String(error)}). Repeat the review to finish.`, {
        category: 'service', source: 'runtime', operation: 'homegraph.review', recoverable: true, cause: error,
      });
    });
    const node = appliedFacts?.node ?? subjectNode ?? undefined;
    return {
      ok: true,
      spaceId,
      issue: updatedIssue,
      ...(node ? { node } : {}),
      ...(suppression ? { suppression } : {}),
      ...(appliedFacts?.facts ? { appliedFacts: appliedFacts.facts } : {}),
    };
  }
  if (input.nodeId) {
    const node = store.getNode(input.nodeId);
    if (!node || !belongsToSpace(node, spaceId)) {
      throw new GoodVibesError(`Unknown Home Graph node: ${input.nodeId}`, {
        category: 'not_found',
        source: 'runtime',
        operation: 'homegraph.review',
      });
    }
    const facts = normalizeReviewFacts(input);
    const mutation = createKnowledgeNodeOperatorMutation(node, {
      // The store derives node status from the operator action, so bringing a retired node back has to be an accept.
      action: input.action === 'forget' || input.action === 'reject' ? 'reject'
        : input.action === 'accept' || (input.action === 'reopen' && node.status === 'stale') ? 'accept' : 'revise',
      reviewer: input.reviewer ?? 'homeassistant', facts,
      ...(['edit', 'reopen', 'resolve'].includes(input.action) && Object.keys(facts).length > 0
        ? { fieldCorrections: Object.entries(facts).map(([key, value]) => ({ path: ['metadata', key], value })) } : {}),
    });
    const updated = await store.upsertNode({
      id: node.id,
      kind: node.kind,
      slug: node.slug,
      title: node.title,
      summary: node.summary,
      aliases: node.aliases,
      status: nodeStatusForAction(input.action, node.status),
      confidence: input.action === 'accept' ? 100 : node.confidence,
      sourceId: node.sourceId,
      // The saved Home Assistant identity (object id and kind) travels with the write; without it the store rejects the node as malformed.
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeAssistant: readRecord(node.metadata.homeAssistant),
        ...facts,
      }),
    }, mutation);
    return { ok: true, spaceId, node: updated, ...(Object.keys(facts).length > 0 ? { appliedFacts: facts } : {}) };
  }
  if (input.sourceId) {
    const source = store.getSource(input.sourceId);
    if (!source || !belongsToSpace(source, spaceId)) {
      throw new GoodVibesError(`Unknown Home Graph source: ${input.sourceId}`, {
        category: 'not_found',
        source: 'runtime',
        operation: 'homegraph.review',
      });
    }
    if (!SOURCE_ACTIONS.includes(input.action)) refuseNoEffect('source', source.id, input.action, SOURCE_ACTIONS);
    if (input.action === 'reopen' && source.status !== 'stale') {
      throw new RefusalError(refusal({ code: 'HOMEGRAPH_REVIEW_NO_EFFECT', status: 409,
        state: `source ${source.id} is already ${source.status}`,
        reason: 'Reopen brings back a rejected or forgotten source; this one is still answering questions',
        next: ['Use reject or forget to retire it from answers'] }), { category: 'bad_request', source: 'runtime' });
    }
    const updated = await store.upsertSource({
      id: source.id,
      connectorId: source.connectorId,
      sourceType: source.sourceType,
      title: source.title,
      sourceUri: source.sourceUri,
      canonicalUri: source.canonicalUri,
      summary: source.summary,
      description: source.description,
      tags: source.tags,
      folderPath: source.folderPath,
      status: sourceStatusForAction(input.action, source.status),
      artifactId: source.artifactId,
      contentHash: source.contentHash,
      lastCrawledAt: source.lastCrawledAt,
      crawlError: source.crawlError,
      sessionId: source.sessionId,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        review: reviewMetadata(input, reviewedAt),
      }),
    });
    return { ok: true, spaceId, source: updated };
  }
  throw new GoodVibesError('reviewFact requires issueId, nodeId, or sourceId.', {
    category: 'bad_request',
    source: 'runtime',
    operation: 'homegraph.review',
  });
}

async function applyHomeGraphReviewFacts(
  store: KnowledgeStore,
  spaceId: string,
  issue: KnowledgeIssueRecord,
  node: KnowledgeNodeRecord | null,
  input: HomeGraphReviewInput,
): Promise<{ readonly node?: KnowledgeNodeRecord; readonly facts?: Record<string, unknown> } | undefined> {
  if (!node || !belongsToSpace(node, spaceId)) return undefined;
  const facts = deriveIssueFacts(issue, input);
  if (Object.keys(facts).length === 0) return undefined;
  // Rejecting an issue is not rejecting its node: supplied corrections revise it.
  const mutation = createKnowledgeNodeOperatorMutation(node, {
    action: input.action === 'forget' ? 'reject' : 'revise',
    reviewer: input.reviewer ?? 'homeassistant', facts,
    ...(input.action === 'accept' ? { confidence: 100 } : {}),
    ...(input.action !== 'forget'
      ? { fieldCorrections: Object.entries(facts).map(([key, value]) => ({ path: ['metadata', key], value })) } : {}),
  });
  const updated = await store.upsertNode({
    id: node.id,
    kind: node.kind,
    slug: node.slug,
    title: node.title,
    summary: node.summary,
    aliases: node.aliases,
    status: node.status,
    confidence: Math.max(node.confidence, input.action === 'accept' ? 100 : node.confidence),
    sourceId: node.sourceId,
    metadata: facts,
  }, mutation);
  return { node: updated, facts };
}

function deriveIssueFacts(issue: KnowledgeIssueRecord, input: HomeGraphReviewInput): Record<string, unknown> {
  const facts = normalizeReviewFacts(input);
  if (issue.code === 'homegraph.device.unknown_battery') {
    const category = readCategory(input);
    const batteryType = readString(facts.batteryType);
    if (batteryType && batteryType !== 'none' && typeof facts.batteryPowered !== 'boolean') {
      return { ...facts, batteryPowered: true };
    }
    if (facts.batteryPowered === false && !batteryType) {
      return { ...facts, batteryType: 'none' };
    }
    if (Object.keys(facts).length > 0) return facts;
    if (input.action === 'reject' || input.action === 'resolve' || category === 'not_applicable') {
      return { batteryPowered: false, batteryType: 'none' };
    }
  }
  if (issue.code === 'homegraph.device.missing_manual') {
    const category = readCategory(input);
    if (Object.keys(facts).length > 0) return facts;
    if (input.action === 'reject' || input.action === 'resolve' || category === 'not_applicable') {
      return { manualRequired: false };
    }
  }
  return facts;
}

/** Actions that change an issue (forget changes one only when it carries corrected facts). */
const ISSUE_ACTIONS: readonly HomeGraphReviewInput['action'][] = ['accept', 'reject', 'resolve', 'reopen', 'edit'];
/** Actions that change a source: accept records the decision, reject and forget retire it, reopen brings it back. */
const SOURCE_ACTIONS: readonly HomeGraphReviewInput['action'][] = ['accept', 'reject', 'forget', 'reopen'];

function refuseNoEffect(target: string, id: string, action: string, actions: readonly string[]): never {
  throw new RefusalError(refusal({ code: 'HOMEGRAPH_REVIEW_NO_EFFECT', status: 400,
    state: `${target} ${id} was not changed`,
    reason: `The ${action} action has no effect on a ${target}`,
    next: [`Use one of: ${actions.join(', ')}`] }), { category: 'bad_request', source: 'runtime' });
}

function normalizeReviewFacts(input: HomeGraphReviewInput): Record<string, unknown> {
  const value = readRecord(input.value);
  const fact = readRecord(value.fact);
  const source = Object.keys(fact).length > 0 ? fact : value;
  const allowed: Record<string, unknown> = {};
  for (const key of [
    'batteryPowered',
    'batteryType',
    'manualRequired',
    'manufacturer',
    'model',
    'serial',
    'firmware',
    'installDate',
    'purchaseDate',
    'warrantyExpiration',
    'shareWith',
  ]) {
    if (!(key in source)) continue;
    const value = source[key];
    const kind = FACT_VALUE_KINDS[key];
    const valid = kind === 'string-list'
      ? Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      : !kind || typeof value === kind;
    if (!valid) {
      throw new RefusalError(refusal({ code: 'HOMEGRAPH_REVIEW_VALUE_TYPE', status: 400,
        state: 'nothing was changed',
        reason: `Home Graph review value "${key}" must be a ${kind === 'string-list' ? 'list of strings' : kind}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
        next: [`Send ${key} as a ${kind === 'string-list' ? 'list of strings' : kind} and review again`] }), { category: 'bad_request', source: 'runtime' });
    }
    allowed[key] = key === 'shareWith' ? [...new Set((value as string[]).map((entry) => entry.trim().toLowerCase()).filter(Boolean))] : value;
  }
  return allowed;
}

// Later quality and passport readers treat these as typed declarations and
// hold the whole space when one is malformed, so a bad value stops here.
// `shareWith` names the sharing profiles a device appears in (for example guest).
const FACT_VALUE_KINDS: Record<string, 'boolean' | 'string' | 'string-list' | undefined> = {
  batteryPowered: 'boolean',
  manualRequired: 'boolean',
  batteryType: 'string',
  shareWith: 'string-list',
};

function reviewMetadata(input: HomeGraphReviewInput, reviewedAt: number): Record<string, unknown> {
  return {
    action: input.action,
    reviewer: input.reviewer ?? 'homeassistant',
    ...(input.claimedReviewer ? { claimedReviewer: input.claimedReviewer } : {}),
    reviewedAt,
    ...(input.value ? { value: input.value } : {}),
  };
}

function buildSuppression(
  input: HomeGraphReviewInput,
  issue: KnowledgeIssueRecord,
  reviewedAt: number,
): Record<string, unknown> | undefined {
  if (!['accept', 'reject', 'resolve'].includes(input.action)) return undefined;
  return {
    suppressed: true,
    action: input.action,
    reviewedAt,
    reviewer: input.reviewer ?? 'homeassistant',
    ...(input.claimedReviewer ? { claimedReviewer: input.claimedReviewer } : {}),
    issueId: issue.id,
    code: issue.code,
    subjectId: issue.metadata.subjectId ?? issue.nodeId ?? issue.sourceId ?? issue.id,
  };
}

function issueStatusForAction(action: HomeGraphReviewInput['action'], current: KnowledgeIssueRecord['status']): KnowledgeIssueRecord['status'] {
  if (action === 'edit' || action === 'reopen') return 'open';
  return action === 'reject' || action === 'resolve' || action === 'accept' ? 'resolved' : current;
}

/** `forget` retires a record from every read; reopening or accepting a retired record brings it back. */
function nodeStatusForAction(action: HomeGraphReviewInput['action'], current: KnowledgeNodeRecord['status']): KnowledgeNodeRecord['status'] {
  if (action === 'forget') return 'stale';
  return (action === 'reopen' || action === 'accept') && current === 'stale' ? 'active' : current;
}

/** Rejecting or forgetting a source retires it from answers; reopening or accepting a retired one brings it back. */
function sourceStatusForAction(action: HomeGraphReviewInput['action'], current: KnowledgeSourceRecord['status']): KnowledgeSourceRecord['status'] {
  if (action === 'forget' || action === 'reject') return 'stale';
  return (action === 'reopen' || action === 'accept') && current === 'stale' ? 'indexed' : current;
}

function readCategory(input: HomeGraphReviewInput): string | undefined {
  return readString(readRecord(input.value).category)?.toLowerCase().replace(/[-\s]+/g, '_');
}
