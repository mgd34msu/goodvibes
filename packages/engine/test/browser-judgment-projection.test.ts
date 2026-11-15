import { describe, expect, test } from 'bun:test';
import { BrowserJudgmentError, BROWSER_JUDGMENT_BATTERY_VERSIONS, type BrowserJudgmentBatteryId, type BrowserJudgmentRequest } from '../daemon-api/src/index.ts';
import { validateBrowserJudgmentProjection } from '../platform/src/platform/judgment-browser/projection.ts';
import type { BrowserJudgmentProjection } from '../platform/src/platform/judgment-browser/types.ts';
import { WEBUI_CODE_LANGUAGES } from '../daemon-api/src/index.ts';

const unknownReading = { kind: 'yes-no', probability: 0.5, verdict: 'uncertain', outcome: 'escalate' } as const;
const request = (battery: BrowserJudgmentBatteryId, input: unknown) => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery, batteryVersion: BROWSER_JUDGMENT_BATTERY_VERSIONS[battery], input }) as BrowserJudgmentRequest;
const check = (req: BrowserJudgmentRequest, projection: unknown, state?: unknown) => validateBrowserJudgmentProjection(req, projection as BrowserJudgmentProjection<unknown>, state);
const held = (readings: unknown) => ({ status: 'held', reason: 'uncertain', readings });
const errorNames = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'];

describe('closed held projections', () => {
  test('held errors require all five fixed yes/no reading names', () => {
    const req = request('webui.errors.daemon-refusal', { errorRef: 'fixture' });
    const readings = Object.fromEntries(errorNames.map((name) => [name, unknownReading]));
    expect(() => check(req, held(readings))).not.toThrow();
    for (const bad of [{ private_state: unknownReading }, { ...readings, private_state: unknownReading }, { ...readings, method_unknown: undefined }]) {
      expect(() => check(req, held(bad))).toThrow(BrowserJudgmentError);
    }
  });
  test('held palette readings are complete opaque candidate indices', () => {
    const req = request('webui.palette.command-rank', { query: { kind: 'inline', text: 'fixture' }, registryVersion: 'v1', candidates: [{ kind: 'builtin', commandId: 'a' }, { kind: 'builtin', commandId: 'b' }] });
    expect(() => check(req, held({ candidate_0: unknownReading, candidate_1: unknownReading }))).not.toThrow();
    for (const readings of [{ candidate_0: unknownReading }, { private_state: unknownReading, candidate_1: unknownReading },
      { candidate_0: unknownReading, candidate_1: { ...unknownReading, probability: NaN } }]) expect(() => check(req, held(readings))).toThrow(BrowserJudgmentError);
  });
});

test('settled public code projections preserve admitted approximate-unit Choices', () => {
  const choice = 'typescript';
  const req = request('webui.code.language', { sessionId: 'synthetic-session', messageId: 'synthetic-message', start: 0, end: 5, contentRevision: 'source-owner-revision' });
  const reading = {
    kind: 'choice', choice, confidence: 0.99, outcome: 'act',
    probabilities: Object.fromEntries(WEBUI_CODE_LANGUAGES.map(option => [option, option === choice ? 0.99 : 0])),
  };
  const projection = { status: 'settled', value: { language: choice }, readings: { language: reading } };
  const original = structuredClone(projection);
  expect(() => check(req, projection)).not.toThrow();
  expect(projection).toEqual(original);
  reading.probabilities[choice] = 0.5;
  reading.probabilities.python = 0.5000000001;
  expect(() => check(req, projection)).toThrow(BrowserJudgmentError);
});
