import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { JudgmentError, choice, defineSelector, noul, DEFAULT_MODEL, STAKES_BANDS, toJson, type EntryType, type Questions, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStaticInputs, parseStaticSourceReadings, readStaticInput, revalidateStaticInput, STATIC_SITE, staticInputCaptureComplete, staticInputKey, staticInputStanding, staticSelectionCandidates, staticSelectionContext, type StaticSourceReadings, type StaticSourceInput, type StaticSourceProgress } from '../scripts/static-source-readings.ts';
import { STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS, STATIC_WEAK_ANCHOR_INSTRUCTIONS, staticWeakAnchor } from '../scripts/batteries/static-weak-anchor.ts';
import { STATIC_ANCHOR_FIT_INSTRUCTIONS, STATIC_ANCHOR_INSTRUCTIONS } from '../scripts/batteries/static-source.ts';
import { createStaticCallRecorder } from '../scripts/static-source-call-recording.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const input = () => captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const value = 3;', [{ id: 'candidate', line: 1, col: 7, text: 'value' }])[0]!;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function readCapturedInput(port: JudgmentPort, input: StaticSourceInput, signal?: AbortSignal, progress?: StaticSourceProgress) {
  const recorded = createStaticCallRecorder(port);
  return readStaticInput(recorded.port, recorded.capture, input, signal, progress);
}

async function selected(presence: number, pick: 'candidate' | 'none', confidence: number, fit: number) {
  const captured = input();

  const fixture = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, pick, confidence) : noulAnswer(name === 'violation' ? presence : fit));
  const receipt = await readCapturedInput(fixture.port, captured);
  return { captured, receipt, readings: { format: 2, readings: { [staticInputKey(captured)]: receipt } } satisfies StaticSourceReadings };
}

test('weak presence clears with every exact negative fit unless a settled candidate identity contradicts it', async () => {
  for (const presence of [0.2, 0.5, 0.8]) {
    const { captured, receipt, readings } = await selected(presence, 'none', 0.99, 0.01);
    expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
    expect(receipt.presence.answers).toEqual({ violation: noulAnswer(presence) });
    expect(receipt.selection?.battery).toBe(staticWeakAnchor.name);
    expect(receipt.readingPlanVersion).toBe(3);
    expect(staticInputCaptureComplete(captured, readings)).toBe(true);
  }
  for (const fit of [0.2, 0.5, 0.8, 0.99]) {
    const { captured, readings } = await selected(0.5, 'none', 0.99, fit);
    expect(staticInputStanding(captured, readings).kind).toBe('held');
    expect(staticInputCaptureComplete(captured, readings)).toBe(true);
  }
  const uncertain = await selected(0.5, 'none', 0.8, 0.01);
  expect(staticInputStanding(uncertain.captured, uncertain.readings).kind).toBe('clear');
  const uncertainCandidate = await selected(0.5, 'candidate', 0.8, 0.01);
  expect(staticInputStanding(uncertainCandidate.captured, uncertainCandidate.readings).kind).toBe('clear');
});

test('new positive identity and fit must both settle and cannot clear a strong contradiction', async () => {
  const positive = await selected(0.5, 'candidate', 0.99, 0.99);
  expect(staticInputStanding(positive.captured, positive.readings)).toEqual({ kind: 'violation', anchor: positive.captured.anchors[0]! });
  for (const [confidence, fit] of [[0.8, 0.99], [0.99, 0.8], [0.99, 0.5], [0.99, 0.01]]) {
    const { captured, readings } = await selected(0.5, 'candidate', confidence!, fit!);
    expect(staticInputStanding(captured, readings).kind).toBe('held');
  }
  const contradiction = await selected(0.99, 'none', 0.99, 0.01);
  expect(staticInputStanding(contradiction.captured, contradiction.readings).kind).toBe('held');
  expect(contradiction.receipt.selection?.battery).toBe('engine.gates.static-offending-anchor');
});

test('current and historical selector receipts keep their own exact raw state/question pairs', async () => {
  const { captured, receipt, readings } = await selected(0.5, 'none', 0.99, 0.01);
  const selection = receipt.selection;
  if (!selection) throw new Error('Missing complete selector');
  const state = toJson({ context: staticSelectionContext(captured), candidates: staticSelectionCandidates(captured) });
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Missing exact selector state object');
  const questions = { pick: choice(STATIC_WEAK_ANCHOR_INSTRUCTIONS, { candidate: null, none: 'None of the candidates does what is needed.' }),
    fits_0: noul({ question: STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS, candidate: '`candidates[0]` (id "candidate")' }) };
  const standing = (wire: { state: EntryType; questions: Questions }) => staticInputStanding(captured,
    { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: { ...selection, ...wire } } } });
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
  expect(standing({ state, questions })).toEqual({ kind: 'clear' });
  expect(standing({ state, questions: selection.questions }).kind).toBe('held');
  expect(standing({ state: selection.state, questions }).kind).toBe('held');
});

test('both exact selector wire variants compare raw snapshots without any hashing', async () => {
  const hashing = spyOn(crypto, 'createHash'), nativeHashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    const { captured, receipt, readings } = await selected(0.5, 'none', 0.99, 0.01);
    const legacy = { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: { ...receipt.selection!,
      state: toJson({ context: staticSelectionContext(captured), candidates: staticSelectionCandidates(captured) }),
      questions: { pick: choice(STATIC_WEAK_ANCHOR_INSTRUCTIONS, { candidate: null, none: 'None of the candidates does what is needed.' }),
        fits_0: noul({ question: STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS, candidate: '`candidates[0]` (id "candidate")' }) } } } } };
    expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
    expect(staticInputStanding(captured, legacy)).toEqual({ kind: 'clear' });
    expect(hashing).not.toHaveBeenCalled(); expect(nativeHashing).not.toHaveBeenCalled();
  } finally { hashing.mockRestore(); nativeHashing.mockRestore(); }
});

test('weak exhaustive negative fits keep the original high band and every contradictory or absent fit holds', async () => {
  for (const pick of ['candidate', 'none'] as const) {
    const negative = await selected(.5, pick, .2, .15);
    expect(staticInputStanding(negative.captured, negative.readings).kind).toBe('clear');
    for (const fit of [.150001, .5, .99]) {
      const unknown = await selected(.5, pick, .2, fit);
      expect(staticInputStanding(unknown.captured, unknown.readings).kind).toBe('held');
    }
  }
  const contradictory = await selected(.5, 'candidate', .99, .01);
  expect(staticInputStanding(contradictory.captured, contradictory.readings).kind).toBe('held');
  const strong = await selected(.99, 'none', .2, .01);
  expect(staticInputStanding(strong.captured, strong.readings).kind).toBe('held');
  expect(strong.receipt.selection?.battery).toBe('engine.gates.static-offending-anchor');
  const source = await selected(.5, 'none', .2, .01);
  const selection = source.receipt.selection;
  if (!selection) throw new Error('Missing complete selector');
  const missing = { ...source.readings, readings: { [staticInputKey(source.captured)]: { ...source.receipt,
    selection: { ...selection, answers: { pick: object(selection.answers) ? selection.answers.pick : undefined } } } } };
  expect(staticInputStanding(source.captured, missing).kind).toBe('held');
  expect(staticInputCaptureComplete(source.captured, missing)).toBe(false);
});

test('a settled weak negative sibling cannot clear another unresolved exact source subset', async () => {
  const captured = captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const first = 1;\nconst second = 2;')[0]!;

  const fixture = fakePort((name, question, state) => {
    if (question.type === 'choice') return choiceAnswer(question, 'none', .2);
    if (name === 'violation') return noulAnswer(.5);
    if (!object(state) || !Array.isArray(state.candidates) || !object(state.candidates[0])) throw new Error('Missing exact candidate state');
    return noulAnswer(state.candidates[0].id === captured.anchors[0]?.id ? .01 : .5);
  });
  const receipt = await readCapturedInput(fixture.port, captured);
  const readings = { format: 2 as const, readings: { [staticInputKey(captured)]: receipt } };
  expect(receipt.parts).toHaveLength(2);
  expect(staticInputCaptureComplete(captured, readings)).toBe(true);
  expect(staticInputStanding(captured, readings).kind).toBe('held');
  const first = { ...captured, anchors: captured.anchors.slice(0, 1) };
  expect(staticInputStanding(first, { ...readings, readings: { [staticInputKey(first)]: receipt.parts[0] } }).kind).toBe('clear');
});

test('original plan-2 raw answers revalidate without changing their state, questions or probabilities', async () => {
  const captured = input(), fixture = await selected(.5, 'none', .2, .01);
  const original = { ...fixture.receipt, readingPlanVersion: 2 as const };
  const old = { format: 2 as const, readingPlanVersion: 2 as const, readings: { [staticInputKey(captured)]: original } };
  const originalBytes = JSON.stringify(original), revalidated = revalidateStaticInput(captured, old);
  expect(revalidated).toEqual(original);
  const current = { ...old, readingPlanVersion: 3 as const, readings: { [staticInputKey(captured)]: revalidated } };
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  expect(staticInputStanding(captured, current).kind).toBe('clear');
  const forbidden = fakePort(() => { throw new Error('Unchanged exact evidence cannot be resampled'); });
  const receipt = await readCapturedInput(forbidden.port, captured, undefined, { previous: current, onReceipt() {} });
  expect(forbidden.requests).toHaveLength(0);
  expect(receipt.presence).toEqual(original.presence);
  expect(receipt.selection).toEqual(original.selection);
  expect(JSON.stringify(original)).toBe(originalBytes);
});

test('a retained exact weak presence receives only its missing selector once', async () => {
  const captured = input(), authored = await preparedStaticReadings([captured], 0.5);
  const raw = authored.readings[staticInputKey(captured)];
  if (!object(raw) || !object(raw.presence)) throw new Error('Missing authored raw presence');
  const original = { ...raw, readingPlanVersion: 1, selection: null };
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: original };
  const current = { ...authored, readings };
  expect(revalidateStaticInput(captured, current)).not.toBeNull();
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const fixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.01));
  const progress = { previous: current, onReceipt(source: typeof captured, value: Awaited<ReturnType<typeof readStaticInput>>) {
    readings[staticInputKey(source)] = value;
  } };
  const receipt = await readCapturedInput(fixture.port, captured, undefined, progress);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.questions).toHaveProperty('pick');
  expect(fixture.requests[0]?.questions).not.toHaveProperty('violation');
  expect<unknown>(receipt.presence).toEqual(raw.presence);
  expect(staticInputStanding(captured, current)).toEqual({ kind: 'clear' });
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  const repeated = fakePort(() => { throw new Error('An answered identity must not be resampled'); });
  await readCapturedInput(repeated.port, captured, undefined, progress);
  expect(repeated.requests).toHaveLength(0);
});

test('interrupted new selector resumes once and preserves an answered weak selector forever', async () => {
  const captured = input();
  const authored = await preparedStaticReadings([captured], 0.5);
  const raw = authored.readings[staticInputKey(captured)];
  if (!object(raw)) throw new Error('Missing authored presence');
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: { ...raw, readingPlanVersion: 1, selection: null } };
  const current = { ...authored, readings };
  const progress = { previous: current, onReceipt(source: typeof captured, value: Awaited<ReturnType<typeof readStaticInput>>) { readings[staticInputKey(source)] = value; } };

  const interruption = fakePort(() => { throw new JudgmentError('internal', 'The decision client failed internally. The operation has stopped.'); });
  await expect(readCapturedInput(interruption.port, captured, undefined, progress)).rejects.toMatchObject({ kind: 'internal', message: 'The decision client failed internally. The operation has stopped.' });
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  const resumed = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.8) : noulAnswer(0.5));
  const receipt = await readCapturedInput(resumed.port, captured, undefined, progress);
  expect(resumed.requests).toHaveLength(1);
  expect<unknown>(receipt.presence).toEqual(raw.presence);
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const forbidden = fakePort(() => { throw new Error('Answered uncertain selector cannot be repeated'); });
  await readCapturedInput(forbidden.port, captured, undefined, progress);
  expect(forbidden.requests).toHaveLength(0);
  expect(resumed.requests).toHaveLength(1);
  expect(interruption.requests).toHaveLength(1);
});

test('weak selector raw input, state, questions and full answer identity must remain exact', async () => {
  const { captured, receipt, readings } = await selected(0.5, 'none', 0.99, 0.01);
  const selector = receipt.selection;
  if (!selector) throw new Error('Missing selector unit fixture');
  for (const marker of [undefined, 1, 2, 3] as const) {
    const sameWire = { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, readingPlanVersion: marker } } };
    expect(staticInputStanding(captured, sameWire)).toEqual({ kind: 'clear' });
  }
  const invalidPlan = { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, readingPlanVersion: 99 } } };
  expect(staticInputStanding(captured, invalidPlan).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, invalidPlan)).toBe(false);
  expect(parseStaticSourceReadings({ ...readings, readingPlanVersion: 99 })).toBeNull();
  for (const [field, value] of [['observedModel', 'other'], ['requestedModel', 'other-model'], ['questions', { changed: true }],
    ['site', 'wrong'], ['state', { changed: true }], ['version', 1]]) {
    expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt,
      selection: { ...selector, [String(field)]: value } } } }).kind).toBe('held');
  }
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: {
    ...receipt, input: { ...captured, source: 'Different transmitted source.' } } } }).kind).toBe('held');
  for (const answers of [{ pick: { type: 'choice', choice: 'none', confidence: 0.99, probabilities: { candidate: 0.01, none: 0.99 } } },
    { pick: { type: 'choice', choice: 'none', confidence: 0.99, probabilities: { candidate: 0, none: 0.989999 } }, fits_0: noulAnswer(0.01) },
    { pick: { type: 'choice', choice: 'none', confidence: 0.99, probabilities: { candidate: 0.01, none: 0.99, extra: 0 } }, fits_0: noulAnswer(0.01) }]) {
    const malformed = { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: { ...selector, answers } } } };
    expect(staticInputStanding(captured, malformed).kind).toBe('held');
    expect(staticInputCaptureComplete(captured, malformed)).toBe(false);
  }
});

test('weak v2 source-only questions leave original strong selector questions unchanged', async () => {
  for (const presence of [0.5, 0.99]) {
    const captured = input();

    const fixture = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(name === 'violation' ? presence : 0.01));
    const receipt = await readCapturedInput(fixture.port, captured);
    const questions = fixture.requests[1]?.questions;
    if (!questions) throw new Error('Missing exact selector questions');
    expect(questions.pick).toEqual(choice(presence === 0.5 ? STATIC_WEAK_ANCHOR_INSTRUCTIONS : STATIC_ANCHOR_INSTRUCTIONS, { candidate: null, none: 'None of the candidates does what is needed.' }));
    expect(questions.fits_0).toEqual(noul({ question: 'Apply the complete selectionFitInstructions in state to this exact candidate.', candidate: '`candidates[0]` (id "candidate")' }));
    expect(fixture.requests[1]?.state).toHaveProperty('selectionFitInstructions', presence === 0.5 ? STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS : STATIC_ANCHOR_FIT_INSTRUCTIONS);
    expect(receipt.selection?.version).toBe(2);
    expect(receipt.selection?.questions).toEqual(questions);
    expect(receipt.selection?.state).toEqual(fixture.requests[1]?.state);
  }
});

test('v1 selector raw answers remain history while only genuinely new v2 questions are measured once', async () => {
  const captured = input(), authored = await selected(0.5, 'none', 0.8, 0.5);
  const legacy = defineSelector({ name: staticWeakAnchor.name, version: 1, model: DEFAULT_MODEL, accuracyFloor: 0.95,
    description: 'Authored synthetic historical v1 unit fixture', instructions: STATIC_ANCHOR_INSTRUCTIONS,
    fitInstructions: STATIC_ANCHOR_FIT_INSTRUCTIONS, band: STAKES_BANDS.high.confidence, fitBand: STAKES_BANDS.high.yesNo,
    fixtures: [{ name: 'authored historical example', context: staticSelectionContext(captured), candidates: staticSelectionCandidates(captured), expect: 'none' }] });
  const fixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.8) : noulAnswer(0.5));
  const recorded = createStaticCallRecorder(fixture.port);
  const run = await legacy.select(recorded.port, staticSelectionContext(captured), staticSelectionCandidates(captured), { site: `${STATIC_SITE}.${captured.kind}` });
  const rawSelection = run.decisionId ? recorded.capture.get(run.decisionId) : undefined;
  if (!rawSelection) throw new Error('Missing authored raw v1 call');
  const originalRequest = fixture.requests[0];
  if (!originalRequest) throw new Error('Missing original historical selector request');
  expect(rawSelection.state).toEqual(originalRequest.state);
  expect(rawSelection.questions).toEqual(originalRequest.questions);
  const original = { ...authored.receipt, selection: rawSelection }, originalBytes = JSON.stringify(original);
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: original };
  const current = { format: 2, readings } satisfies StaticSourceReadings;
  expect(staticInputStanding(captured, current).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  const replacement = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.8) : noulAnswer(0.5));
  const progress = { previous: current, onReceipt(source: typeof captured, receipt: Awaited<ReturnType<typeof readStaticInput>>) { readings[staticInputKey(source)] = receipt; } };
  const updated = await readCapturedInput(replacement.port, captured, undefined, progress);
  expect(replacement.requests).toHaveLength(1);
  expect(replacement.requests[0]?.questions).not.toEqual(fixture.requests[0]?.questions);
  expect(updated.selection?.version).toBe(2);
  expect<unknown>(updated.presence).toEqual(original.presence);
  expect(updated.previousCaptures).toEqual([original]);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  const forbidden = fakePort(() => { throw new Error('Unchanged weak answers cannot be resampled'); });
  await readCapturedInput(forbidden.port, captured, undefined, progress);
  expect(forbidden.requests).toHaveLength(0);
  expect(JSON.stringify(original)).toBe(originalBytes);
});
