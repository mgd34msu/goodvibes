import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { KnowledgeIngestOwnership } from './ingest-context.js';
import { KnowledgeExtractionJudgmentHoldError } from './extraction-policy.js';
import { prepareRepairJudgmentResult } from './semantic/web-gap-repair/admission.js';
/** Host restrictions are synchronous; returned or thrown work never admits an effect. */
export function assertKnowledgeRestriction(check: (() => void) | undefined): void {
  let result: unknown;
  try { result = check?.(); }
  catch (error) { drainOwned(error); throw new KnowledgeExtractionJudgmentHoldError(); }
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
    } catch { throw new KnowledgeExtractionJudgmentHoldError(); }
  };
  const assertCurrent = () => {
    assertCaller();
    try {
      if (isClassicOperation()) classic = true;
      if (!classic) for (const captured of captures.values()) captured.assertCurrent();
    }
    catch { throw new KnowledgeExtractionJudgmentHoldError(); }
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
