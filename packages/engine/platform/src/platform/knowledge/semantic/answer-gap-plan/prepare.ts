import { randomUUID } from 'node:crypto';
import { toJson, type JsonValue } from '@goodvibes/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { knowledgeTerms } from '../../passages.js';
import { isActiveKnowledgeEdge } from '../../projection-utils.js';
import { knowledgeSourceJudgmentUris } from '../../source-structural-references.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../../spaces.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../../types.js';
import { sourceRankingContent } from '../answer-source-ranking.js';
import { createSemanticWriteGuard } from '../primary-source-plan.js';
import { readString, readStringArray } from '../utils.js';
import { originalText } from './references.js';
import { readAnswerGapAdmission, readAnswerGapEquivalence } from './reader.js';
import { KnowledgeAnswerGapHeldError as Held, type AnswerGapCandidate, type AnswerGapMeaning } from './types.js';
import { persistPreparedAnswerGap } from './write.js';

export interface AnswerGapContext {
  readonly spaceId: string;
  readonly sources?: readonly KnowledgeSourceRecord[] | undefined;
  readonly linkedObjects?: readonly KnowledgeNodeRecord[] | undefined;
  readonly noMatch?: boolean | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

function jsonRecord(value: object): Readonly<Record<string, JsonValue>> {
  assertJudgmentInput(value);
  const json = toJson(value);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Held('malformed');
  return json;
}
function subjectContent(node: KnowledgeNodeRecord): Readonly<Record<string, JsonValue>> {
  const identity = Object.fromEntries(['manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'entityKind', 'homeAssistant', 'subject']
    .filter((key) => node.metadata[key] !== undefined).map((key) => [key, node.metadata[key]]));
  return jsonRecord({ kind: node.kind, title: node.title, summary: node.summary, aliases: node.aliases, identity });
}
function sourceContent(source: KnowledgeSourceRecord): Readonly<Record<string, JsonValue>> {
  const uris = knowledgeSourceJudgmentUris(source);
  return jsonRecord({ ...sourceRankingContent(source), uri: uris.url ?? uris.sourceUri ?? uris.canonicalUri ?? '' });
}
function answerGap(node: KnowledgeNodeRecord): boolean { return node.kind === 'knowledge_gap' && node.metadata.gapKind === 'answer'; }

/** The same question in code: normalised text plus the exact subject ids. */
export function answerGapKey(question: string, subjectIds: readonly string[]): string {
  const text = question.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return `${text}\u0000${[...new Set(subjectIds)].sort().join('\u0000')}`;
}

/**
 * Records a question the knowledge base could not answer as a missing-answer
 * gap, after the answer was decided. Nothing of the space is read up front.
 * An earlier gap with the same normalised question and subjects is the same
 * gap (no request); otherwise the one earlier gap that shares a subject and
 * most words is read for equivalence (at most one request). The write checks
 * the generations of the rows it records against (the earlier gap, the linked
 * objects, the sources), so an unrelated write elsewhere never stops it.
 */
export function prepareAnswerGapUniverse(store: KnowledgeStore, requestedSpace: string, query: string, options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
} = {}) {
  const signal = options.signal;
  const space = normalizeKnowledgeSpaceId(requestedSpace);
  const assertCurrent = () => { if (signal?.aborted) throw new Held('aborted'); };
  return {
    assertCurrent,
    prepare(context: AnswerGapContext) {
      const callerCurrent = context.assertCurrent;
      const check = () => { assertCurrent(); callerCurrent?.(); };
      let resultPromise: ReturnType<typeof resolve> | undefined;
      async function resolve() {
        check();
        const noMatch = context.noMatch === true;
        const exactSpace = normalizeKnowledgeSpaceId(context.spaceId);
        const linkedObjects = [...(context.linkedObjects ?? [])], selectedSources = [...(context.sources ?? [])];
        if (exactSpace !== space && !(space === 'homeassistant' && isHomeAssistantKnowledgeSpace(exactSpace))
          || linkedObjects.some((node) => getKnowledgeSpaceId(node) !== exactSpace || node.status !== 'active')
          || selectedSources.some((source) => getKnowledgeSpaceId(source) !== exactSpace)) throw new Held('malformed');
        const nothing = Object.freeze({ assertCurrent: check, async persist(_reason: string): Promise<KnowledgeNodeRecord | null> { check(); return null; } });
        if (noMatch && !linkedObjects.length && exactSpace === DEFAULT_KNOWLEDGE_SPACE_ID) return nothing;

        const references = new Map<string, string>();
        let subjects = 0, sources = 0;
        const subjectReference = (id: string) => references.get(`node:${id}`) ?? (references.set(`node:${id}`, `subject-${++subjects}`), `subject-${subjects}`);
        const sourceReference = (id: string) => references.get(`source:${id}`) ?? (references.set(`source:${id}`, `source-${++sources}`), `source-${sources}`);
        const meaning = (question: string, subject: unknown, subjectRows: readonly KnowledgeNodeRecord[], sourceRows: readonly KnowledgeSourceRecord[]): AnswerGapMeaning => ({
          query: question, ...(typeof subject === 'string' ? { subject } : {}),
          subjects: subjectRows.map((node) => ({ reference: subjectReference(node.id), content: subjectContent(node) })),
          sources: sourceRows.map((source) => ({ reference: sourceReference(source.id), content: sourceContent(source) })),
        });
        const subjectIdsOf = (gap: KnowledgeNodeRecord) => [...new Set([
          ...(gap.subjectIds ?? []), ...(gap.linkedObjectIds ?? []), readString(gap.metadata.subjectId),
          ...readStringArray(gap.metadata.subjectIds), ...readStringArray(gap.metadata.linkedObjectIds),
          ...store.edgesFor('node', gap.id).filter((edge) => isActiveKnowledgeEdge(edge) && edge.fromKind === 'node'
            && edge.toKind === 'node' && edge.toId === gap.id && edge.relation === 'has_gap').map((edge) => edge.fromId),
        ].filter((id): id is string => typeof id === 'string' && id.length > 0))];
        const gapQuestion = (gap: KnowledgeNodeRecord) => originalText(gap.metadata.query) ?? gap.title;

        const currentSubjects = linkedObjects.map((node) => node.id);
        const key = answerGapKey(query, currentSubjects);
        // A gap retired after its repair is history: the same question unanswered
        // again is a new gap, with a task of its own.
        const openGap = (node: KnowledgeNodeRecord) => answerGap(node) && getKnowledgeSpaceId(node) === exactSpace
          && !(node.status !== 'active' && readString(node.metadata.repairStatus) === 'repaired');
        const gaps = store.listNodesInSpace(exactSpace).filter(openGap).map((gap) => ({ gap, subjectIds: subjectIdsOf(gap) }));
        let selected = gaps.find((entry) => answerGapKey(gapQuestion(entry.gap), entry.subjectIds) === key)?.gap;
        const decisionIds: string[] = [];
        const question = meaning(query, undefined, linkedObjects, selectedSources);
        if (!selected && noMatch && !linkedObjects.length && exactSpace === 'homeassistant') {
          const admission = await readAnswerGapAdmission(question, signal);
          check();
          if (admission.decisionId) decisionIds.push(admission.decisionId);
          if (!admission.yes) return nothing;
        }
        if (!selected) {
          // The one earlier gap about the same subjects (or, with none, another
          // subjectless gap) sharing the most words is the only one read.
          const current = new Set(currentSubjects);
          const terms = knowledgeTerms([query]);
          const overlap = (text: string) => { const words = new Set(knowledgeTerms([text])); return terms.filter((term) => words.has(term)).length; };
          const nearest = gaps
            .filter((entry) => current.size ? entry.subjectIds.some((id) => current.has(id)) : entry.subjectIds.length === 0)
            .map((entry) => ({ ...entry, score: overlap(gapQuestion(entry.gap)) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score || left.gap.id.localeCompare(right.gap.id))[0];
          if (nearest) {
            const rowsOf = (ids: readonly string[]) => ids.map((id) => store.getNode(id))
              .filter((node): node is KnowledgeNodeRecord => Boolean(node && getKnowledgeSpaceId(node) === exactSpace));
            const sourceRows = [...new Set([nearest.gap.sourceId, readString(nearest.gap.metadata.sourceId), ...readStringArray(nearest.gap.metadata.sourceIds)])]
              .flatMap((id) => { const source = id ? store.getSource(id) : null; return source && getKnowledgeSpaceId(source) === exactSpace ? [source] : []; });
            const candidate: AnswerGapCandidate = { reference: 'gap-1', title: nearest.gap.title, summary: nearest.gap.summary,
              reason: originalText(nearest.gap.metadata.reason), ...meaning(gapQuestion(nearest.gap), nearest.gap.metadata.subject, rowsOf(nearest.subjectIds), sourceRows) };
            const equivalence = await readAnswerGapEquivalence(question, candidate, signal);
            check();
            if (equivalence.decisionId) decisionIds.push(equivalence.decisionId);
            if (equivalence.yes) selected = nearest.gap;
          }
        }
        const issues = selected ? store.listIssuesInSpace(exactSpace).filter((issue) => issue.nodeId === selected!.id) : [];
        const selectedIssue = issues.filter((issue) => issue.code === 'knowledge.answer_gap').sort((left, right) => left.id.localeCompare(right.id))[0];
        const tasks = selected ? store.listRefinementTasks(Number.MAX_SAFE_INTEGER, { gapId: selected.id }) : [];
        const fingerprint = originalText(selected?.metadata.subjectFingerprint) ?? originalText(selectedIssue?.metadata.subjectFingerprint) ?? randomUUID();
        // Preserve exact IDs and the existing lifecycle fingerprint; a new UUID is only allocation.
        const target = Object.freeze({ nodeId: selected?.id ?? `sem-answer-gap-${fingerprint}`,
          issueId: selectedIssue?.id ?? `sem-answer-gap-issue-${fingerprint}`, fingerprint });
        // The rows this record is written against, compared by generation at the write.
        const guard = createSemanticWriteGuard(store, signal);
        const capture = () => {
          if (selected) guard.node(selected.id, selected);
          for (const node of linkedObjects) guard.node(node.id, node);
          for (const source of selectedSources) guard.source(source.id, source);
        };
        // A new gap: another answer to the same question may have written its own
        // gap while this one read. Checked again at the write, right before commit;
        // when one has appeared, this insert stops and that gap is the answer's gap.
        let appeared: KnowledgeNodeRecord | undefined;
        const writeCurrent = () => {
          check();
          try { guard.assertCurrent(); } catch { throw new Held(signal?.aborted ? 'aborted' : 'stale'); }
          if (!selected) {
            // Only gaps asking the same words are read for their subjects.
            const sameText = answerGapKey(query, []);
            appeared = store.listNodesInSpace(exactSpace).find((node) => node.id !== target.nodeId && openGap(node)
              && answerGapKey(gapQuestion(node), []) === sameText && answerGapKey(gapQuestion(node), subjectIdsOf(node)) === key);
            if (appeared) throw new Held('stale');
          }
        };
        return Object.freeze({ assertCurrent: check,
          async persist(reason: string): Promise<KnowledgeNodeRecord | null> {
            check(); assertJudgmentInput({ reason });
            try { capture(); } catch { throw new Held(signal?.aborted ? 'aborted' : 'stale'); }
            try {
              return await persistPreparedAnswerGap(store, { spaceId: exactSpace, query, reason, target, existing: selected,
                issue: selectedIssue, issues, tasks, sources: selectedSources, linkedObjects,
                reading: { version: 2, decisionIds } }, writeCurrent, signal);
            } catch (error) {
              if (appeared === undefined) throw error;
              return store.getNode(appeared.id) ?? appeared;
            }
          },
        });
      }
      return { assertCurrent: check, read() { return resultPromise ??= resolve(); } };
    },
  };
}
export type PreparedAnswerGapUniverse = ReturnType<typeof prepareAnswerGapUniverse>;
