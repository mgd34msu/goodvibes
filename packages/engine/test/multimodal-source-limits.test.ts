import { afterEach, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { multimodalFixture } from './_helpers/multimodal-entities.js';

let previous: ReturnType<typeof installJudgmentPort> | undefined;
let installed = false;
function usePort(port: Parameters<typeof installJudgmentPort>[0]) {
  if (!installed) { previous = installJudgmentPort(port); installed = true; } else installJudgmentPort(port);
}
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });

test('a source with more distinct terms than one ranking request can carry is analyzed, and says its entities were not assessed', async () => {
  const fake = fakePort(() => noulAnswer(0.01));
  usePort(fake.port);
  const words = Array.from({ length: 200 }, (_, index) => `term${index}`).join(' ');
  const fixture = multimodalFixture('document', words);
  const result = await fixture.service.analyze({ artifactId: 'source' });
  expect(result.entities).toEqual([]);
  expect(result.metadata).toMatchObject({ entityAssessment: 'not-evaluated', entityAssessmentSkipped: 'budget', provenance: 'decision' });
  expect(fake.requests).toHaveLength(0);
  expect(fixture.service.buildPacket(result).rendered).toContain('not assessed');
});

test('an inline artifact made for a failed analysis is not left behind', async () => {
  usePort(fakePort(() => noulAnswer(0.5)).port); // an uncertain reading holds the analysis after the artifact exists
  const fixture = multimodalFixture('document');
  await expect(fixture.service.analyze({ artifact: { dataBase64: 'aGk=', mimeType: 'text/plain' } })).rejects.toThrow('held');
  expect(fixture.writes).toHaveLength(1);
  expect([...fixture.records.keys()]).toEqual(['source']);
});

test('an audio type without a dedicated name is sent under its own container name, not as wav', async () => {
  usePort(fakePort(() => noulAnswer(0.01)).port);
  const fixture = multimodalFixture('audio', 'hello');
  Object.assign(fixture.records.get('source')!, { mimeType: 'audio/x-m4a' });
  let format: unknown;
  fixture.voiceService.transcribe = (async (_provider: unknown, request: { audio: { format: unknown } }) => {
    format = request.audio.format;
    return { providerId: 'fixture-audio', text: 'hello', segments: [], metadata: {} };
  }) as never;
  await fixture.service.analyze({ artifactId: 'source' });
  expect(format).toBe('m4a');
});

test('a packet larger than the requested budget says so', async () => {
  usePort(fakePort(() => noulAnswer(0.01)).port);
  const fixture = multimodalFixture('document', 'budget words '.repeat(50));
  const result = await fixture.service.analyze({ artifactId: 'source' });
  expect(fixture.service.buildPacket(result, 'standard', 1_000).rendered).not.toContain('Over budget');
  expect(fixture.service.buildPacket(result, 'standard', 1).rendered).toContain('Over budget');
});
