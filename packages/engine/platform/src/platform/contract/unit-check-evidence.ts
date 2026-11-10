/** Same-owner refusal reuse compares complete inputs directly. No private
 * comparison body is serialized or retained beyond the active run/unit owner. */
import { isDeepStrictEqual } from 'node:util';
import type { JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { UNIT_JUDGES, UNIT_JUDGE_BANDS } from './batteries/unit-judge.js';
import { unitQuality } from './batteries/unit-quality.js';
import type { CheckSettings } from './check.js';
import { judgeState, qualityState, type UnitEvidence } from './evidence.js';
import type { CheckTrigger, ContractUnit, ContractView, UnitCheck } from './types.js';

const capturedInputs = new WeakSet<object>();

export function captureUnitCheckEvidence(input: {
  readonly contract: Pick<ContractView, 'shape'>;
  readonly unit: ContractUnit;
  readonly trigger: CheckTrigger;
  readonly evidence: UnitEvidence;
  readonly settings: CheckSettings;
}) {
  const { unit, evidence, settings } = input;
  const captured = captureStrictJudgmentJson(evidence);
  const definition = captureStrictJudgmentJson({
    goal: unit.goal, brief: unit.brief, role: unit.role,
    criteria: unit.criteria.map(({ id, text, origin, serves, quote, disposition, dispositionReason }) => ({
      id, text, origin, serves: [...serves], quote, disposition, dispositionReason,
    })),
    shape: input.contract.shape,
    trigger: input.trigger === 'turn-end' ? 'turn-end' : 'completion',
    policy: { settings, judge: { name: UNIT_JUDGES[settings.acceptanceStakes].name,
      version: UNIT_JUDGES[settings.acceptanceStakes].version, band: UNIT_JUDGE_BANDS[settings.acceptanceStakes] },
      quality: { name: unitQuality.name, version: unitQuality.version, items: unitQuality.items } },
  });
  const snapshot = {
    ...definition,
    judge: judgeState(definition, captured), quality: qualityState(definition, captured),
    // Preserve complete original ranges/bodies and unabridged path lists even
    // where a model view uses a structural projection. Timing alone is not a
    // changed gate result, and is excluded from the actual check questions too.
    original: { ...captured, ...(captured.gates === undefined ? {} : {
      gates: captured.gates.map(gate => Object.fromEntries(Object.entries(gate).filter(([key]) => key !== 'durationMs'))),
    }) },
  };
  // Both original inputs were admitted and detached above. The derived views
  // contain only those immutable values and locally created data properties;
  // freeze them in place instead of cloning the full evidence a second time.
  const pending: object[] = [snapshot], seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    for (const member of Object.values(value)) if (member !== null && typeof member === 'object') pending.push(member);
    Object.freeze(value);
  }
  capturedInputs.add(snapshot);
  return snapshot;
}
export type UnitCheckEvidence = ReturnType<typeof captureUnitCheckEvidence>;

export interface UnitCheckEvidenceOwner {
  readonly run: object;
  readonly unit: object;
  readonly runtime: object;
  readonly runSignal: AbortSignal;
  readonly unitSignal: AbortSignal;
  /** The original runner checks terminal/status ownership, never caller data. */
  readonly active: () => boolean;
}
interface Retained {
  readonly owner: UnitCheckEvidenceOwner;
  readonly check: UnitCheck;
  readonly recorded: UnitCheck;
  readonly evidence: UnitCheckEvidence;
  readonly authority: JudgmentPortCapture;
  readonly same: boolean;
  readonly release: () => void;
}

/** One actual latest refusal per runtime. Source retirement removes every raw
 * comparison value and all listeners; public check copies/JSON cannot warm it. */
export function createUnitCheckEvidenceCache() {
  const retained = new WeakMap<object, Retained>();
  const active = (owner: UnitCheckEvidenceOwner): boolean => !owner.runSignal.aborted && !owner.unitSignal.aborted && owner.active();
  const forget = (runtime: object): void => { retained.get(runtime)?.release(); };
  const sameFrame = (previous: Retained, owner: UnitCheckEvidenceOwner, check: UnitCheck, evidence: UnitCheckEvidence, authority: JudgmentPortCapture): boolean => {
    try {
      if (!active(owner) || !active(previous.owner)) { previous.release(); return false; }
      previous.authority.assertCurrent(); authority.assertCurrent();
      return previous.owner.run === owner.run && previous.owner.unit === owner.unit
        && previous.owner.runSignal === owner.runSignal && previous.owner.unitSignal === owner.unitSignal
        && previous.authority.identity === authority.identity && previous.check === check
        && isDeepStrictEqual(previous.recorded, captureStrictJudgmentJson(check)) && isDeepStrictEqual(previous.evidence, evidence);
    } catch { previous.release(); return false; }
  };
  const retain = (owner: UnitCheckEvidenceOwner, check: UnitCheck, evidence: UnitCheckEvidence, authority: JudgmentPortCapture, same: boolean): void => {
    forget(owner.runtime);
    if (!active(owner) || check.result === 'pass' || !capturedInputs.has(evidence)) return;
    try { authority.assertCurrent(); } catch { return; }
    const recorded = captureStrictJudgmentJson(check);
    // The constructor already detached and froze this exact input before
    // model I/O. Copies cannot claim its provenance or require another clone.
    const snapshot = evidence;
    // A composite owns one listener per entry without adding one listener
    // per unit to the shared run/provider signals.
    const lifetime = AbortSignal.any([owner.runSignal, owner.unitSignal, authority.signal]);
    let entry: Retained;
    const release = () => {
      if (retained.get(owner.runtime) === entry) retained.delete(owner.runtime);
      lifetime.removeEventListener('abort', release);
    };
    entry = { owner, check, recorded, evidence: snapshot, authority, same, release };
    retained.set(owner.runtime, entry);
    lifetime.addEventListener('abort', release, { once: true });
    if (!active(owner) || lifetime.aborted) release();
  };
  return {
    forget,
    hasOriginal(owner: UnitCheckEvidenceOwner, check: UnitCheck): boolean {
      const previous = retained.get(owner.runtime);
      return previous?.same === true && previous.owner.run === owner.run && previous.owner.unit === owner.unit && previous.check === check;
    },
    matches(owner: UnitCheckEvidenceOwner, check: UnitCheck, evidence: UnitCheckEvidence, authority: JudgmentPortCapture): boolean {
      const previous = retained.get(owner.runtime);
      return previous?.same === true && sameFrame(previous, owner, check, evidence, authority);
    },
    matchesSaved(owner: UnitCheckEvidenceOwner, check: UnitCheck, evidence: UnitCheckEvidence, authority: JudgmentPortCapture, verify: () => boolean): boolean {
      if (!active(owner)) { forget(owner.runtime); return false; }
      try { authority.assertCurrent(); } catch { forget(owner.runtime); return false; }
      const previous = retained.get(owner.runtime);
      if (previous && sameFrame(previous, owner, check, evidence, authority)) return previous.same;
      const same = verify();
      // Remember negative comparisons too: an outage retry of this exact live
      // candidate need not hash it again. A different candidate is independently
      // compared with the saved original, never mistaken for an earlier match.
      retain(owner, check, evidence, authority, same);
      return same;
    },
    remember(owner: UnitCheckEvidenceOwner, check: UnitCheck, evidence: UnitCheckEvidence, authority: JudgmentPortCapture): void {
      retain(owner, check, evidence, authority, true);
    },
  };
}
