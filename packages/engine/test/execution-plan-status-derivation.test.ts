import { describe, expect, test } from 'bun:test';
import { derivePlanStatus } from '../platform/src/platform/core/execution-plan.ts';

const items = (...statuses: string[]) => statuses.map(status => ({ status })) as never;

describe('derivePlanStatus', () => {
  test('is a function of the items', () => {
    expect(derivePlanStatus('active', items('complete', 'skipped'))).toBe('complete');
    expect(derivePlanStatus('active', items('complete', 'failed'))).toBe('failed');
    expect(derivePlanStatus('draft', items('pending', 'in_progress'))).toBe('active');
  });
  test('a finished or failed plan whose item goes back to pending is active again', () => {
    expect(derivePlanStatus('complete', items('complete', 'pending'))).toBe('active');
    expect(derivePlanStatus('failed', items('pending', 'pending'))).toBe('active');
    expect(derivePlanStatus('failed', items('complete', 'in_progress'))).toBe('active');
  });
  test('draft and active are kept when nothing has finished or failed', () => {
    expect(derivePlanStatus('draft', items('pending'))).toBe('draft');
    expect(derivePlanStatus('active', items('complete', 'pending'))).toBe('active');
  });
  test('dismissed is sticky', () => {
    expect(derivePlanStatus('dismissed', items('complete'))).toBe('dismissed');
    expect(derivePlanStatus('dismissed', items('failed'))).toBe('dismissed');
  });
});
