import { checkAnswers, matchesJudgmentModel, observeJudgmentModel, type JudgmentPort, type JudgmentResult, type Questions } from '@goodvibes-jev/judgment';
import { types } from 'node:util';
import { captureTriageData } from './evidence.js';

export const modelIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,255}$/.test(value);
/** Optional data slot only. A borrowed model getter is never configuration evidence. */
export function triageConfiguredModel(port: JudgmentPort): string | undefined {
  if (types.isProxy(port)) return undefined;
  const slot = Object.getOwnPropertyDescriptor(port, 'model');
  if (!slot || !('value' in slot)) return undefined;
  if (!modelIdentifier(slot.value)) throw new Error('Invalid triage model configuration');
  return slot.value;
}
/** Only a fully admitted immutable original can retain a strict caller-hook identity. */
function deeplyFrozenData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(slot => 'value' in slot && deeplyFrozenData(slot.value));
}
/** Complete hostile-data admission precedes reading provenance or answers. */
export function captureTriageJudgment<Q extends Questions, T extends JudgmentResult<Q>>(raw: T, questions: Q, configured?: string): {
  readonly result: T; readonly targetModel: string;
} {
  const observation = observeJudgmentModel(raw);
  const result = captureTriageData(raw) as T;
  if (!result || !modelIdentifier(result.requestedModel) || !modelIdentifier(result.model)
    || !result.usage || ![result.usage.inputTokens, result.usage.outputTokens, result.latencyMs].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new Error('Malformed triage judgment');
  if (configured !== undefined && result.requestedModel !== configured) throw new Error('Triage configured model mismatch');
  if (observation) {
    if (observation.requestedModel !== result.requestedModel || observation.model !== result.model) throw new Error('Triage native model mismatch');
  } else if (!matchesJudgmentModel(result.requestedModel, result.model)) {
    // Copied or invented JSON lineage cannot declare a fallback/alias valid.
    throw new Error('Triage model mismatch');
  }
  checkAnswers(questions, result.answers);
  return { result: observation || deeplyFrozenData(raw) ? raw : result, targetModel: observation?.targetModel ?? result.requestedModel };
}
