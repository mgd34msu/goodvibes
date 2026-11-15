import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { modelReasonTheme } from '@goodvibes-jev/engine/platform/platform/routing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { formatComparisonSynthesis, parseJudgmentArtifactPayload } from '../../tools/agent-model-compare-judgment.ts';
import { forgetComparisonReasonThemes, readComparisonReasonThemes, type JudgmentWithThemes } from '../../tools/agent-model-compare-themes.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); forgetComparisonReasonThemes(); });
afterEach(async () => { installJudgmentPort(previous); await cleanupResearchScreeningFixtures(); });

function judgment(id = 'judgment-a', reasons = 'The losing response claimed clear and fast; I did not prefer those qualities.'): JudgmentWithThemes {
  return { artifact: { artifactId: id, mimeType: 'application/json', sizeBytes: 1 },
    judgmentId: `synthetic-${id}`, comparisonId: 'synthetic-comparison', winnerBlindId: 'B', sourceArtifactId: 'comparison-a',
    reasons, notes: '', revealIncludedInJudgment: false };
}
function synthesis(judgments: readonly JudgmentWithThemes[], readingOptions: Parameters<typeof formatComparisonSynthesis>[0]['readingOptions'], includeReasons = true) {
  return formatComparisonSynthesis({ judgments, limit: 20, includeReasons, filters: {}, storeAvailable: true, readingOptions });
}
function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}

test('the reading sees only the reasons, notes and chosen label, and records its action', async () => {
  const fake = fakePort(name => noulAnswer(name === 'faithfulness' ? 0.999 : 0.001));
  using log = new SqliteDecisionLog(':memory:');
  installJudgmentPort(withDecisionLog(fake.port, log));
  const reading = await readComparisonReasonThemes(judgment(), { sourceOwner: ordinaryResearchOwner() });
  expect(reading.status).toBe('settled');
  if (reading.status !== 'settled') throw new Error('Synthetic theme read was held');
  expect(reading.themes).toEqual(['faithfulness']);
  expect(reading.stored).toMatchObject({ battery: modelReasonTheme.name, version: modelReasonTheme.version, model: 'jev-1.13.0' });
  expect(fake.requests).toHaveLength(1);
  expect(Object.keys(fake.requests[0]!.questions)).toEqual(['actionable', 'clarity', 'faithfulness', 'context', 'safety', 'efficiency']);
  expect(fake.requests[0]!.state).toEqual({ judgment: { winner: 'B', reasons: judgment().reasons, notes: '' } });
  expect(JSON.stringify(log.query())).toContain('classified preference themes: faithfulness');
});

test('two syntheses over the same judgments read each once; stored themes are never read', async () => {
  const fake = fakePort(name => noulAnswer(name === 'clarity' ? 0.999 : 0.001));
  installJudgmentPort(fake.port);
  const judgments = Array.from({ length: 10 }, (_, index) => judgment(`judgment-${index}`, `Reason ${index}: B was easier to follow.`));
  const options = { sourceOwner: ordinaryResearchOwner() };
  expect(await synthesis(judgments, options)).toContain('Clear/scannable communication: 10 judgments');
  expect(fake.requests).toHaveLength(10);
  expect(await synthesis(judgments, options)).toContain('Clear/scannable communication: 10 judgments');
  expect(fake.requests).toHaveLength(10);
  const stored = { ...judgment('stored'), reasonThemes: { battery: modelReasonTheme.name, version: modelReasonTheme.version, themes: ['safety' as const], model: 'jev-1.13.0' } };
  expect(await synthesis([stored], options)).toContain('Safety and risk handling: 1 judgment');
  expect(fake.requests).toHaveLength(10);
});

test('themes read when a judgment is saved are parsed back from its artifact', () => {
  const reasonThemes = { battery: modelReasonTheme.name, version: modelReasonTheme.version, themes: ['context'], model: 'jev-1.13.0', decisionId: 'd-1' };
  const loaded = parseJudgmentArtifactPayload({ schema: 'goodvibes.agent.model_compare_judgment.v1', judgmentId: 'j', comparisonId: 'c',
    winnerBlindId: 'A', reasons: 'r', notes: '', reasonThemes }, { artifactId: 'a', mimeType: 'application/json', sizeBytes: 1 });
  expect(loaded?.reasonThemes).toEqual(reasonThemes as never);
  const malformed = parseJudgmentArtifactPayload({ schema: 'goodvibes.agent.model_compare_judgment.v1', reasonThemes: { ...reasonThemes, themes: ['made-up'] } },
    { artifactId: 'a', mimeType: 'application/json', sizeBytes: 1 });
  expect(malformed?.reasonThemes).toBeUndefined();
});

test('unsettled readings stay unresolved, and the synthesis says why', async () => {
  const fake = fakePort(() => noulAnswer(0.5));
  using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
  const report = await synthesis([judgment()], { sourceOwner: ordinaryResearchOwner() });
  expect(report).toContain('Unresolved preference signal: 1 judgment');
  expect(report).toContain('not classified (1): the decision model was unsure whether the reasons state');
  expect(report).not.toContain('Uncategorized preference signal');
  expect(report).toContain('No selected model was changed.');
  expect(JSON.stringify(log.query())).toContain('held preference theme classification');
});

test('only six settled negative readings produce the uncategorized bucket', async () => {
  installJudgmentPort(fakePort(() => noulAnswer(0.001)).port);
  const report = await synthesis([judgment()], { sourceOwner: ordinaryResearchOwner() }, false);
  expect(report).toContain('Uncategorized preference signal: 1 judgment');
  expect(report).not.toContain('Unresolved preference signal');
});

test('missing source screening makes zero theme requests and says so', async () => {
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const reading = await readComparisonReasonThemes(judgment(), {});
  expect(reading).toMatchObject({ status: 'held', reason: expect.stringContaining('no source screening') });
  expect(fake.requests).toHaveLength(0);
});

test('sensitive text in the reasons cannot enter the theme request', async () => {
  const secret = 'synthetic-sensitive-marker';
  const privacy = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  expect(await readComparisonReasonThemes(judgment('judgment-a', `B was clear. ${secret}`), { sourceOwner: privacy.owner })).toMatchObject({ status: 'held' });
  expect(fake.requests).toHaveLength(0);
  expect(JSON.stringify(privacy.calls)).toContain(secret);
});

test('cancelled privacy screening makes zero theme requests', async () => {
  const pending = suspended(), controller = new AbortController();
  const privacy = researchScreeningFixture({ beforeProposal: async () => { pending.start(); await pending.gate; } });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const reading = readComparisonReasonThemes(judgment(), { sourceOwner: privacy.owner, signal: controller.signal });
  const outcome = reading.then(value => ({ value }), error => ({ error: error as unknown }));
  await pending.started; controller.abort(); pending.release();
  expect(await outcome).toHaveProperty('error');
  expect(fake.requests).toHaveLength(0);
});

test('the caller\'s freshness check survives asynchronous screening', async () => {
  const pending = suspended(); let current = true;
  const privacy = researchScreeningFixture({ beforeProposal: async () => { pending.start(); await pending.gate; } });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const reading = readComparisonReasonThemes(judgment(), { sourceOwner: privacy.owner,
    assertCurrent: () => { if (!current) throw new Error('Synthetic source revision expired'); } });
  const outcome = reading.then(value => ({ value }), error => ({ error: error as unknown }));
  await pending.started; current = false; pending.release();
  const result = await outcome;
  expect('error' in result && result.error instanceof Error ? result.error.message : null).toBe('Synthetic source revision expired');
  expect(fake.requests).toHaveLength(0);
});

test('replacing the installed port while an answer is pending holds the reading', async () => {
  const pending = suspended(), fake = fakePort(() => noulAnswer(0.999));
  const delayed: JudgmentPort = { ...fake.port, async ask(request) { pending.start(); await pending.gate; return fake.port.ask(request); } };
  installJudgmentPort(delayed);
  const reading = readComparisonReasonThemes(judgment(), { sourceOwner: ordinaryResearchOwner() });
  await pending.started; installJudgmentPort(fakePort(() => noulAnswer(0.001)).port); pending.release();
  expect(await reading).toMatchObject({ status: 'held' });
});

test('a response carrying private unknown fields is refused before classification', async () => {
  const fake = fakePort(() => noulAnswer(0.999));
  installJudgmentPort({ ...fake.port, async ask(request) {
    return { ...await fake.port.ask(request), unrecognizedOriginal: { apiKey: 'synthetic-response-private-marker' } };
  } });
  expect(await readComparisonReasonThemes(judgment(), { sourceOwner: ordinaryResearchOwner() })).toMatchObject({ status: 'held' });
  expect(fake.requests).toHaveLength(1);
});

test('a newer Jev release answers; an unrelated model cannot', async () => {
  const fake = fakePort(() => noulAnswer(0.999));
  installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: 'jev-9.99.0' }; } });
  expect(await readComparisonReasonThemes(judgment(), { sourceOwner: ordinaryResearchOwner() }))
    .toMatchObject({ status: 'settled', stored: { model: 'jev-9.99.0' } });
  installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: 'unrelated-model' }; } });
  expect(await readComparisonReasonThemes(judgment('judgment-b'), { sourceOwner: ordinaryResearchOwner() })).toMatchObject({ status: 'held' });
});

test('Classic keeps saved winner analytics without asking anything', async () => {
  let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new Error('must not ask'); } });
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect(await readComparisonReasonThemes(judgment(), {})).toEqual({ status: 'not-evaluated', provenance: 'classic' });
    const text = await synthesis([judgment()], {});
    expect(text).toContain('judgments 1; revealed 0; hidden 1; compared comparisons 1');
    expect(text).toContain('Unassessed preference themes (Classic): 1 judgment');
    expect(text).not.toContain('Unresolved preference signal');
    expect(asks).toBe(0);
  });
});

test('an unavailable decision model switches the synthesis to Classic', async () => {
  let asks = 0;
  installJudgmentPort({ model: 'fixture', async ask() { asks++; throw new JudgmentError('unavailable', 'fixture exhausted'); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const text = await synthesis([judgment(), judgment('judgment-b'), judgment('judgment-c', 'B was easier to follow.')], { sourceOwner: ordinaryResearchOwner() });
    expect(text).toContain('Unassessed preference themes (Classic): 3 judgments');
    expect(asks).toBeLessThanOrEqual(2);
    expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) test(`a ${kind} reading is held with its cause rather than activating Classic`, async () => {
  installJudgmentPort({ model: 'fixture', async ask() { throw new JudgmentError(kind, 'fixture failure'); } });
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect(await readComparisonReasonThemes(judgment(), { sourceOwner: ordinaryResearchOwner() })).toMatchObject({ status: 'held', reason: expect.any(String) });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic still honours cancellation and synchronous ownership', async () => {
  const abort = new AbortController(); abort.abort();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(readComparisonReasonThemes(judgment(), { signal: abort.signal })).rejects.toThrow();
    await expect(readComparisonReasonThemes(judgment(), { assertCurrent: () => Promise.resolve() })).rejects.toThrow();
    await expect(readComparisonReasonThemes(judgment(), { assertCurrent() { throw new Error('native owner retired'); } })).rejects.toThrow();
  });
});
