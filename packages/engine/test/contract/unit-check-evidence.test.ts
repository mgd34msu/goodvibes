/** Source-only regressions; runtime execution waits for the coding barrier. */
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { captureJudgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureUnitCheckEvidence, createUnitCheckEvidenceCache } from '../../platform/src/platform/contract/unit-check-evidence.js';
import type { CheckSettings } from '../../platform/src/platform/contract/check.js';
import type { UnitEvidence } from '../../platform/src/platform/contract/evidence.js';
import type { UnitCheck } from '../../platform/src/platform/contract/types.js';
import { makeContract, makeUnit } from './fixtures.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const settings: CheckSettings = { acceptanceStakes: 'high', evidenceNudgeLimit: 0, stallLimit: 3, maxNudgesPerUnit: 0 };
function mutableEvidence(input: UnitEvidence) {
  return { ...input, gates: (input.gates ?? []).map(gate => ({ ...gate })), sourceReads: (input.sourceReads ?? []).map(read => ({ ...read })) };
}
function fixture() {
  const contract = makeContract(), unit = makeUnit({ status: 'held' });
  const run = {}, runtime = {}, runLife = new AbortController(), unitLife = new AbortController();
  let active = true;
  const owner = { run, unit, runtime, runSignal: runLife.signal, unitSignal: unitLife.signal, active: () => active };
  const evidence = mutableEvidence({ output: 'The exact original result.', diff: 'Original change', changedPaths: ['source.ts'], omitted: [], commands: [],
    sourceReads: [{ path: 'source.ts', returnedLines: 1, returnedRanges: ['1'], contentKind: 'declared-reference', returnedContent: 'Original complete private source.' }],
    gates: [{ gate: 'required-tests', passed: false, required: true, outcome: 'unverified', output: 'No supported assertion report', durationMs: 1 }] });
  const check: UnitCheck = { id: 'u1.k1', at: 1, trigger: 'completion', goal: { verdict: 'unshown', probabilityUnmet: 0.4, outcome: 'escalate' },
    quality: {}, result: 'native-decision', problems: ['unshown'], qualityProblems: [], decisionIds: ['actual-recorded-question'] };
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const capture = (overrides: Partial<Parameters<typeof captureUnitCheckEvidence>[0]> = {}) => captureUnitCheckEvidence({ contract, unit, evidence, settings, trigger: 'completion', ...overrides });
  const authority = () => captureJudgmentPort('contract.check.unit-judge', { signal: runLife.signal });
  return { owner, contract, unit, evidence, check, fake, capture, authority, runLife, unitLife, setActive(value: boolean) { active = value; } };
}

test('the same active run/runtime/check reuses exact evidence without hashing or asking a model', () => {
  const f = fixture(), cache = createUnitCheckEvidenceCache();
  const hashing = spyOn(Bun.CryptoHasher, 'hash'), nodeHashing = spyOn(crypto, 'createHash');
  try {
    cache.remember(f.owner, f.check, f.capture(), f.authority());
    expect(cache.matches(f.owner, f.check, f.capture(), f.authority())).toBe(true);
    // Duration is not a different gate result; all actual outcome/report data is compared.
    const current = mutableEvidence(structuredClone(f.evidence)); current.gates![0]!.durationMs = 27;
    expect(cache.matches(f.owner, f.check, f.capture({ evidence: current }), f.authority())).toBe(true);
    expect(f.fake.requests).toHaveLength(0);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(nodeHashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); nodeHashing.mockRestore(); cache.forget(f.owner.runtime); }
});

for (const changed of ['output', 'source-body', 'original-paths', 'criterion', 'quality-brief', 'gate-result', 'stakes', 'phase'] as const) {
  test(`actual changed ${changed} cannot reuse a prior refusal`, () => {
    const f = fixture(), cache = createUnitCheckEvidenceCache();
    cache.remember(f.owner, f.check, f.capture(), f.authority());
    const evidence = mutableEvidence(structuredClone(f.evidence)), unit = structuredClone(f.unit);
    const currentSettings = { ...settings };
    if (changed === 'output') evidence.output = 'An actually changed result.';
    if (changed === 'source-body') evidence.sourceReads![0] = { ...evidence.sourceReads![0]!, returnedContent: 'A different private original.' };
    if (changed === 'original-paths') evidence.changedPaths = [...evidence.changedPaths, 'actually-new.ts'];
    if (changed === 'criterion') unit.criteria[0]!.text = 'A different assigned criterion.';
    if (changed === 'quality-brief') unit.brief = 'A different assigned quality scope.';
    if (changed === 'gate-result') evidence.gates![0]!.outcome = 'failed';
    if (changed === 'stakes') currentSettings.acceptanceStakes = 'critical';
    const input = f.capture({ evidence, unit, settings: currentSettings, trigger: changed === 'phase' ? 'turn-end' : 'completion' });
    expect(cache.matches(f.owner, f.check, input, f.authority())).toBe(false);
    expect(cache.hasOriginal(f.owner, f.check)).toBe(true); // The cold digest path must not override this known changed input.
    cache.forget(f.owner.runtime);
  });
}

test('captured evidence is detached and a copied check, run, runtime or fabricated snapshot cannot warm reuse', () => {
  const f = fixture(), cache = createUnitCheckEvidenceCache(), original = f.capture();
  cache.remember(f.owner, f.check, original, f.authority());
  f.evidence.sourceReads![0] = { ...f.evidence.sourceReads![0]!, returnedContent: 'Changed after capture.' };
  expect(original.original.sourceReads![0]!.returnedContent).toBe('Original complete private source.');
  expect(cache.matches(f.owner, { ...f.check }, original, f.authority())).toBe(false);
  expect(cache.matches({ ...f.owner, run: {} }, f.check, original, f.authority())).toBe(false);
  expect(cache.matches({ ...f.owner, runtime: {} }, f.check, original, f.authority())).toBe(false);
  cache.forget(f.owner.runtime);
  cache.remember(f.owner, f.check, structuredClone(original), f.authority());
  expect(cache.matches(f.owner, f.check, original, f.authority())).toBe(false);
});

for (const stopped of ['run-aborted', 'unit-aborted', 'terminal'] as const) test(`${stopped} releases the comparison and cannot revive it`, () => {
  const f = fixture(), cache = createUnitCheckEvidenceCache(), original = f.capture();
  cache.remember(f.owner, f.check, original, f.authority());
  if (stopped === 'run-aborted') f.runLife.abort();
  else if (stopped === 'unit-aborted') f.unitLife.abort();
  else f.setActive(false);
  expect(cache.matches(f.owner, f.check, original, f.authority())).toBe(false);
  f.setActive(true);
  expect(cache.matches(f.owner, f.check, original, f.authority())).toBe(false);
});

test('same-model provider replacement and restoration cannot resurrect an old reading owner', () => {
  const f = fixture(), cache = createUnitCheckEvidenceCache(), original = f.capture();
  cache.remember(f.owner, f.check, original, f.authority());
  installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  expect(cache.matches(f.owner, f.check, original, f.authority())).toBe(false);
  installJudgmentPort(f.fake.port);
  expect(cache.matches(f.owner, f.check, original, f.authority())).toBe(false);
});

test('saved digest history and a passing check cannot create active refusal provenance', () => {
  const f = fixture(), cache = createUnitCheckEvidenceCache(), original = f.capture();
  const restored = JSON.parse(JSON.stringify({ ...f.check, evidenceDigest: 'a'.repeat(64) })) as UnitCheck;
  expect(cache.matches(f.owner, restored, original, f.authority())).toBe(false);
  cache.remember(f.owner, { ...f.check, result: 'pass' }, original, f.authority());
  expect(cache.matches(f.owner, f.check, original, f.authority())).toBe(false);
});

test('a failed cold comparison is reused without hashing again, while a changed candidate is independently checked', () => {
  const f = fixture(), cache = createUnitCheckEvidenceCache(); let verifications = 0;
  const first = f.capture();
  const verify = () => { verifications++; return false; };
  expect(cache.matchesSaved(f.owner, f.check, first, f.authority(), verify)).toBe(false);
  expect(cache.matchesSaved(f.owner, f.check, f.capture(), f.authority(), verify)).toBe(false);
  expect(verifications).toBe(1); expect(cache.hasOriginal(f.owner, f.check)).toBe(false);
  const changed = f.capture({ evidence: { ...f.evidence, output: 'A different original candidate' } });
  expect(cache.matchesSaved(f.owner, f.check, changed, f.authority(), () => { verifications++; return true; })).toBe(true);
  expect(verifications).toBe(2); expect(cache.hasOriginal(f.owner, f.check)).toBe(true);
  expect(cache.matches(f.owner, f.check, changed, f.authority())).toBe(true);
  expect(cache.matches(f.owner, f.check, first, f.authority())).toBe(false);
  cache.forget(f.owner.runtime);
});
