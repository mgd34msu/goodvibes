import { activateClassicFallback } from '../../../runtime/decision-policy.js';
import { prepareJudgmentResult } from '../../../gate/judgment-result.js';
import { captureJudgmentPort, DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { fanOut, toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { runWithBudget, SUPPORT_BUDGET_ERRORS } from '../../semantic/self-improvement-budget.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../../semantic/verification/types.js';
import { HOME_GRAPH_SUBJECT_SLOTS, homeGraphDocumentKind, homeGraphDocumentSubject } from './battery.js';

/** The caller stopped wanting the link (aborted or its home changed); nothing is written. */
export class HomeGraphAutoLinkHeldError extends Error {
  constructor(readonly reason: 'stale' | 'aborted' | 'budget' | 'malformed' | 'uncertain' | 'unavailable' | 'ambiguous') {
    super(`Home Graph automatic link held: ${reason}`); this.name = 'HomeGraphAutoLinkHeldError';
  }
}
const Held = HomeGraphAutoLinkHeldError;
/** Candidates one reading may carry; code shortlists down to this. */
export const MAX_AUTO_LINK_CANDIDATES = HOME_GRAPH_SUBJECT_SLOTS.length;
/** Longest reading state sent for one document. */
export const MAX_AUTO_LINK_READING_BYTES = 48 * 1024;
const READING_DEADLINE_MS = 30_000;

export interface AutoLinkReadingInput {
  readonly source: unknown;
  readonly candidates: readonly { readonly reference: string; readonly subject: unknown; readonly entities: readonly unknown[] }[];
}
export type AutoLinkRelation = 'has_receipt' | 'has_warranty' | 'has_manual' | 'source_for';
/** What one document's reading established. Anything but `linked` is recorded on the source, never thrown. */
export type AutoLinkReading =
  | { readonly status: 'linked'; readonly reference: string; readonly relation: AutoLinkRelation; readonly provenance: AutoLinkProvenance }
  | { readonly status: 'none' | 'ambiguous' }
  | { readonly status: 'unread'; readonly reason: 'uncertain' | 'unavailable' | 'budget' | 'deadline' | 'off' };
export interface AutoLinkProvenance { readonly judgmentDecisionIds: readonly string[]; readonly requestedModel: string; readonly model: string }

/**
 * One request per document: the document kind and the subject question for each
 * shortlisted candidate ride together. Captures the installed port once.
 */
export function createHomeGraphAutoLinkReader() {
  let installation: ReturnType<typeof captureJudgmentPort> | undefined;
  try { installation = captureJudgmentPort('engine.knowledge.homegraph-document-subject', { prepareResultCapture: prepareJudgmentResult }); } catch (error) {
    if (activateClassicFallback(error) || !(error instanceof JudgmentPortMissingError)) throw error;
  }
  return { available: installation !== undefined, async read(input: AutoLinkReadingInput, options: {
    readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void;
  }): Promise<AutoLinkReading> {
    if (!input.candidates.length) return { status: 'none' };
    if (!installation) return { status: 'unread', reason: 'unavailable' };
    const candidates = input.candidates.slice(0, MAX_AUTO_LINK_CANDIDATES);
    const state = toJson({ source: input.source, candidates: candidates.map(({ subject, entities }) => ({ subject, entities })) }) as Record<string, JsonValue>;
    assertJudgmentInput(state);
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_AUTO_LINK_READING_BYTES) return { status: 'unread', reason: 'budget' };
    const slots = HOME_GRAPH_SUBJECT_SLOTS.slice(0, candidates.length);
    const port = installation.port;
    const current = () => { if (options.signal?.aborted) throw new Held('aborted'); options.assertCurrent(); };
    const asked = await runWithBudget((signal) => fanOut(port, state, { kind: homeGraphDocumentKind, subject: homeGraphDocumentSubject },
      { signal, beforeAttempt: current, site: homeGraphDocumentSubject.name, only: { subject: slots } }),
    READING_DEADLINE_MS, AbortSignal.any([installation.signal, ...(options.signal ? [options.signal] : [])]), SUPPORT_BUDGET_ERRORS)
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    if ('error' in asked) {
      const { error } = asked;
      if (error instanceof DecisionModelsDisabledError || activateClassicFallback(error)) return { status: 'unread', reason: 'off' };
      if (options.signal?.aborted) throw new Held('aborted');
      if (error instanceof Held) throw error;
      if (error instanceof KnowledgeGeneratedFactSupportHeldError && error.reason === 'budget') return { status: 'unread', reason: 'deadline' };
      return { status: 'unread', reason: 'unavailable' };
    }
    const run = asked.value;
    current();
    const { manual, integrationDocumentation, relation } = run.readings.kind;
    if ([manual, integrationDocumentation].some((reading) => reading.outcome !== 'act' || reading.verdict === 'uncertain')
      || relation.outcome !== 'act' || !relation.choice || (relation.choice === 'has_manual') !== (manual.verdict === 'yes')) {
      run.recordAction('unread: document purpose did not settle');
      return { status: 'unread', reason: 'uncertain' };
    }
    const subjectReadings = run.readings.subject as Readonly<Record<string, { readonly outcome: string; readonly verdict: string } | undefined>>;
    const readings = slots.map((slot) => subjectReadings[slot]);
    const selected = slots.flatMap((_slot, index) => readings[index]?.outcome === 'act' && readings[index]?.verdict === 'yes' ? [candidates[index]!.reference] : []);
    const unsettled = readings.some((reading) => !reading || reading.outcome !== 'act' || reading.verdict === 'uncertain');
    if (selected.length > 1) { run.recordAction('ambiguous: several candidates read as the subject'); return { status: 'ambiguous' }; }
    if (!selected[0]) {
      run.recordAction(unsettled ? 'unread: subject did not settle' : 'none: no candidate is the subject');
      return unsettled ? { status: 'unread', reason: 'uncertain' } : { status: 'none' };
    }
    run.recordAction('linked: settled document subject; exact IDs and write policy remain local');
    return { status: 'linked', reference: selected[0], relation: relation.choice as AutoLinkRelation,
      provenance: Object.freeze({ judgmentDecisionIds: Object.freeze(run.decisionId ? [run.decisionId] : []), requestedModel: run.result.requestedModel, model: run.result.model }) };
  } };
}
