import { expect, test } from 'bun:test';
import type { EntryType, JsonValue } from '@goodvibes-jev/judgment';
import {
  captureJsonEntry, captureJsonValue, captureOwnedJson, JudgmentInputError, retainOwnedJson, snapshotJudgmentEntry, snapshotJudgmentJson,
} from '../sdk/src/platform/gate/judgment-input.js';
import { captureAutonomousChoices, captureAutonomousSource } from '../sdk/src/platform/permissions/autonomous.js';

test('typed judgment state preserves JSON wire shape and detaches the complete nested input', () => {
  const rows = ['original', undefined, 'tail'];
  const raw = { optional: undefined, nested: { rows }, count: 2, ready: true };
  const state: EntryType = snapshotJudgmentEntry(raw);
  rows[0] = 'mutated';
  raw.nested.rows.push('later');
  expect(state).toEqual({ nested: { rows: ['original', null, 'tail'] }, count: 2, ready: true });
  expect(JSON.stringify(state)).toBe('{"nested":{"rows":["original",null,"tail"]},"count":2,"ready":true}');
  expect(Object.isFrozen(state)).toBe(true);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Expected object state');
  const nested = state['nested'];
  expect(Object.isFrozen(nested)).toBe(true);
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) throw new Error('Expected nested object');
  expect(Object.isFrozen(nested['rows'])).toBe(true);
});

test('JSON values and System One entries have distinct valid roots', () => {
  const values: JsonValue[] = [snapshotJudgmentJson(2), snapshotJudgmentJson(false), snapshotJudgmentJson(null)];
  expect(values).toEqual([2, false, null]);
  for (const value of [2, false, undefined]) {
    expect(() => snapshotJudgmentEntry(value)).toThrow(JudgmentInputError);
    expect(() => captureJsonEntry(value)).toThrow(JudgmentInputError);
  }
  expect(() => snapshotJudgmentJson(undefined)).toThrow(JudgmentInputError);
  expect(() => captureJsonValue(undefined)).toThrow(JudgmentInputError);
});

test('privacy inspection precedes JSON omission and array projection', () => {
  const values = ['ordinary'];
  Object.defineProperty(values, 'hidden', { value: { password: 'synthetic-inline-secret' } });
  expect(() => snapshotJudgmentJson(values)).toThrow(JudgmentInputError);
  expect(() => snapshotJudgmentEntry(values)).toThrow(JudgmentInputError);
});

test('typed capture never executes accessors or serialization hooks', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'field', { get() { calls++; return 'value'; } });
  const serializer = { toJSON() { calls++; return { concealed: 'value' }; } };
  for (const value of [getter, serializer]) {
    expect(() => captureJsonValue(value)).toThrow(JudgmentInputError);
    expect(() => snapshotJudgmentEntry(value)).toThrow(JudgmentInputError);
  }
  expect(calls).toBe(0);
});

test('typed protocol capture keeps reserved property names as detached data', () => {
  const raw: unknown = JSON.parse('{"__proto__":{"marker":"ordinary"},"constructor":"data"}');
  const state = captureJsonEntry(raw);
  expect<unknown>(state).toEqual(raw);
  expect(state).not.toBe(raw);
  if (state === null || typeof state !== 'object') throw new Error('Expected object state');
  expect(Object.getPrototypeOf(state)).toBeNull();
  expect(Object.hasOwn(state, '__proto__')).toBe(true);
});

test('typed source construction requires actual criteria and preserves optional field validation', () => {
  const sparse: unknown[] = new Array(1);
  for (const source of [
    { goal: 'Inspect source', criteria: sparse },
    { goal: 'Inspect source', criteria: ['Read the file'], conversationContext: undefined },
    { goal: 'Inspect source', criteria: ['Read the file'], unexpected: undefined },
  ]) expect(() => captureAutonomousSource(source)).toThrow();
  const criteria = ['Read the file'];
  const source = captureAutonomousSource({ goal: 'Inspect source', criteria });
  criteria[0] = 'Changed criteria';
  expect(source).toEqual({ goal: 'Inspect source', criteria: ['Read the file'] });
  expect(Object.isFrozen(source.criteria)).toBe(true);
});

test('host alternatives retain immutable execution arguments independently of wire omission', () => {
  const args = { path: 'README.md', optional: undefined, nested: { value: 'original' } };
  const choices = captureAutonomousChoices({ revisions: [{
    ref: { id: 'read', revision: '1', kind: 'revise-action' }, toolName: 'read', args,
  }] });
  args.nested.value = 'later';
  const captured = choices.revisions?.[0]?.args;
  expect(captured).toEqual({ path: 'README.md', optional: undefined, nested: { value: 'original' } });
  expect(Object.hasOwn(captured ?? {}, 'optional')).toBe(true);
  expect(Object.isFrozen(captured)).toBe(true);
});

test('typed capture preserves iterative deep-data support and native immutable reuse', () => {
  let raw: unknown = { leaf: 'tail' };
  for (let depth = 0; depth < 12_000; depth++) raw = { child: raw };
  const captured = captureJsonEntry(raw);
  expect(captureOwnedJson(captured)).toBe(captured);
  const retained = retainOwnedJson(captured);
  retained.assertCurrent();
  let leaf: unknown = captured;
  let frozen = true;
  for (let depth = 0; depth < 12_000; depth++) {
    if (!leaf || typeof leaf !== 'object' || !('child' in leaf)) throw new Error('Missing captured child');
    frozen &&= Object.isFrozen(leaf);
    leaf = leaf.child;
  }
  expect(frozen).toBe(true);
  expect(leaf).toEqual({ leaf: 'tail' });
});

test('typed capture preserves sparse array length without materializing missing slots', () => {
  const raw: unknown[] = new Array(100_000);
  raw[99_999] = 'tail';
  const captured = captureJsonEntry(raw);
  expect(Array.isArray(captured)).toBe(true);
  if (!Array.isArray(captured)) throw new Error('Expected array state');
  expect(captured).toHaveLength(100_000);
  expect(Object.keys(captured)).toEqual(['99999']);
  expect(captured[99_999]).toBe('tail');
  expect(Object.isFrozen(captured)).toBe(true);
});
