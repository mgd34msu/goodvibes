import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/errors';
import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import type { AgentNoteRecord } from '../agent/note-registry.ts';
import { type AgentResearchRunRecord } from '../agent/research-run-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { acquireLearningCuratorSource, type LearningRecord, type LearningCuratorSource, type LearningCandidateCollection, type LearningCuratorNativeContext, type LearningSessionRecord, type LearningWorkItem as WorkPlanItem } from './agent-harness-learning-curator-source.ts';
import { readLearningDuplicatePair, readLearningGrade, readLearningProposalTarget, readLearningMemoryClass, readLearningSurvivor } from './agent-harness-learning-curator-readings.ts';
import { captureCatalogData, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { LearningCandidate, LearningCandidateDraft, LearningProposalTarget, VibeCandidateKind, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
import { candidateBase, isMemoryPromptEligible, isReviewed, MIN_PROMPT_MEMORY_CONFIDENCE, learningPromotionReference, recordedPromotionReferences, localRegistryModelRoute, localRegistryRoute, missingRequirementCount } from './agent-harness-learning-curator-common.ts';
import { CONSOLIDATION_DOMAINS, consolidationCandidateForGroup, consolidationGroups, duplicatePairKey, liveGroupMembers, shortlistDuplicatePairs, survivorGroupKey } from './agent-harness-learning-curator-consolidation.ts';
import { learningContentHash, type StoredLearningGrade, type StoredLearningProposal } from './agent-harness-learning-curation-store.ts';
function captureCandidate(): LearningCandidateDraft {
  return {
    id: 'capture:reviewed-lesson',
    label: 'Capture reviewed lesson',
    domain: 'capture',
    recordId: null,
    status: isClassicOperation() ? 'unassessed' : 'ready',
    reason: isClassicOperation() ? 'No mechanical review flags were found; semantic curation remains unassessed.' : 'No urgent local-learning review candidates are present.',
    next: 'After a repeated workflow, useful preference, or durable lesson appears, capture it as a local memory, skill, routine, or persona for review.',
    inspectRoute: 'agent_harness mode:"workspace_action" actionId:"learned-behavior"',
    modelRoute: 'agent_harness mode:"workspace_actions" query:"learned behavior"',
    createRoute: 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function stableVibeIdSuffix(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52) || 'vibe';
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
  }
  return `${slug}-${hash.toString(36)}`;
}

function vibeStatusRoute(): string {
  return 'vibe action:"status"';
}

function vibeCommandInspectRoute(): string {
  return 'vibe action:"status"';
}

function vibeCandidate(
  kind: VibeCandidateKind,
  path: string,
  scope: string,
  reason: string,
): LearningCandidateDraft {
  const isBlocked = kind === 'blocked';
  return {
    id: `vibe:${kind}:${stableVibeIdSuffix(path)}`,
    label: `${isBlocked ? 'Blocked' : 'Truncated'} ${scope} VIBE.md`,
    domain: 'vibe',
    recordId: path,
    status: isBlocked ? 'needs-setup' : 'needs-review',
    reason,
    next: isBlocked
      ? 'Inspect /vibe status, edit or remove blocked content, then rerun status before relying on personality instructions.'
      : 'Inspect /vibe status and shorten the file if omitted personality instructions matter for this user.',
    ...(isBlocked ? { missingRequirements: ['VIBE.md file is not loaded into the prompt until the blocked content is repaired.'] } : {}),
    proposalFields: {
      path,
      scope,
      kind,
      reason: previewHarnessText(reason, 220),
      statusRoute: vibeStatusRoute(),
    },
    inspectRoute: vibeStatusRoute(),
    modelRoute: 'memory action:"curator" query:"vibe"',
    reviewRoute: vibeCommandInspectRoute(),
    createRoute: 'vibe action:"init" scope:"project"',
  };
}

function vibeHealthCandidates(source: LearningCuratorSource): readonly LearningCandidateDraft[] {
  const health = source.source.vibe;
  if (!health) return [];
  return [
    ...health.blocked.map((file) => vibeCandidate('blocked', file.path, file.scope, file.reason)),
    ...health.files
      .filter((file) => file.truncated)
      .map((file) => vibeCandidate(
        'truncated',
        file.path,
        file.scope,
        'VIBE.md was loaded, but only the first safe prompt budget was applied.',
      )),
  ];
}

function proposalSubject(target: LearningProposalTarget): string {
  return target === 'memory' ? 'durable memory' : `reusable ${target} behavior`;
}

/** The content a stored verdict was read from; a changed record gets no verdict until the next pass. */
const recordHashes = new WeakMap<object, string>();
function contentHash(value: unknown): string {
  if (!value || typeof value !== 'object') return learningContentHash(value);
  const known = recordHashes.get(value);
  if (known) return known;
  const hash = learningContentHash(value);
  recordHashes.set(value, hash);
  return hash;
}

function sessionHash(session: LearningSessionRecord['session']): string {
  return learningContentHash({ name: session.name, timestamp: session.timestamp ?? null, messageCount: session.messageCount ?? null, title: session.title ?? null });
}

const proposalKey = {
  note: (id: string) => `note:${id}`,
  work: (id: string) => `work_plan:${id}`,
  research: (id: string) => `research_run:${id}`,
  session: (name: string) => `session:${name}`,
};

/** The stored proposal verdict for a source, outside Classic operation; undefined when no pass has read it in this form. */
function storedProposal(source: LearningCuratorSource, key: string, hash: string): StoredLearningProposal | undefined {
  return isClassicOperation() ? undefined : source.curation.proposal(key, hash);
}

function noteBehaviorProposalCandidate(record: LearningRecord, proposal: StoredLearningProposal | undefined): LearningCandidateDraft | null {
  const { item } = record;
  const target = proposal?.target;
  if (!target || !isReviewed(item)) return null;
  const actionId = target === 'memory'
    ? 'notes-to-memory'
    : target === 'skill'
    ? 'notes-to-skill'
    : target === 'routine'
      ? 'notes-to-routine'
      : 'notes-to-persona';
  const note = record.record as AgentNoteRecord;
  if (typeof note.title !== 'string' || typeof note.body !== 'string' || !Array.isArray(note.tags)) return null;
  // The note records what was made from it, by this pass or the workspace promotion action.
  if (note.promoted?.some(entry => entry.domain === target)) return null;
  const proposalFields: NonNullable<LearningCandidateDraft['proposalFields']> = target === 'memory' ? {
    cls: proposal.cls ?? 'fact',
    scope: 'project', summary: note.title, detail: note.body, tags: note.tags.join(','),
  } : {
    target, name: note.title, description: note.title,
    detail: note.body, body: note.body, notes: note.body, steps: note.body,
    triggers: '', tags: note.tags.join(','), enable: 'yes',
  };
  return {
    id: `note-proposal:${target}:${item.id}`,
    label: `${item.name} -> ${target}`,
    domain: 'note',
    recordId: item.id,
    status: 'proposal-ready',
    reason: `Reviewed note looks like ${proposalSubject(target)}.`,
    next: `Preview the selected-note ${target} promotion, then save it only if the user wants this durable context.`,
    reviewState: item.reviewState,
    proposalTarget: target,
    proposalFields,
    inspectRoute: localRegistryRoute('note', 'get', item.id),
    modelRoute: `agent_harness mode:"workspace_action" actionId:"${actionId}"`,
    createRoute: `agent_harness mode:"run_workspace_action" actionId:"${actionId}" recordId:"${item.id}"`,
  };
}

function completedWorkDetail(item: WorkPlanItem, notes: string): string {
  return [
    `Completed work: ${item.title}`,
    item.owner ? `Owner: ${item.owner}` : '',
    item.source ? `Source: ${item.source}` : '',
    '',
    notes,
  ].filter(Boolean).join('\n');
}

function workPlanCompletionCandidate(item: WorkPlanItem, proposal: StoredLearningProposal | undefined): LearningCandidateDraft | null {
  const target = proposal?.target;
  if (!target || item.status !== 'done') return null;
  const notes = item.notes?.trim() || `Completed work item: ${item.title}`;
  const name = previewHarnessText(item.title, 80);
  const description = target === 'memory'
    ? `Durable memory learned from completed work: ${name}`
    : target === 'routine'
    ? `Repeatable workflow learned from completed work: ${name}`
    : target === 'persona'
      ? `Operating preference learned from completed work: ${name}`
      : `Reusable skill learned from completed work: ${name}`;
  const detail = completedWorkDetail(item, notes);
  return {
    id: `work-plan-proposal:${target}:${item.id}`,
    label: `${item.title} -> ${target}`,
    domain: 'work_plan',
    recordId: item.id,
    status: 'proposal-ready',
    reason: `Completed work item looks like ${proposalSubject(target)}.`,
    next: `Review the completed work notes, then capture this as Agent-local ${target} only if the user wants it reused.`,
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: proposal.cls ?? 'fact',
      scope: 'project',
      summary: previewHarnessText(item.title, 140),
      detail,
      tags: 'learned,completed-work,memory',
    } : {
      target,
      name,
      description: previewHarnessText(description, 140),
      notes: detail,
      triggers: target === 'routine' ? 'workflow, checklist' : target === 'persona' ? 'preference' : 'lesson, procedure',
      tags: `learned,completed-work,${target}`,
      enable: 'yes',
    },
    inspectRoute: `agent_work_plan action:"get" id:"${item.id}"`,
    modelRoute: 'agent_work_plan action:"get"',
    createRoute: target === 'memory'
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create"'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function researchRunDetail(run: AgentResearchRunRecord): string {
  return [
    `Completed research run: ${run.title}`,
    `Question: ${run.question}`,
    `Goal: ${run.goal}`,
    run.reportArtifactId ? `Report artifact: ${run.reportArtifactId}` : '',
    run.sourceIds.length > 0 ? `Sources: ${run.sourceIds.join(', ')}` : '',
    '',
    run.note ? `Completion note: ${run.note}` : '',
    run.plan.length > 0 ? `Plan:\n${run.plan.map((step) => `- ${step}`).join('\n')}` : '',
    run.checkpoints.length > 0 ? `Recent checkpoints:\n${run.checkpoints.slice(-3).map((checkpoint) => `- ${checkpoint.note}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function researchRunCompletionCandidate(run: AgentResearchRunRecord, proposal: StoredLearningProposal | undefined): LearningCandidateDraft | null {
  const target = proposal?.target;
  if (!target || run.status !== 'completed') return null;
  const name = previewHarnessText(run.title, 80);
  const detail = researchRunDetail(run);
  const description = target === 'memory'
    ? `Durable memory learned from completed research: ${name}`
    : target === 'routine'
      ? `Repeatable research workflow learned from completed run: ${name}`
      : target === 'persona'
        ? `Operating preference learned from completed research: ${name}`
        : `Reusable research skill learned from completed run: ${name}`;
  return {
    id: `research-run-proposal:${target}:${run.id}`,
    label: `${run.title} -> ${target}`,
    domain: 'research_run',
    recordId: run.id,
    status: 'proposal-ready',
    reason: `Completed research run looks like ${proposalSubject(target)}.`,
    next: `Review the run ledger and report artifact, then capture this as Agent-local ${target} only if it should guide future work.`,
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: proposal.cls ?? 'fact',
      scope: 'project',
      summary: previewHarnessText(run.note || run.title, 140),
      detail,
      tags: 'learned,research-run,memory',
    } : {
      target,
      name,
      description: previewHarnessText(description, 140),
      notes: detail,
      triggers: target === 'routine' ? 'research, report, workflow' : target === 'persona' ? 'research preference' : 'research, sources, report',
      tags: `learned,research-run,${target}`,
      enable: 'yes',
    },
    inspectRoute: `agent_harness mode:"research_run" runId:"${run.id}"`,
    modelRoute: 'agent_harness mode:"research_run"',
    createRoute: target === 'memory'
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create"'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (typeof message !== 'object' || message === null) return '';
  const content: unknown = 'content' in message ? message.content : undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      return 'text' in part && typeof part.text === 'string' ? part.text : '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function sessionDetail(session: LearningSessionRecord['session'], loadedText: string): string {
  return [
    `Saved session: ${session.title || session.name}`,
    `Session id: ${session.name}`,
    session.model ? `Model: ${session.model}` : '',
    session.provider ? `Provider: ${session.provider}` : '',
    session.messageCount ? `Messages: ${session.messageCount}` : '',
    '',
    loadedText ? `Relevant transcript:\n${previewHarnessText(loadedText, 1200)}` : 'Transcript unavailable from the session manager; inspect the session before capturing durable context.',
  ].filter(Boolean).join('\n');
}

function sessionText(record: LearningSessionRecord): string {
  return [record.loaded?.meta.title ?? '', ...(record.loaded?.messages ?? []).map(extractMessageText)].filter(Boolean).join('\n');
}

function sessionCompletionCandidate(record: LearningSessionRecord, proposal: StoredLearningProposal | undefined): LearningCandidateDraft | null {
  const target = proposal?.target;
  const { session } = record;
  if (!target || !session.name) return null;
  const loadedText = sessionText(record);
  const labelBase = session.title || session.name;
  const detail = sessionDetail(session, loadedText);
  const description = target === 'memory'
    ? `Durable memory learned from saved session: ${previewHarnessText(labelBase, 80)}`
    : target === 'routine'
      ? `Repeatable workflow learned from saved session: ${previewHarnessText(labelBase, 80)}`
      : target === 'persona'
        ? `Operating preference learned from saved session: ${previewHarnessText(labelBase, 80)}`
        : `Reusable skill learned from saved session: ${previewHarnessText(labelBase, 80)}`;
  return {
    id: `session-proposal:${target}:${session.name}`,
    label: `${labelBase} -> ${target}`,
    domain: 'session',
    recordId: session.name,
    status: 'proposal-ready',
    reason: `Saved session looks like ${proposalSubject(target)}.`,
    next: `Inspect the saved session transcript, then capture this as Agent-local ${target} only if it should guide future work.`,
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: proposal.cls ?? 'fact',
      scope: 'project',
      summary: previewHarnessText(loadedText || labelBase, 140),
      detail,
      tags: 'learned,saved-session,memory',
    } : {
      target,
      name: previewHarnessText(labelBase, 80),
      description: previewHarnessText(description, 140),
      notes: detail,
      triggers: target === 'routine' ? 'session, workflow' : target === 'persona' ? 'session preference' : 'session, lesson',
      tags: `learned,saved-session,${target}`,
      enable: 'yes',
    },
    inspectRoute: `sessions action:"get" sessionId:"${session.name}"`,
    modelRoute: 'sessions action:"get"',
    createRoute: target === 'memory'
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create"'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function notePromotionCandidate(record: LearningRecord): LearningCandidateDraft | null {
  const { item } = record;
  const original = record.record;
  if (!isReviewed(item) || !original || typeof original !== 'object' || !('sourceUrl' in original) || typeof original.sourceUrl !== 'string' || !original.sourceUrl) return null;
  return {
    id: `note-promote:${item.id}`,
    label: item.name,
    domain: 'note',
    recordId: item.id,
    status: 'ready-to-promote',
    reason: 'Reviewed note appears to have a source URL that may belong in isolated Agent Knowledge.',
    next: 'Promote only if the source is durable, useful later, and the user wants it in Agent Knowledge.',
    reviewState: item.reviewState,
    inspectRoute: localRegistryRoute('note', 'get', item.id),
    modelRoute: localRegistryModelRoute('note'),
    createRoute: 'agent_harness mode:"workspace_action" actionId:"notes-to-knowledge"',
  };
}

/** Review flags code decides from the record's own fields: no model is asked. */
function mechanicalCandidates(domain: LocalLearningCandidateDomain, record: LearningRecord): LearningCandidateDraft[] {
  const { item } = record;
  const candidates: LearningCandidateDraft[] = [];
  const missing = missingRequirementCount(item);
  if (missing > 0 && (domain === 'skill' || domain === 'skill_bundle' || domain === 'routine')) {
    candidates.push(candidateBase(domain, item, 'needs-setup', `${missing} setup requirement(s) are missing.`,
      'Resolve setup requirements before enabling, scheduling, or relying on this behavior.'));
  }
  if (item.confidence !== undefined && item.confidence < MIN_PROMPT_MEMORY_CONFIDENCE) {
    candidates.push(candidateBase(domain, item, 'low-confidence', `Confidence is ${item.confidence}%, below the ${MIN_PROMPT_MEMORY_CONFIDENCE}% prompt-recall floor.`,
      'Review, update confidence, or mark stale before using this memory as prompt context.'));
  }
  if (!isReviewed(item)) {
    const enabledOrActive = item.enabled === true || item.active === true;
    candidates.push(candidateBase(domain, item, 'needs-review',
      item.reviewState === 'stale'
        ? 'Record is stale and should not silently guide the assistant.'
        : enabledOrActive
          ? 'Record can influence the assistant but is not reviewed.'
          : 'Record is fresh and waiting for review.',
      'Inspect provenance and content, then review it, revise it, or mark it stale.'));
  }
  return candidates;
}

export function candidateSearchText(candidate: LearningCandidate): string {
  return [
    candidate.id,
    candidate.label,
    candidate.domain,
    candidate.recordId ?? '',
    candidate.status,
    candidate.reason,
    candidate.next,
    candidate.reviewState ?? '',
    candidate.missingRequirements?.join('\n') ?? '',
    candidate.proposalTarget ?? '',
    Object.values(candidate.proposalFields ?? {}).join('\n'),
    candidate.consolidation ? JSON.stringify(candidate.consolidation) : '',
    candidate.inspectRoute,
    candidate.modelRoute,
  ].join('\n').toLowerCase();
}

const collections = new WeakMap<LearningCandidateCollection, { readonly context: LearningCuratorNativeContext; readonly options: CatalogRankingOptions }>();

/** Only a collection issued for this exact native caller can authorize its effects. */
export function assertLearningCandidateCollection(collection: LearningCandidateCollection, context: LearningCuratorNativeContext, options: CatalogRankingOptions): void {
  const issued = collections.get(collection);
  if (!issued || issued.context !== context || issued.options !== options) throw new ToolInputProjectionError('held');
  collection.assertCurrent();
}

/**
 * The curator's candidates from one read of the stores and the verdicts the
 * last curation pass stored: review flags, setup gaps and VIBE health are
 * decided in code; proposals, duplicate groups and priorities are the stored
 * readings for records whose content has not changed since. No model is asked
 * and no saved session is loaded except the few a stored proposal names.
 */
export async function buildLearningCandidates(context: LearningCuratorNativeContext, options: CatalogRankingOptions = {}): Promise<LearningCandidateCollection> {
  return withConfiguredDecisionModelPolicy(async () => {
    const source = acquireLearningCuratorSource(context, options);
    const assembled = assembleLearningCandidates(source);
    const collection = issueCollection(source, assembled, context, options);
    return collection;
  });
}

function comparePriority(left: { readonly priority: number | null }, right: { readonly priority: number | null }): number {
  return left.priority === null ? right.priority === null ? 0 : 1 : right.priority === null ? -1 : right.priority - left.priority;
}

interface Draft { readonly candidate: LearningCandidateDraft; readonly record: unknown; readonly gradeKey: string; readonly gradeHash: string }
interface PromptRecord { readonly domain: LocalLearningCandidateDomain; readonly record: LearningRecord; readonly gradeKey: string; readonly gradeHash: string }
interface AssembledCandidates { readonly drafts: readonly Draft[]; readonly promptRecords: readonly PromptRecord[]; readonly unassessed: number }

function draft(candidate: LearningCandidateDraft, record: unknown, recordHash: string): Draft {
  return { candidate, record, gradeKey: `candidate:${candidate.id}`, gradeHash: learningContentHash({ status: candidate.status, recordHash, fields: candidate.proposalFields ?? null }) };
}

function assembleLearningCandidates(source: LearningCuratorSource): AssembledCandidates {
  const classic = isClassicOperation();
  const drafts: Draft[] = [];
  const promptRecords: PromptRecord[] = [];
  let unassessed = 0;
  for (const [domain, records] of Object.entries(source.libraries)) {
    // Iterate the domain's closed set below rather than accepting text as a domain.
    if (domain !== 'memory' && domain !== 'note' && domain !== 'persona' && domain !== 'skill' && domain !== 'skill_bundle' && domain !== 'routine') continue;
    for (const record of records) {
      const hash = contentHash(record.record);
      const local = mechanicalCandidates(domain, record);
      if (domain === 'note') {
        if (isReviewed(record.item) && !classic) {
          const proposal = source.curation.proposal(proposalKey.note(record.item.id), hash);
          if (!proposal) unassessed++;
          const behavior = noteBehaviorProposalCandidate(record, proposal);
          if (behavior) local.push(behavior);
        }
        const promotion = notePromotionCandidate(record);
        if (promotion) local.push(promotion);
      }
      for (const candidate of local) drafts.push(draft(candidate, record, hash));
      if (classic && local.length === 0) drafts.push(draft(candidateBase(domain, record.item, 'unassessed',
        'Stored record; semantic curation was not evaluated.', 'Inspect the source record and use explicit review, update or stale actions.'), record, hash));
      const eligible = domain === 'memory' ? isMemoryPromptEligible(record.item)
        : domain === 'persona' ? record.item.active === true
        : domain !== 'note' && record.item.enabled === true && missingRequirementCount(record.item) === 0;
      if (eligible) promptRecords.push({ domain, record, gradeKey: `prompt:${domain}:${record.item.id}`, gradeHash: hash });
    }
    if (classic || !CONSOLIDATION_DOMAINS.includes(domain)) continue;
    const pairs = shortlistDuplicatePairs(domain, records);
    const verdicts = new Map<string, boolean>();
    for (const [left, right] of pairs) {
      const a = records[left]!, b = records[right]!;
      const verdict = source.curation.pair(duplicatePairKey(domain, a, b), `${contentHash(a.record)}|${contentHash(b.record)}`);
      if (verdict === undefined) unassessed++;
      else verdicts.set(`${left}|${right}`, verdict);
    }
    for (const group of consolidationGroups(records, pairs, (left, right) => verdicts.get(`${left}|${right}`) === true)) {
      if (liveGroupMembers(group).length === 0) continue;
      const survivorId = storedSurvivor(source, domain, group);
      if (survivorId === undefined) { unassessed++; continue; }
      const candidate = consolidationCandidateForGroup(domain, group, survivorId);
      if (candidate) drafts.push(draft(candidate, group.map(record => record.record), learningContentHash(group.map(record => contentHash(record.record)))));
    }
  }
  if (!classic) {
    for (const item of source.source.workItems) {
      if (item.status !== 'done') continue;
      const hash = contentHash(item);
      const proposal = source.curation.proposal(proposalKey.work(item.id), hash);
      if (!proposal) unassessed++;
      const candidate = workPlanCompletionCandidate(item, proposal);
      if (candidate) drafts.push(draft(candidate, item, hash));
    }
    for (const run of source.source.researchSnapshot?.completed ?? []) {
      const hash = contentHash(run);
      const proposal = source.curation.proposal(proposalKey.research(run.id), hash);
      if (!proposal) unassessed++;
      const candidate = researchRunCompletionCandidate(run, proposal);
      if (candidate) drafts.push(draft(candidate, run, hash));
    }
    for (const session of source.source.sessions) {
      if (!session.name) continue;
      const hash = sessionHash(session);
      const proposal = storedProposal(source, proposalKey.session(session.name), hash);
      if (!proposal) { unassessed++; continue; }
      // Only a session the pass found worth proposing is opened, for its transcript excerpt.
      if (!proposal.target) continue;
      const candidate = sessionCompletionCandidate(source.loadSession(session), proposal);
      if (candidate) drafts.push(draft(candidate, { session }, hash));
    }
  }
  for (const candidate of vibeHealthCandidates(source)) drafts.push(draft(candidate, { health: source.source.vibe }, learningContentHash(source.source.vibe ?? null)));
  if (drafts.length === 0) drafts.push(draft(captureCandidate(), { noUrgentCandidates: true }, 'capture'));
  const promotedReferences = new Set(Object.values(source.libraries).flatMap(records => records.flatMap(record => recordedPromotionReferences(record.record))));
  // Notes promoted before the note kept its own record carry the workspace action's marker on the made record.
  const kept = drafts.filter(({ candidate }) => !candidate.proposalTarget || (!promotedReferences.has(learningPromotionReference(candidate.id))
    && !(candidate.domain === 'note' && candidate.recordId && promotedReferences.has(`agent-harness-note-promotion:${candidate.recordId}`))));
  return { drafts: kept, promptRecords, unassessed };
}

function survivorHash(group: readonly LearningRecord[]): string {
  return group.map(record => contentHash(record.record)).join('|');
}

function storedSurvivor(source: LearningCuratorSource, domain: LocalLearningCandidateDomain, group: readonly LearningRecord[]): string | undefined {
  const live = liveGroupMembers(group);
  if (live.length === 1) return live[0]!.item.id;
  return source.curation.survivor(survivorGroupKey(domain, group), survivorHash(group));
}

function issueCollection(source: LearningCuratorSource, assembled: AssembledCandidates, context: LearningCuratorNativeContext, options: CatalogRankingOptions): LearningCandidateCollection {
  const classic = isClassicOperation();
  const grade = (key: string, hash: string): StoredLearningGrade | undefined => classic ? undefined : source.curation.grade(key, hash);
  const promptRecords = assembled.promptRecords.map(({ domain, record, gradeKey, gradeHash }) => {
    const stored = grade(gradeKey, gradeHash);
    return { domain, item: record.item, priority: stored?.priority ?? null, scores: stored?.scores ?? null };
  });
  const candidates: LearningCandidate[] = assembled.drafts.map(({ candidate, gradeKey, gradeHash }) => {
    const stored = grade(gradeKey, gradeHash);
    return { ...candidate, scores: stored?.scores ?? null, priority: stored?.priority ?? null,
      ...(classic ? { operationProvenance: 'classic' as const, semanticAssessment: 'not-evaluated' as const } : {}),
      ...(stored && candidate.proposalTarget === 'memory' && candidate.proposalFields ? { proposalFields: { ...candidate.proposalFields, confidence: String(stored.confidence) } } : {}),
    };
  });
  const collection: LearningCandidateCollection = Object.freeze({
    candidates: captureCatalogData(candidates.sort((left, right) => comparePriority(left, right) || left.label.localeCompare(right.label))),
    promptRecords: captureCatalogData(promptRecords.sort((left, right) => comparePriority(left, right) || left.item.name.localeCompare(right.item.name))),
    unassessed: assembled.unassessed,
    lastCurationPassAt: source.curation.lastPassAt,
    assertCurrent: source.assertCurrent,
    assertCandidateCurrent: (candidate: LearningCandidate) => {
      if (!collection.candidates.includes(candidate)) throw new ToolInputProjectionError('held');
      assertLearningCandidateCollection(collection, context, options);
    },
    prepareTransition: (intent: Parameters<LearningCuratorSource['prepareTransition']>[0]) => {
      if (classic) throw new DecisionModelsDisabledError('automatic transitions from an unassessed learning inspection');
      requireDecisionFeature('automatic learning proposal or consolidation transitions; use explicit native registry actions');
      return source.prepareTransition(intent);
    },
    options: source.options,
  });
  collections.set(collection, { context, options });
  return collection;
}

export interface LearningCurationPassResult {
  /** Model readings made by this pass. */
  readonly readings: number;
  /** Verdicts reused because the record had not changed since they were read. */
  readonly reused: number;
  /** Readings the model could not settle; those records are read again by the next pass. */
  readonly unsettled: number;
  readonly proposals: number;
  readonly duplicateGroups: number;
  readonly unassessed: number;
  readonly lastPassAt: number;
}

/**
 * The owner-started curation pass (`memory action:"curate"`): reads, with the
 * decision model, only what no earlier pass read in its current form: the
 * proposal destination of each reviewed note, finished work item, completed
 * research run and saved session; the shortlisted duplicate pairs; a survivor
 * for each new duplicate group; and the priority grade of each candidate and
 * prompt record. Every verdict is stored with the hash of what it was read
 * from, so a second pass with nothing changed asks nothing. A reading the
 * model cannot settle is counted and left for the next pass; it never fails
 * the pass.
 */
export async function runLearningCurationPass(context: LearningCuratorNativeContext, options: CatalogRankingOptions = {}): Promise<LearningCurationPassResult> {
  return withConfiguredDecisionModelPolicy(async () => {
    requireDecisionFeature('the learning curation pass; inspect and edit the records explicitly with agent_local_registry');
    const source = acquireLearningCuratorSource(context, options);
    const store = source.curation;
    const live = { proposals: new Set<string>(), pairs: new Set<string>(), survivors: new Set<string>(), grades: new Set<string>() };
    let readings = 0, reused = 0, unsettled = 0;
    /** One reading; an unsettled one is counted and skipped, anything else (an abort, a lost admission) ends the pass. */
    const settle = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      try { const value = await read(); readings++; source.assertCurrent(); return value; }
      catch (error) {
        if (!(error instanceof ToolInputProjectionError) || error.problem !== 'held') throw error;
        source.assertCurrent(); unsettled++; return undefined;
      }
    };
    const proposal = async (key: string, hash: string, input: () => unknown): Promise<void> => {
      live.proposals.add(key);
      if (store.proposal(key, hash)) { reused++; return; }
      const evidence = input();
      const target = await settle(() => readLearningProposalTarget(evidence, source.options));
      if (target === undefined) return;
      if (target !== 'memory') { store.setProposal(key, hash, { target }); return; }
      const cls = await settle(() => readLearningMemoryClass(evidence, source.options));
      if (cls !== undefined) store.setProposal(key, hash, { target, cls });
    };
    try {
      for (const record of source.libraries.note) {
        if (!isReviewed(record.item)) continue;
        await proposal(proposalKey.note(record.item.id), contentHash(record.record), () => ({ origin: 'note', ...record }));
      }
      for (const item of source.source.workItems) {
        if (item.status !== 'done') continue;
        await proposal(proposalKey.work(item.id), contentHash(item), () => ({ origin: 'work_plan', record: item }));
      }
      for (const run of source.source.researchSnapshot?.completed ?? []) {
        await proposal(proposalKey.research(run.id), contentHash(run), () => ({ origin: 'research_run', record: run }));
      }
      for (const session of source.source.sessions) {
        if (!session.name) continue;
        // A transcript is loaded only for a session no pass has read in its current form.
        await proposal(proposalKey.session(session.name), sessionHash(session), () => ({ origin: 'session', record: source.loadSession(session) }));
      }
      for (const domain of CONSOLIDATION_DOMAINS) {
        const records = source.libraries[domain];
        const pairs = shortlistDuplicatePairs(domain, records);
        for (const [left, right] of pairs) {
          const a = records[left]!, b = records[right]!;
          const key = duplicatePairKey(domain, a, b), hash = `${contentHash(a.record)}|${contentHash(b.record)}`;
          live.pairs.add(key);
          if (store.pair(key, hash) !== undefined) { reused++; continue; }
          const same = await settle(() => readLearningDuplicatePair({ left: { domain, ...a }, right: { domain, ...b } }, source.options));
          if (same === undefined) logger.warn('Learning duplicate pair reading was not settled; it is read again next pass', { domain, left: a.item.id, right: b.item.id });
          else store.setPair(key, hash, same);
        }
        const groups = consolidationGroups(records, pairs, (left, right) =>
          store.pair(duplicatePairKey(domain, records[left]!, records[right]!), `${contentHash(records[left]!.record)}|${contentHash(records[right]!.record)}`) === true);
        for (const group of groups) {
          const members = liveGroupMembers(group);
          if (members.length < 2) continue;
          const key = survivorGroupKey(domain, group), hash = survivorHash(group);
          live.survivors.add(key);
          if (store.survivor(key, hash) !== undefined) { reused++; continue; }
          const index = await settle(() => readLearningSurvivor({ domain, records: members, context: { capturedAt: source.source.capturedAt } }, source.options));
          const survivor = index === undefined ? undefined : members[index];
          if (survivor) store.setSurvivor(key, hash, survivor.item.id);
        }
      }
      // Priorities last, over the candidates the stored verdicts now produce.
      const assembled = assembleLearningCandidates(source);
      const grades = [
        ...assembled.promptRecords.map(({ domain, record, gradeKey, gradeHash }) => ({ key: gradeKey, hash: gradeHash,
          input: () => ({ proposedUse: 'priority of existing eligible prompt context', domain, capturedAt: source.source.capturedAt, ...record }) })),
        ...assembled.drafts.filter(({ candidate }) => candidate.domain !== 'capture').map(({ candidate, record, gradeKey, gradeHash }) => ({ key: gradeKey, hash: gradeHash,
          input: () => ({ capturedAt: source.source.capturedAt, proposedUse: candidate.status, candidate, record }) })),
      ];
      for (const { key, hash, input } of grades) {
        live.grades.add(key);
        if (store.grade(key, hash)) { reused++; continue; }
        const graded = await settle(() => readLearningGrade(input(), source.options));
        if (graded) store.setGrade(key, hash, graded);
      }
      store.retainOnly(live);
      const at = Date.now();
      store.markPass(at);
      const after = assembleLearningCandidates(source);
      return Object.freeze({ readings, reused, unsettled, unassessed: after.unassessed, lastPassAt: at,
        proposals: after.drafts.filter(({ candidate }) => candidate.status === 'proposal-ready').length,
        duplicateGroups: after.drafts.filter(({ candidate }) => candidate.status === 'needs-consolidation').length });
    } finally {
      // Verdicts read before a stop are kept, so the next pass does not pay for them again.
      store.save();
    }
  });
}
