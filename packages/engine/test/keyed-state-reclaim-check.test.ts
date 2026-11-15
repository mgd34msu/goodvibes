import { expect, test } from 'bun:test';
import { createKeyedStateReclaimCheck } from '../platform/src/platform/tools/session-kv-state.js';

test('without an owner that knows which sessions are resumable, nothing is reclaimed', () => {
  expect(createKeyedStateReclaimCheck(undefined)).toBeUndefined();
});

test('keyed state is reclaimable only once the owner no longer holds the session', () => {
  const held = new Set(['hosted-1']);
  const canReclaim = createKeyedStateReclaimCheck((token) => held.has(token))!;
  expect(canReclaim('hosted-1')).toBe(false);
  expect(canReclaim('gone-2')).toBe(true);
});

test('a token that carries an id hash is never reclaimed, since its session id cannot be recovered', () => {
  const canReclaim = createKeyedStateReclaimCheck(() => false)!;
  expect(canReclaim('my_session-0123456789abcdef')).toBe(false);
});
