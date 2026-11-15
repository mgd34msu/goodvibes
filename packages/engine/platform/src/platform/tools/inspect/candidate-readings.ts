/**
 * One reading per file for the inspect tool's candidate lists. Code finds the
 * candidates of a file from syntax; every candidate's yes/no question rides
 * one request about that file (a long list is split into a few requests),
 * each candidate carried once as the small view its battery is calibrated on.
 * Requests per inspection follow the number of files, never the number of
 * candidates.
 *
 * With decision models off, no port installed, or a request that fails or
 * misses its deadline, the candidates are kept and marked `unassessed`; only
 * the caller's own cancellation stops the inspection.
 */
import {
  askAs,
  noul,
  readItem,
  recordAction,
  recordReadings,
  type Battery,
  type BatteryItems,
  type JsonValue,
  type JudgmentPort,
  type YesNoReading,
} from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError, JudgmentPortMissingError, judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';

/** A yes is a finding, a no dismisses it, anything else is shown as uncertain; `unassessed` was never read. */
export type CandidateReading = 'real' | 'uncertain' | 'dismissed' | 'unassessed';

/** One candidate: its id (unique within the file) and the view its question reads. */
export interface InspectCandidate {
  readonly id: string;
  readonly view: JsonValue;
}

/** Candidates one request carries. */
const CANDIDATES_PER_REQUEST = 24;
/** How long one file's request may take; an inspection is an explicit analysis the caller waits for. */
const READING_DEADLINE_MS = 15_000;

function readingOf(reading: YesNoReading): Exclude<CandidateReading, 'unassessed'> {
  if (reading.verdict === 'yes') return 'real';
  return reading.verdict === 'no' ? 'dismissed' : 'uncertain';
}

function installedPort(site: string): JudgmentPort | undefined {
  if (isClassicOperation()) return undefined;
  try { return judgmentPort(site); }
  catch (error) {
    if (error instanceof DecisionModelsDisabledError || error instanceof JudgmentPortMissingError) return undefined;
    throw error;
  }
}

/**
 * Reads `question` of `battery` for every candidate of one file. Returns one
 * reading per candidate id, and a note when any candidate stayed unassessed.
 */
export function readFileCandidates<const Items extends BatteryItems>(o: FileCandidatesRequest<Items>): Promise<{ readings: Map<string, CandidateReading>; note?: string }> {
  return defineFileCandidateReading(o.battery, o.question)(o);
}

interface FileCandidatesRequest<Items extends BatteryItems> {
  readonly site: string;
  readonly battery: Battery<Items>;
  readonly question: keyof Items & string;
  readonly file: string;
  readonly candidates: readonly InspectCandidate[];
  readonly signal?: AbortSignal | undefined;
}

/**
 * The per-file reading of one yes/no question of a registered battery: every candidate's question
 * rides one request attributed to that battery, so the decision log names the battery it calibrates.
 */
function defineFileCandidateReading<const Items extends BatteryItems>(battery: Battery<Items>, question: keyof Items & string) {
  return async (o: Omit<FileCandidatesRequest<Items>, 'battery' | 'question'>): Promise<{ readings: Map<string, CandidateReading>; note?: string }> => {
    const readings = new Map<string, CandidateReading>(o.candidates.map((candidate) => [candidate.id, 'unassessed']));
    if (o.candidates.length === 0) return { readings };
    o.signal?.throwIfAborted();
    const port = installedPort(o.site);
    if (port === undefined) {
      return { readings, note: `Decision models are off or not set up, so ${o.candidates.length} candidates are listed unassessed.` };
    }
    const item = battery.items[question];
    if (item === undefined || item.kind !== 'yes-no') throw new RangeError(`battery ${battery.name}: "${question}" is not a yes/no question`);

    // A view the input check refuses to send stays unassessed; the rest are read.
    const sendable = o.candidates.filter((candidate) => {
      try { assertJudgmentInput(candidate.view); return true; }
      catch (error) { if (error instanceof JudgmentInputError) return false; throw error; }
    });
    const batches: InspectCandidate[][] = [];
    for (let start = 0; start < sendable.length; start += CANDIDATES_PER_REQUEST) batches.push(sendable.slice(start, start + CANDIDATES_PER_REQUEST));

    let failed = 0;
    for (const batch of batches) {
      await assertCapturedToolAccessCurrent();
      const state = { file: o.file, candidates: Object.fromEntries(batch.map((candidate) => [candidate.id, candidate.view])) };
      // Each question is keyed `<question>__<candidate id>` and points at its candidate in the state.
      const key = (candidate: InspectCandidate): string => `${question}__${candidate.id}`;
      const { instructions, criteria } = item.question;
      const questions = Object.fromEntries(batch.map((candidate) => [key(candidate),
        noul({ question: instructions ?? '', candidate: `candidates.${candidate.id}` }, criteria ?? undefined)]));
      const deadline = AbortSignal.timeout(READING_DEADLINE_MS);
      try {
        const result = await askAs(port, battery, 'battery', state, questions,
          { site: o.site, signal: o.signal === undefined ? deadline : AbortSignal.any([o.signal, deadline]) });
        const read = batch.map((candidate) => [candidate.id, readingOf(readItem(item, result.answers[key(candidate)]) as YesNoReading)] as const);
        for (const [id, reading] of read) readings.set(id, reading);
        recordReadings(port, result, Object.fromEntries(read));
        recordAction(port, result.decisionId, `${question}: ${read.filter(([, reading]) => reading !== 'dismissed').length} of ${read.length} kept`);
      } catch {
        o.signal?.throwIfAborted();
        failed += batch.length;
      }
    }
    const unassessed = o.candidates.length - sendable.length + failed;
    return unassessed === 0 ? { readings } : { readings, note: `${unassessed} of ${o.candidates.length} candidates could not be read and are listed unassessed.` };
  };
}
