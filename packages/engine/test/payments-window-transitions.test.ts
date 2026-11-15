/** A reply answers a notice that was sent: an acknowledgement before dispatch changes nothing, an objection always cancels. */
import { expect, test } from 'bun:test';
import { advanceVeto } from '../platform/src/platform/payments/windows.ts';

test('an acknowledgement does not settle a veto window whose notice has not been dispatched', () => {
  expect(advanceVeto('pending-dispatch', { kind: 'acknowledge', channel: 'telegram' })).toBe('pending-dispatch');
});

test('an acknowledgement settles an open window, and an objection cancels from either state', () => {
  expect(advanceVeto('open', { kind: 'acknowledge', channel: 'telegram' })).toBe('proceeding-acknowledged');
  expect(advanceVeto('open', { kind: 'object', channel: 'telegram' })).toBe('cancelled');
  expect(advanceVeto('pending-dispatch', { kind: 'object', channel: 'telegram' })).toBe('cancelled');
});
