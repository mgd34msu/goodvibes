import { describe, expect, test } from 'bun:test';
import { LIVE_CANCELLATION, RETAINED_CANCELLATION } from './contract-cancellation-fixture';

describe('genuine cancellation response captures', () => {
  test('true records terminalization, with the exact operator reason', () => {
    expect(JSON.parse(LIVE_CANCELLATION.resultBody)).toEqual({ cancelled: true });
    expect(LIVE_CANCELLATION.before.record.status).toBe('running');
    expect(LIVE_CANCELLATION.after.record.status).toBe('cancelled');
    expect(LIVE_CANCELLATION.after.record.id).toBe(LIVE_CANCELLATION.before.record.id);
    expect(LIVE_CANCELLATION.after.getBody).toContain('Cancelled by the user from WebUI.');
  });
  test('a retained record the runner is not running is refused with 409 and stays byte-for-byte unchanged', () => {
    expect(RETAINED_CANCELLATION.resultStatus).toBe(409);
    expect(JSON.parse(RETAINED_CANCELLATION.resultBody)).toMatchObject({ code: 'CONTRACT_NOT_RUNNING', status: 409 });
    expect(RETAINED_CANCELLATION.before.record.status).toBe('running');
    expect(RETAINED_CANCELLATION.after.getBody).toBe(RETAINED_CANCELLATION.before.getBody);
    expect(RETAINED_CANCELLATION.after.listBody).toBe(RETAINED_CANCELLATION.before.listBody);
  });
});
