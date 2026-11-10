/** Authored unit-fixture observations, never captured model/calibration evidence. */
import type { Battery, BatteryItems, EntryType } from '@goodvibes-jev/judgment';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { StaticSourceCallRecord } from '../../scripts/static-source-call-recording.ts';
import { readingModel } from '../../scripts/ci-readings/stored-readings.ts';

export function editorialReading(
  battery: Battery<BatteryItems>,
  state: EntryType,
  probabilities: Readonly<Record<string, number>>,
  site: string,
): StaticSourceCallRecord {
  return {
    format: 1,
    call: {
      id: 'synthetic-editorial-unit-call', at: '2026-11-10T00:00:00.000Z',
      battery: battery.name, version: battery.version, site,
      state: structuredClone(state),
      questions: Object.fromEntries(Object.keys(probabilities).map(name => [name, battery.items[name]!.question])),
      requestedModel: readingModel(battery), observedModel: 'synthetic-editorial-unit-model', requestId: null,
      answers: Object.fromEntries(Object.entries(probabilities).map(([name, probability]) => [name, noulAnswer(probability)])),
    },
    usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0,
  };
}
