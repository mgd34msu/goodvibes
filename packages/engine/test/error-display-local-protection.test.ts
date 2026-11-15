import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { normalizeError, readNormalizedError } from '../platform/src/platform/utils/error-display.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { forgetFailureReadings(); previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); forgetFailureReadings(); });

describe('readNormalizedError without a judgment port', () => {
  test('masks credential material in the message and summary it returns', async () => {
    const normalized = await readNormalizedError(
      new Error('context owner revoked password=hunter2zzz'),
      { site: 'test.error-display' },
    );
    expect(normalized.message).not.toContain('hunter2zzz');
    expect(normalized.summary).not.toContain('hunter2zzz');
    expect(normalized.message.length).toBeGreaterThan(0);
  });
});

describe('hints for bad_request and not_found', () => {
  test('a non-provider 400 or 404 gets no model-id hint', () => {
    const calendar = normalizeError(Object.assign(new Error('Calendar range is malformed'), { statusCode: 400 }), {});
    expect(calendar.hint).toBeUndefined();
    const tool = normalizeError(Object.assign(new Error('no such record'), { statusCode: 404 }), { source: 'tool' });
    expect(tool.hint).toBeUndefined();
  });

  test('a provider 400 or 404 keeps the model-id hint', () => {
    const bad = normalizeError(Object.assign(new Error('invalid request'), { statusCode: 400 }), { provider: 'openai' });
    expect(bad.hint).toContain('model id');
    const missing = normalizeError(Object.assign(new Error('model not found'), { statusCode: 404 }), { source: 'provider' });
    expect(missing.hint).toContain('model id');
  });
});
