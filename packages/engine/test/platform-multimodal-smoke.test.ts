
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
import { installJudgmentPort, captureJudgmentPort } from '../errors/src/index.js';
import { entityCentrality, rankMultimodalEntities } from '../platform/src/platform/multimodal/entity-centrality.js';
import { multimodalFixture } from './_helpers/multimodal-entities.js';

let previousPort: ReturnType<typeof installJudgmentPort>;
let installed = false;
function usePort(port: Parameters<typeof installJudgmentPort>[0]) {
  if (!installed) { previousPort = installJudgmentPort(port); installed = true; }
  else installJudgmentPort(port);
}
afterEach(() => { if (installed) installJudgmentPort(previousPort); installed = false; });
function centralPort() {
  return fakePort((_name, _question, state) => {
    const term = (state as { candidate: { term: string } }).candidate.term;
    return noulAnswer(term === 'AI' ? 0.99 : term === 'EU' ? 0.95 : 0.01);
  });
}

for (const kind of ['image', 'audio', 'document', 'video'] as const) {
  test(`${kind}: short central terms outrank repeated filler through analysis, packet, and explicit persistence`, async () => {
    const fake = centralPort(); usePort(fake.port);
    const fixture = multimodalFixture(kind);
    if (kind === 'video') fixture.add('transcript', 'document');
    const result = await fixture.service.analyze({ artifactId: 'source', ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}) });
    expect(result.entities).toEqual(['AI', 'EU']);
    const terms = fake.requests.map(request => (request.state as { candidate: { term: string } }).candidate.term);
    expect(terms.filter(term => term === 'receipt')).toHaveLength(1);
    expect(fixture.service.buildPacket(result).rendered).toContain('Entities: AI, EU');
    expect(fixture.writes).toHaveLength(0);
    await fixture.service.writeBackAnalysis(JSON.parse(JSON.stringify(result)) as typeof result, { metadata: { sourceArtifactId: 'forged' } });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.ingests[0]).toMatchObject({ tags: expect.arrayContaining(['AI', 'EU']), metadata: { sourceArtifactId: 'source' } });
    expect(fixture.usages).toHaveLength(1);
  });
}

test('empty content needs no judgment and settled none stays empty', async () => {
  usePort(undefined);
  const empty = await multimodalFixture('image', '').service.analyze({ artifactId: 'source' });
  expect(empty.entities).toEqual([]);
  const fake = fakePort(() => noulAnswer(0.01)); usePort(fake.port);
  const fixture = multimodalFixture();
  const result = await fixture.service.analyze({ artifactId: 'source' });
  expect(result.entities).toEqual([]);
  expect(fixture.service.buildPacket(result).rendered).not.toContain('Entities:');
});

for (const [name, answer] of [['uncertain', noulAnswer(0.5)], ['malformed', noulAnswer(Number.NaN)], ['wrong answer type', { type: 'text', text: 'AI' }]] as const) {
  test(`${name} never becomes empty success or writes`, async () => {
    usePort(fakePort(() => answer).port);
    const fixture = multimodalFixture();
    await expect(fixture.service.analyze({ artifactId: 'source' })).rejects.toThrow('held');
    expect(fixture.writes).toHaveLength(0);
  });
}

test('unavailable has no frequency fallback', async () => {
  usePort(undefined);
  await expect(multimodalFixture().service.analyze({ artifactId: 'source' })).rejects.toThrow('unavailable');
});

test('contrary-to-frequency order and existing image/audio caps are retained', async () => {
  usePort(fakePort((_name, _question, state) => {
    const term = (state as { candidate: { term: string } }).candidate.term;
    return noulAnswer(term === 'Z' ? 0.999 : 0.95);
  }).port);
  for (const [kind, cap] of [['image', 8], ['audio', 10]] as const) {
    const result = await multimodalFixture(kind, 'A A A A B C D E F G H I J K Z').service.analyze({ artifactId: 'source' });
    expect(result.entities).toHaveLength(cap); expect(result.entities[0]).toBe('Z');
  }
});

test('full image, audio, document and video text is screened before clipping, budget or port lookup', async () => {
  const fake = centralPort(); usePort(fake.port);
  const text = `${'receipt '.repeat(600)}password=inline-credential`;
  for (const kind of ['image', 'audio', 'document', 'video'] as const) {
    const fixture = multimodalFixture(kind, text);
    if (kind === 'video') fixture.add('transcript', 'document', text);
    await expect(fixture.service.analyze({ artifactId: 'source', ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}) })).rejects.toThrow('Refused before judgment');
    expect(fixture.writes).toHaveLength(0);
  }
  expect(fake.requests).toHaveLength(0);
});

test('foreign and duplicate rank IDs are rejected before publication', async () => {
  usePort(centralPort().port);
  const spy = spyOn(entityCentrality, 'rerank');
  try {
    for (const id of ['foreign', 'term:0']) {
      spy.mockResolvedValue({ ranked: [0, 1].map(() => ({ id, probability: 0.99, reading: { verdict: 'yes', outcome: 'act' }, decisionId: undefined })), top: undefined } as never);
      await expect(rankMultimodalEntities('AI EU', 8, { assertCurrent() {}, authority: captureJudgmentPort('multimodal.entity-centrality') })).rejects.toThrow('malformed');
    }
  } finally { spy.mockRestore(); }
});

test('retired port blocks both packet and persistence of an earlier reading', async () => {
  usePort(centralPort().port);
  const fixture = multimodalFixture();
  const result = await fixture.service.analyze({ artifactId: 'source' });
  usePort(centralPort().port);
  expect(() => fixture.service.buildPacket(result)).toThrow();
  await expect(fixture.service.writeBackAnalysis(result)).rejects.toThrow();
  expect(fixture.writes).toHaveLength(0);
});

test('replaced artifacts, forged analyses and cancelled requests cannot persist', async () => {
  usePort(centralPort().port);
  for (const condition of ['artifact', 'forged', 'request'] as const) {
    const fixture = multimodalFixture(); const controller = new AbortController();
    const result = await fixture.service.analyze({ artifactId: 'source' }, { signal: controller.signal });
    if (condition === 'artifact') fixture.records.set('source', { ...fixture.records.get('source')!, sha256: 'replacement' });
    if (condition === 'request') controller.abort();
    const offered = condition === 'forged' ? { ...result, entities: ['unauthorized'] } : result;
    expect(() => fixture.service.buildPacket(offered)).toThrow();
    await expect(fixture.service.writeBackAnalysis(offered)).rejects.toThrow();
    expect(fixture.writes).toHaveLength(0);
  }
});

test('port retirement interrupts a non-cooperating in-flight reading', async () => {
  const controller = new AbortController();
  const fixture = multimodalFixture();
  usePort({ model: 'jev-1.13.0', ask: async () => { controller.abort(); return await new Promise<never>(() => {}); } });
  await expect(fixture.service.analyze({ artifactId: 'source' }, { signal: controller.signal })).rejects.toThrow();
  expect(fixture.writes).toHaveLength(0);
});

test('video retains keyframe and audio ownership and complete text', async () => {
  usePort(centralPort().port);
  const fixture = multimodalFixture('video'); fixture.add('frame', 'image'); fixture.add('audio', 'audio');
  const result = await fixture.service.analyze({ artifactId: 'source', metadata: { keyframeArtifactIds: ['frame'], audioArtifactId: 'audio' } });
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

test('new explicit write-back owner cancellation blocks writes despite an exact retained analysis', async () => {
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

test('original port installation owns the provider await', async () => {
  usePort(centralPort().port);
  const fixture = multimodalFixture();
  fixture.mediaProviders.findProvider = () => ({ analyze: async () => {
    usePort(centralPort().port);
    return { providerId: 'fixture', text: 'AI', labels: [], metadata: {} };
  } });
  await expect(fixture.service.analyze({ artifactId: 'source' })).rejects.toThrow();
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
  const ranked = await rankMultimodalEntities(source, 10, { assertCurrent() {}, authority: captureJudgmentPort('multimodal.entity-centrality') });
  expect(ranked.entities).toEqual(['AI', 'EU']);
});
