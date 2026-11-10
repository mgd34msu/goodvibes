import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStaticInputs, loadStaticSourceReadings, projectCurrentStaticSourceReadings, saveStaticSourceReadings, staticInputCaptureComplete, staticInputKey, staticInputStanding } from '../scripts/static-source-readings.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const input = () => captureStaticInputs('internal-identifier', 'platform/src/example.ts', '// Public source\nconst value = 3;')[0]!;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

test('current projection retains complete held subset evidence and leaves private history unchanged', async () => {
  const captured = input();
  const prepared = await preparedStaticReadings([captured], .5);
  const receipt = prepared.readings[staticInputKey(captured)];
  if (!object(receipt) || !Array.isArray(receipt.parts)) throw new Error('Missing exact captured subsets');
  const prior = { oldRawProbability: .989999, requestId: 'old-request', input: { ...captured, source: 'Original prior source.' } };
  const withHistory = { ...receipt, previousCaptures: [prior], parts: receipt.parts.map(part => {
    if (!object(part)) throw new Error('Missing subset receipt');
    return { ...part, previousCaptures: [prior] };
  }) };
  const current = { ...prepared, readings: { [staticInputKey(captured)]: withHistory, obsolete: prior } };
  const original = JSON.stringify(current);
  const projected = projectCurrentStaticSourceReadings([captured], current);
  expect(Object.keys(projected.readings)).toEqual([staticInputKey(captured)]);
  expect(projected.readings[staticInputKey(captured)]).toEqual({ ...receipt, parts: receipt.parts });
  expect(JSON.stringify(current)).toBe(original);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  expect(staticInputStanding(captured, projected)).toEqual(staticInputStanding(captured, current));
  expect(staticInputCaptureComplete(captured, projected)).toBe(staticInputCaptureComplete(captured, current));
  expect(staticInputCaptureComplete(captured, projected)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'static-current-projection-'));
  try {
    const privatePath = join(root, 'checkpoint.json');
    const canonicalPath = join(root, 'current.json.gz');
    saveStaticSourceReadings(current, privatePath);
    saveStaticSourceReadings(projected, canonicalPath);
    expect(loadStaticSourceReadings(privatePath)).toEqual(current);
    expect(loadStaticSourceReadings(canonicalPath)).toEqual(projected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('active raw input, state, questions and unrounded answers survive projection without policy certificates', async () => {
  const captured = input(), probability = .499999987654321;
  const current = await preparedStaticReadings([captured], probability);
  const receipt = current.readings[staticInputKey(captured)];
  if (!object(receipt) || !object(receipt.presence) || !Array.isArray(receipt.parts)) throw new Error('Missing original unit observations');
  const original = JSON.stringify(current);
  const projected = projectCurrentStaticSourceReadings([captured], current);
  const retained = projected.readings[staticInputKey(captured)];
  if (!object(retained) || !object(retained.presence)) throw new Error('Missing projected observations');
  expect(retained.input).toEqual(captured);
  expect(retained.presence.state).toEqual(receipt.presence.state);
  expect(retained.presence.questions).toEqual(receipt.presence.questions);
  expect(retained.presence.answers).toEqual({ violation: { type: 'noul', noul: probability } });
  expect(retained.parts).toEqual(receipt.parts);
  expect(staticInputStanding(captured, projected)).toEqual(staticInputStanding(captured, current));
  expect(staticInputStanding(captured, projected).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, projected)).toBe(true);
  const incomplete = { ...current, readings: { [staticInputKey(captured)]: { ...receipt, parts: receipt.parts.slice(0, 1) } } };
  const incompleteProjection = projectCurrentStaticSourceReadings([captured], incomplete);
  expect(staticInputStanding(captured, incompleteProjection).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, incompleteProjection)).toBe(false);
  expect(JSON.stringify(current)).toBe(original);
});

test('projection cannot adopt an inherited historical root or turn missing evidence into a capture', async () => {
  const captured = input();
  const prepared = await preparedStaticReadings([captured]);
  const missing = { ...captured, source: captured.source + '\nChanged source.' };
  const roots = Object.create(prepared.readings);
  Object.defineProperty(roots, '__proto__', { value: { rawHistory: .123456789 }, enumerable: true });
  const current = { ...prepared, readings: roots };
  const projected = projectCurrentStaticSourceReadings([captured, missing], current);
  expect(projected.readings).toEqual({});
  expect(Object.hasOwn(current.readings, '__proto__')).toBe(true);
  for (const source of [captured, missing]) {
    expect(staticInputStanding(source, projected)).toEqual(staticInputStanding(source, current));
    expect(staticInputStanding(source, projected).kind).toBe('held');
    expect(staticInputCaptureComplete(source, projected)).toBe(false);
  }
});
