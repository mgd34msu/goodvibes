
import { describe, expect, test } from 'bun:test';
import { MultimodalService } from '../platform/src/platform/multimodal/service.js';

interface StubProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly configured: boolean;
  readonly metadata: Record<string, unknown>;
}

function makeService(media: readonly StubProvider[] = [], voice: readonly StubProvider[] = []): MultimodalService {
  return new MultimodalService(
    {} as never,
    { status: async () => media } as never,
    { getStatus: async () => ({ providers: voice }) } as never,
    {} as never,
  );
}

describe('platform/multimodal: provider listing', () => {
  test('with no media or voice providers only the built-in extractor is listed', async () => {
    const providers = await makeService().listProviders();
    expect(providers).toEqual([
      {
        id: 'knowledge-extractors',
        label: 'Built-in Knowledge Extractors',
        transport: 'extractor',
        capabilities: ['document.extract', 'video.keyframe-fusion'],
        configured: true,
        metadata: {},
      },
    ]);
  });

  test('media providers that understand, and voice providers that transcribe, are mapped by capability and sorted by label', async () => {
    const service = makeService(
      [
        { id: 'vision', label: 'Vision', capabilities: ['understand', 'generate'], configured: true, metadata: { region: 'eu' } },
        { id: 'painter', label: 'Painter', capabilities: ['generate'], configured: true, metadata: {} },
      ],
      [
        { id: 'live', label: 'Live Voice', capabilities: ['stt', 'realtime'], configured: false, metadata: {} },
        { id: 'batch', label: 'Batch Voice', capabilities: ['stt'], configured: true, metadata: {} },
        { id: 'speaker', label: 'Speaker', capabilities: ['tts'], configured: true, metadata: {} },
      ],
    );
    const providers = await service.listProviders();
    expect(providers.map((p) => [p.id, p.transport, p.capabilities, p.configured])).toEqual([
      ['batch', 'voice', ['audio.transcribe'], true],
      ['knowledge-extractors', 'extractor', ['document.extract', 'video.keyframe-fusion'], true],
      ['live', 'hybrid', ['audio.transcribe', 'audio.realtime'], false],
      ['vision', 'media', ['image.describe'], true],
    ]);
    expect(providers.find((p) => p.id === 'vision')?.metadata).toEqual({ region: 'eu' });
  });

  test('getStatus reports the listed providers and how many there are', async () => {
    const status = await makeService(
      [{ id: 'vision', label: 'Vision', capabilities: ['understand'], configured: true, metadata: {} }],
    ).getStatus();
    expect(status.enabled).toBe(true);
    expect(status.providerCount).toBe(2);
    expect(status.providers.map((p) => p.id).sort()).toEqual(['knowledge-extractors', 'vision']);
  });
});

import { afterEach, spyOn } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { assessMultimodalEntities } from '../platform/src/platform/multimodal/entity-centrality.js';
import { multimodalFixture, termChoice } from './_helpers/multimodal-entities.js';

let previousPort: ReturnType<typeof installJudgmentPort>;
let installed = false;
function usePort(port: Parameters<typeof installJudgmentPort>[0]) {
  if (!installed) { previousPort = installJudgmentPort(port); installed = true; }
  else installJudgmentPort(port);
}
afterEach(() => { if (installed) installJudgmentPort(previousPort); installed = false; });
const centralPort = () => fakePort(termChoice({ AI: 0.6, EU: 0.3, receipt: 0.1 }));
/** Entity requests only; a document's extraction also asks one readability question. */
const entityRequests = (requests: readonly { readonly state?: unknown }[]) => requests.filter(request => Array.isArray((request.state as { candidates?: unknown } | undefined)?.candidates)).length;

for (const kind of ['image', 'audio', 'document', 'video'] as const) {
  test(`${kind}: entities asked for cost one decision-model request and reach the packet and write-back`, async () => {
    const fake = centralPort(); usePort(fake.port);
    const fixture = multimodalFixture(kind);
    if (kind === 'video') fixture.add('transcript', 'document');
    const result = await fixture.service.analyze({ artifactId: 'source', detail: 'detailed', ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}) });
    expect(result.entities).toEqual(['AI', 'EU']);
    expect(entityRequests(fake.requests)).toBe(1);
    expect(fixture.service.buildPacket(result).rendered).toContain('Entities: AI, EU');
    await fixture.service.writeBackAnalysis(JSON.parse(JSON.stringify(result)) as typeof result, { metadata: { sourceArtifactId: 'forged' } });
    expect(entityRequests(fake.requests)).toBe(1);
    expect(fixture.ingests[0]).toMatchObject({ tags: expect.arrayContaining(['AI', 'EU']), metadata: { sourceArtifactId: 'source' } });
  });
}

test('decision-model requests for an analysis that does not ask for entities: 0; its write-back asks once', async () => {
  const fake = centralPort(); usePort(fake.port);
  const fixture = multimodalFixture('image', Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ') + ' AI EU');
  const result = await fixture.service.analyze({ artifactId: 'source' });
  expect(fake.requests).toHaveLength(0);
  expect(result.entities).toEqual([]);
  expect(result.metadata).toMatchObject({ entityAssessment: 'not-evaluated', entityAssessmentSkipped: 'not-requested' });
  await fixture.service.writeBackAnalysis(result);
  expect(fake.requests).toHaveLength(1);
  expect(fixture.ingests[0]).toMatchObject({ tags: expect.arrayContaining(['AI', 'EU']) });
});

for (const [name, answer] of [['malformed', noulAnswer(Number.NaN)], ['wrong answer type', { type: 'text', text: 'AI' }]] as const) {
  test(`a ${name} entity reading leaves the analysis whole, with entities not assessed`, async () => {
    usePort(fakePort(() => answer).port);
    const fixture = multimodalFixture();
    const result = await fixture.service.analyze({ artifactId: 'source', detail: 'detailed' });
    expect(result.text).toContain('AI');
    expect(result.entities).toEqual([]);
    expect(result.metadata).toMatchObject({ entityAssessment: 'not-evaluated', entityAssessmentSkipped: 'unavailable' });
  });
}

test('no decision model leaves the analysis whole, with entities not assessed', async () => {
  usePort(undefined);
  const result = await multimodalFixture().service.analyze({ artifactId: 'source', detail: 'detailed' });
  expect(result.entities).toEqual([]); expect(result.metadata.entityAssessment).toBe('not-evaluated');
});

test('full image, audio, document and video text is screened before clipping, budget or port lookup', async () => {
  const fake = centralPort(); usePort(fake.port);
  const text = `${'receipt '.repeat(600)}password=inline-credential`;
  for (const kind of ['image', 'audio', 'document', 'video'] as const) {
    const fixture = multimodalFixture(kind, text);
    if (kind === 'video') fixture.add('transcript', 'document', text);
    await expect(fixture.service.analyze({ artifactId: 'source', detail: 'detailed', ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}) })).rejects.toThrow('Refused before judgment');
    expect(fixture.writes).toHaveLength(0);
  }
  expect(fake.requests).toHaveLength(0);
});

test('a replaced artifact or a changed analysis is not written back', async () => {
  usePort(centralPort().port);
  for (const condition of ['artifact', 'changed'] as const) {
    const fixture = multimodalFixture();
    const result = await fixture.service.analyze({ artifactId: 'source' });
    if (condition === 'artifact') fixture.records.set('source', { ...fixture.records.get('source')!, sha256: 'replacement' });
    const offered = condition === 'changed' ? { ...result, entities: ['unauthorized'] } : result;
    await expect(fixture.service.writeBackAnalysis(offered)).rejects.toThrow();
    expect(fixture.writes).toHaveLength(0);
  }
});

test('an analysis this service does not hold is refused with the way forward', async () => {
  usePort(centralPort().port);
  const result = await multimodalFixture().service.analyze({ artifactId: 'source' });
  const restarted = multimodalFixture();
  const refused = await restarted.service.writeBackAnalysis(result).catch((error: unknown) => error) as { refusal?: { code: string; next: readonly string[] }; status?: number };
  expect(refused.refusal?.code).toBe('MULTIMODAL_ANALYSIS_NOT_HELD');
  expect(refused.refusal?.next[0]).toContain('writeback');
  expect(restarted.writes).toHaveLength(0);
  expect(restarted.service.buildPacket(result).rendered).toContain('## Multimodal Analysis');
});

test('cancelling the analysis stops a decision model that does not answer', async () => {
  const controller = new AbortController();
  const fixture = multimodalFixture();
  usePort({ model: 'jev-1.13.0', ask: async () => { controller.abort(); return await new Promise<never>(() => {}); } });
  await expect(fixture.service.analyze({ artifactId: 'source', detail: 'detailed' }, { signal: controller.signal })).rejects.toThrow();
  expect(fixture.writes).toHaveLength(0);
});

test('video write-back refuses when a keyframe it read is gone', async () => {
  usePort(centralPort().port);
  const fixture = multimodalFixture('video'); fixture.add('frame', 'image'); fixture.add('audio', 'audio');
  const result = await fixture.service.analyze({ artifactId: 'source', detail: 'detailed', metadata: { keyframeArtifactIds: ['frame'], audioArtifactId: 'audio' } });
  expect(result.entities).toEqual(['AI', 'EU']);
  fixture.records.delete('frame');
  await expect(fixture.service.writeBackAnalysis(result)).rejects.toThrow();
  expect(fixture.writes).toHaveLength(0);
});

test('Office admission reads late XML text and refuses expansion bombs before a judgment', async () => {
  const { readKnowledgeArtifactJudgmentSource } = await import('../platform/src/platform/knowledge/extractors.js');
  const { default: JSZip } = await import('jszip');
  const fake = centralPort(); usePort(fake.port);
  const descriptor = { id: 'office', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'source.xlsx' };
  const archive = new JSZip();
  archive.file('xl/worksheets/sheet99.xml', `<row>${'safe '.repeat(2_000)}password=late-credential</row>`);
  const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await expect(readKnowledgeArtifactJudgmentSource(descriptor, bytes)).rejects.toThrow('Refused before judgment');
  const bomb = new JSZip(); bomb.file('xl/sharedStrings.xml', 'safe '.repeat(200_000));
  await expect(readKnowledgeArtifactJudgmentSource(descriptor, await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))).rejects.toThrow('plain JSON');
  await expect(readKnowledgeArtifactJudgmentSource(descriptor, Buffer.from('invalid archive'))).rejects.toThrow('plain JSON');
  expect(fake.requests).toHaveLength(0);
});

test('a cancelled write-back request writes nothing', async () => {
  usePort(centralPort().port);
  const fixture = multimodalFixture();
  const result = await fixture.service.analyze({ artifactId: 'source' });
  const controller = new AbortController(); controller.abort();
  await expect(fixture.service.writeBackAnalysis(result, {}, { signal: controller.signal })).rejects.toThrow();
  expect(fixture.writes).toHaveLength(0);
});

test('provider-bound stored metadata is screened before the first image/audio call', async () => {
  usePort(centralPort().port);
  for (const kind of ['image', 'audio'] as const) {
    const fixture = multimodalFixture(kind);
    fixture.records.set('source', { ...fixture.records.get('source')!, metadata: { password: 'inline' } });
    const image = spyOn(fixture.mediaProviders, 'findProvider');
    const audio = spyOn(fixture.voiceService, 'transcribe');
    await expect(fixture.service.analyze({ artifactId: 'source' })).rejects.toThrow('Refused before judgment');
    expect(image).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled();
  }
});

test('missing and over-budget video sources hold instead of dropping evidence', async () => {
  usePort(centralPort().port);
  const fixture = multimodalFixture('video');
  for (const metadata of [{ keyframeArtifactIds: ['missing'] }, { audioArtifactId: 'missing' }, { transcriptArtifactId: 'missing' },
    { keyframeArtifactIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }]) {
    await expect(fixture.service.analyze({ artifactId: 'source', metadata })).rejects.toThrow('held');
  }
});

test('Office entity corpus includes unsampled sheets and slides as decoded source terms', async () => {
  const { readKnowledgeArtifactJudgmentSource } = await import('../platform/src/platform/knowledge/extractors.js');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet4.xml', '<worksheet><row><c><t>&#65;&#73;</t></c></row></worksheet>');
  zip.file('ppt/slides/slide13.xml', '<slide><t>EU</t></slide>');
  const source = await readKnowledgeArtifactJudgmentSource({ id: 'office', filename: 'source.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, await zip.generateAsync({ type: 'nodebuffer' }));
  expect(source).toContain('AI'); expect(source).toContain('EU'); expect(source).not.toContain('worksheet');
  usePort(centralPort().port);
  const assessed = await assessMultimodalEntities(source, 10);
  expect(assessed.entities).toEqual(['AI', 'EU']);
});
