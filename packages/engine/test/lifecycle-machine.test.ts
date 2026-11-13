import { expect, test } from 'bun:test';
import { defineLifecycle, IllegalLifecycleTransitionError } from '../platform/src/platform/utils/lifecycle-machine.ts';

type Door = 'open' | 'closed' | 'locked' | 'removed';
const door = defineLifecycle<Door>('door', {
  open: ['closed', 'removed'],
  closed: ['open', 'locked', 'removed'],
  locked: ['closed'],
  removed: [],
});

test('the table decides every move, including a move to the same state', () => {
  expect(door.can('open', 'closed')).toBe(true);
  expect(door.can('open', 'locked')).toBe(false);
  expect(door.can('open', 'open')).toBe(false);
  expect(door.next('closed')).toEqual(['open', 'locked', 'removed']);
  expect(door.states).toEqual(['open', 'closed', 'locked', 'removed']);
});

test('a state with no targets is final and says so when a move is refused', () => {
  expect(door.isTerminal('removed')).toBe(true);
  expect(door.isTerminal('locked')).toBe(false);
  const refused = door.check('removed', 'open');
  expect(refused).toEqual({ ok: false, from: 'removed', to: 'open', allowed: [], reason: 'door is removed, which is final; it cannot become open' });
});

test('a refusal names the moves that are legal', () => {
  const refused = door.check('locked', 'open');
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.allowed).toEqual(['closed']);
  expect(refused.reason).toBe('door is locked and cannot become open; from locked it can become closed');
  expect(door.check('closed', 'locked')).toEqual({ ok: true, from: 'closed', to: 'locked' });
});

test('assert throws an error carrying the machine, the move and the legal moves', () => {
  expect(() => door.assert('closed', 'open')).not.toThrow();
  let thrown: unknown;
  try { door.assert('locked', 'removed'); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(IllegalLifecycleTransitionError);
  const error = thrown as IllegalLifecycleTransitionError<Door>;
  expect([error.machine, error.from, error.to, error.allowed]).toEqual(['door', 'locked', 'removed', ['closed']]);
});

test('untrusted values are narrowed, and an unknown state is refused rather than trusted', () => {
  expect(door.isState('locked')).toBe(true);
  expect(door.isState('ajar')).toBe(false);
  expect(door.isState(undefined)).toBe(false);
  expect(door.can('ajar' as Door, 'open')).toBe(false);
  expect(door.check('ajar' as Door, 'open')).toMatchObject({ ok: false, reason: "door is in an unknown state 'ajar'", allowed: [] });
  expect(door.check('open', 'ajar' as Door)).toMatchObject({ ok: false, reason: "door has no state 'ajar'" });
});

test('a target that is not a declared state is rejected when the lifecycle is declared', () => {
  expect(() => defineLifecycle('broken', { a: ['b'] } as unknown as Record<'a', readonly 'a'[]>)).toThrow("broken lifecycle: 'a' names 'b', which is not a declared state");
});

test('the declared table cannot be changed afterwards and describes itself', () => {
  expect(Object.isFrozen(door.transitions)).toBe(true);
  expect(Object.isFrozen(door.transitions.open)).toBe(true);
  expect(door.describe()).toBe('open → closed | removed\nclosed → open | locked | removed\nlocked → closed\nremoved → (final)');
});
