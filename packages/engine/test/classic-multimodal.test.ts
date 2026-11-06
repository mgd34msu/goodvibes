import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { multimodalFixture } from './_helpers/multimodal-entities.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function install(port: JudgmentPort | undefined) { previous = installJudgmentPort(port); installed = true; }

for (const kind of ['image', 'audio', 'document', 'video'] as const) {
  test.each(['Classic - Off', 'Preferred'] as const)(`%s ${kind} retains processed media and explicit unassessed provenance through packet and writeback`, async policy => {
    const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
    const f = multimodalFixture(kind);
    if (kind === 'video') f.add('transcript', 'document');
    await withDecisionModelPolicy(() => policy, async () => {
      const result = await f.service.analyze({ artifactId: 'source', ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}) });
      expect(result.entities).toEqual([]);
      expect(result.metadata).toMatchObject({ provenance: 'classic', entityAssessment: 'not-evaluated' });
      expect(result.text ?? result.summary ?? result.segments.map(segment => segment.text).join(' ')).toContain('AI');
      expect(f.service.buildPacket(result).rendered).toContain('semantic entity assessment was not performed');
      expect(f.writes).toEqual([]); expect(f.ingests).toEqual([]);
      const attempted = fake.requests.length;
      expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
      expect(f.providerCalls).toEqual({ image: kind === 'image' ? 1 : 0, audio: kind === 'audio' ? 1 : 0 });
      const written = await f.service.writeBackAnalysis(JSON.parse(JSON.stringify(result)) as typeof result);
      expect(written.metadata).toMatchObject({ provenance: 'classic', entityAssessment: 'not-evaluated' });
      expect(f.ingests[0]).toMatchObject({ metadata: { provenance: 'classic', entityAssessment: 'not-evaluated', sourceArtifactId: 'source' } });
      expect(f.writes).toHaveLength(1); expect(f.ingests).toHaveLength(1);
      expect(fake.requests).toHaveLength(attempted);
      expect(f.providerCalls).toEqual({ image: kind === 'image' ? 1 : 0, audio: kind === 'audio' ? 1 : 0 });
    });
  });
}

test('Preferred missing decision runtime does not block ordinary media processing', async () => {
  install(undefined); const f = multimodalFixture();
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const result = await f.service.analyze({ artifactId: 'source' });
    expect(result.metadata.entityAssessment).toBe('not-evaluated');
    expect(decisionModelPolicyState().operation).toBe('classic'); expect(f.providerCalls.image).toBe(1);
  });
});

test('Classic does not inherit semantic candidate caps for an otherwise admitted source', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  const f = multimodalFixture('document', Array.from({ length: 180 }, (_, index) => `term${index}`).join(' '));
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const result = await f.service.analyze({ artifactId: 'source' });
    expect(result.entities).toEqual([]); expect(result.metadata.entityAssessment).toBe('not-evaluated');
    expect(result.text).toContain('term0'); expect(fake.requests).toHaveLength(0);
  });
});

for (const outcome of ['uncertain', 'malformed', 'rejected', 'invalid-response', 'aborted'] as const) {
  test(`Preferred ${outcome} entity reading remains held without replaying media processing`, async () => {
    const fake = fakePort(() => {
      if (outcome === 'uncertain') return noulAnswer(0.5);
      if (outcome === 'malformed') return { type: 'noul', noul: Number.NaN };
      throw new JudgmentError(outcome, 'Synthetic terminal failure');
    }); install(fake.port);
    const f = multimodalFixture();
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(f.service.analyze({ artifactId: 'source' })).rejects.toThrow();
      expect(decisionModelPolicyState().operation).toBe('decision'); expect(f.providerCalls.image).toBe(1);
      expect(f.writes).toEqual([]); expect(f.ingests).toEqual([]);
    });
  });
}

test('Classic retained analysis stays bound to the real artifact and cannot be forged into assessed entities', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = multimodalFixture();
    const result = await f.service.analyze({ artifactId: 'source' });
    const forged = { ...result, entities: ['invented'] };
    expect(() => f.service.buildPacket(forged)).toThrow();
    await expect(f.service.writeBackAnalysis(forged)).rejects.toThrow();
    f.records.set('source', { ...result.artifact, sha256: 'replaced' });
    expect(() => f.service.buildPacket(result)).toThrow();
    await expect(f.service.writeBackAnalysis(result)).rejects.toThrow();
    expect(f.writes).toEqual([]); expect(fake.requests).toHaveLength(0);
  });
});

test('Classic media cancellation and full-source privacy still hold before publication', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const controller = new AbortController(), f = multimodalFixture(); controller.abort();
    await expect(f.service.analyze({ artifactId: 'source' }, { signal: controller.signal })).rejects.toThrow();
    expect(f.providerCalls.image).toBe(0);
    const privateSource = multimodalFixture('image', 'AI '.repeat(800) + 'password=synthetic-private-secret');
    await expect(privateSource.service.analyze({ artifactId: 'source' })).rejects.toThrow();
    expect(privateSource.writes).toEqual([]); expect(fake.requests).toHaveLength(0);
  });
});
