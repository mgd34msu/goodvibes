import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { KnowledgeIngestOwnership } from './ingest-context.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';
import { prepareRepairJudgmentResult } from './semantic/web-gap-repair/admission.js';
import { KnowledgeEntityAliasHoldError } from './entity-aliases.js';
import { KnowledgeSourceQualityHeldError } from './source-quality.js';
import { HomeGraphPagePriorityHeldError } from './home-graph/page-priority.js';
import { HomeGraphQualityHeldError } from './home-graph/quality/types.js';
import { KnowledgeUriCanonicalizationHeldError } from './uri-canonicalization/types.js';
import { KnowledgeGeneratedFactSupportHeldError } from './semantic/verification/types.js';

/** Keep only the existing local refusal's finite reason. Borrowed messages,
 * stacks, extra properties and reason accessors never cross this boundary. */
function restrictionFailure(error: unknown): Error {
  try {
    if (error instanceof KnowledgeEntityAliasHoldError) return new KnowledgeEntityAliasHoldError();
    if (!(error instanceof KnowledgeSourceQualityHeldError || error instanceof HomeGraphPagePriorityHeldError
      || error instanceof HomeGraphQualityHeldError || error instanceof KnowledgeUriCanonicalizationHeldError
      || error instanceof KnowledgeGeneratedFactSupportHeldError)) return new KnowledgeExtractionJudgmentHoldError();
    const descriptor = Object.getOwnPropertyDescriptor(error, 'reason');
    const reason: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (error instanceof KnowledgeSourceQualityHeldError
      && (reason === 'unsettled' || reason === 'unavailable' || reason === 'no-match' || reason === 'stale' || reason === 'aborted')) return new KnowledgeSourceQualityHeldError(reason);
    if (error instanceof HomeGraphPagePriorityHeldError
      && (reason === 'unavailable' || reason === 'uncertain' || reason === 'stale' || reason === 'aborted' || reason === 'budget')) return new HomeGraphPagePriorityHeldError(reason);
    if (error instanceof HomeGraphQualityHeldError
      && (reason === 'unconfigured' || reason === 'unavailable' || reason === 'unsettled' || reason === 'malformed' || reason === 'stale' || reason === 'aborted' || reason === 'budget' || reason === 'protected-input')) return new HomeGraphQualityHeldError(reason);
    if (error instanceof KnowledgeUriCanonicalizationHeldError
      && (reason === 'unconfigured' || reason === 'unavailable' || reason === 'uncertain' || reason === 'malformed' || reason === 'aborted' || reason === 'budget' || reason === 'stale')) return new KnowledgeUriCanonicalizationHeldError(reason);
    if (error instanceof KnowledgeGeneratedFactSupportHeldError
      && (reason === 'unsettled' || reason === 'no-support' || reason === 'unavailable' || reason === 'malformed' || reason === 'stale' || reason === 'aborted' || reason === 'budget' || reason === 'missing-evidence' || reason === 'foreign-space')) return new KnowledgeGeneratedFactSupportHeldError(reason);
  } catch { /* A borrowed object's traps cannot supply a public error. */ }
  return new KnowledgeExtractionJudgmentHoldError();
}
/** Host restrictions are synchronous; returned or thrown work never admits an effect. */
export function assertKnowledgeRestriction(check: (() => void) | undefined): void {
  let result: unknown;
  try { result = check?.(); }
  catch (error) { drainOwned(error); throw restrictionFailure(error); }
  if (result !== undefined) { drainOwned(result); throw new KnowledgeExtractionJudgmentHoldError(); }
}
/** Explicit per-extraction restrictions; never a global or ambient replacement port. */
export interface KnowledgeExtractionOwner {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  readonly retain: (check: () => void) => void;
  readonly port: (site: string) => JudgmentPort;
}
export function createKnowledgeExtractionOwner(ownership: Pick<KnowledgeIngestOwnership, 'signal' | 'assertCurrent'> = {}): KnowledgeExtractionOwner {
  const { signal, assertCurrent: callerCurrent } = ownership;
  const retained: (() => void)[] = [];
  const captures = new Map<string, JudgmentPortCapture>();
  let classic = isClassicOperation();
  const assertCaller = () => {
    try {
      if (ownership.signal !== signal || ownership.assertCurrent !== callerCurrent) throw new Error('retired');
      signal?.throwIfAborted();
      if (callerCurrent) assertKnowledgeRestriction(callerCurrent);
      for (const check of retained) assertKnowledgeRestriction(check);
      signal?.throwIfAborted();
    } catch (error) { drainOwned(error); throw restrictionFailure(error); }
  };
  const assertCurrent = () => {
    assertCaller();
    try {
      if (isClassicOperation()) classic = true;
      if (!classic) for (const captured of captures.values()) captured.assertCurrent();
    }
    catch (error) { drainOwned(error); throw restrictionFailure(error); }
  };
  return Object.freeze({ signal, assertCurrent, retain(check: () => void) { assertCurrent(); assertKnowledgeRestriction(check); assertCurrent(); retained.push(check); }, port(site: string) {
    assertCurrent(); let captured = captures.get(site);
    if (!captured) {
      captured = captureJudgmentPort(site, { signal, assertCurrent: assertCaller, prepareResultCapture: prepareRepairJudgmentResult });
      captures.set(site, captured);
    }
    return captured.port;
  } });
}
