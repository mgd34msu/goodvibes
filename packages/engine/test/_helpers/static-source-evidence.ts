/** Authored synthetic observations for receipt and gate plumbing, never calibration evidence. */
import { readYesNo, STAKES_BANDS } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readStaticInput, staticInputKey, type StaticSourceInput, type StaticSourceReadings } from '../../scripts/static-source-readings.ts';
import { createStaticCallRecorder } from '../../scripts/static-source-call-recording.ts';

export async function preparedStaticReadings(inputs: readonly StaticSourceInput[], probability = 0.01, anchorId?: string): Promise<StaticSourceReadings> {
  const fixture = fakePort((name, question) => question.type === 'choice'
    ? choiceAnswer(question, anchorId && Object.hasOwn(question.criteria, anchorId) ? anchorId
      : Object.keys(question.criteria).find(id => id !== 'none') ?? 'none', 0.99)
    : noulAnswer(name === 'violation' || readYesNo({ type: 'noul', noul: probability }, STAKES_BANDS.high.yesNo).outcome !== 'act' ? probability : 0.99));
  const { port, capture } = createStaticCallRecorder(fixture.port);
  const readings: Record<string, unknown> = {};
  for (const input of inputs) readings[staticInputKey(input)] = await readStaticInput(port, capture, input);
  return { format: 2, readings };
}
