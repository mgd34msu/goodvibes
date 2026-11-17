import { snapshotSpeechSeams } from './speech-source.js';
import type { Reading } from '@goodvibes-jev/judgment/decisions';
import { readYesNo } from '@goodvibes-jev/judgment';
import {
  BrowserJudgmentError, BROWSER_SPEECH_SEAM_BAND, judgmentRecord, type BrowserJudgmentRequest,
} from '@goodvibes-jev/engine/daemon-api';
import type { BrowserJudgmentProjection } from './types.js';

const invalid = (): never => { throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE'); };
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function validateReading(reading: Reading): void {
  if (!reading || !['act', 'confirm', 'escalate'].includes(reading.outcome)) return invalid();
  if (reading.kind === 'yes-no') {
    judgmentRecord(reading, ['kind', 'probability', 'verdict', 'outcome']);
    if (!probability(reading.probability) || !['yes', 'no', 'uncertain'].includes(reading.verdict)) return invalid();
  } else return invalid(); // Every browser battery reads yes-no items; no choice or score rubric.
}

/** Reject malformed values and refuse executable values backed by unsettled readings. */
export function validateBrowserJudgmentProjection(request: BrowserJudgmentRequest, result: BrowserJudgmentProjection<unknown>, state?: unknown): void {
  try {
    const hasCompound = Object.hasOwn(result, 'compoundOutcome');
    judgmentRecord(result, [...(result.status === 'settled' ? ['status', 'value', 'readings'] : ['status', 'reason', 'readings']),
      ...(hasCompound ? ['compoundOutcome'] : [])]);
    if (hasCompound && (result.status !== 'held' || !['confirm', 'escalate'].includes(result.compoundOutcome!))) return invalid();
    if (!result.readings || typeof result.readings !== 'object' || Array.isArray(result.readings)) return invalid();
    const readings = Object.values(result.readings);
    if (!readings.length || readings.length > 128) return invalid();
    readings.forEach(validateReading);
    if (request.battery === 'webui.voice.speech-seams') {
      const source = snapshotSpeechSeams(state);
      judgmentRecord(result.readings, source.candidates.map((_, i) => `seam_${i}`));
      if (readings.some(reading => {
        if (reading.kind !== 'yes-no') return true;
        const expected = readYesNo({ type: 'noul', noul: reading.probability }, BROWSER_SPEECH_SEAM_BAND);
        return reading.verdict !== expected.verdict || reading.outcome !== expected.outcome;
      })) return invalid();
    } else if (request.battery === 'webui.models.catalog-provider-match') {
      judgmentRecord(result.readings, request.input.keys.map((_, index) => `key_${index}`));
      if (readings.some(reading => reading.kind !== 'yes-no')) return invalid();
    } else return invalid();
    if (result.status === 'held') {
      if (result.reason !== 'uncertain' || (!hasCompound && readings.every((reading) => reading.outcome === 'act'))) return invalid();
      return;
    }
    if (result.status !== 'settled' || readings.some((r) => r.outcome !== 'act' || (r.kind === 'yes-no' && r.verdict === 'uncertain'))) return invalid();
    if (request.battery === 'webui.voice.speech-seams') {
      const source = snapshotSpeechSeams(state); const value = judgmentRecord(result.value, ['endOffsets', 'nextCursor']);
      const expected = source.candidates.filter((_, i) => { const r = result.readings[`seam_${i}`]; return r?.kind === 'yes-no' && r.verdict === 'yes'; });
      if (value.nextCursor !== source.nextCursor || !Array.isArray(value.endOffsets) || JSON.stringify(value.endOffsets) !== JSON.stringify(expected)) return invalid();
    } else if (request.battery === 'webui.models.catalog-provider-match') {
      const value = judgmentRecord(result.value, ['matches']);
      if (!Array.isArray(value.matches) || value.matches.length !== request.input.keys.length) return invalid();
      value.matches.forEach((match, index) => {
        const reading = result.readings[`key_${index}`];
        if (typeof match !== 'boolean' || reading?.kind !== 'yes-no' || match !== (reading.verdict === 'yes')) return invalid();
      });
    } else return invalid();
  } catch { return invalid(); }
}
