import { expect, test } from 'bun:test';
import { TurnSubmissionOwner } from '../platform/src/platform/core/turn-submission.js';

const input = { sessionId: 'session', position: 0, text: 'private input sentinel' };

test('an exact duplicate retains its active key even when another turn is active', () => {
  const owner = new TurnSubmissionOwner();
  const first = owner.keyFor(input), other = owner.keyFor({ ...input, text: 'different request' });
  expect(owner.keyFor({ ...input })).toBe(first);
  expect(other).not.toBe(first);
  expect(first).not.toContain(input.text);
  owner.release(first);
  expect(owner.keyFor(input)).not.toBe(first);
  expect(owner.keyFor({ ...input, text: 'different request' })).toBe(other);
});

test('full prompt tails and multimodal parts distinguish active requests', () => {
  const owner = new TurnSubmissionOwner(), prefix = 'shared prefix '.repeat(80);
  const first = owner.keyFor({ ...input, text: prefix + 'first' });
  expect(owner.keyFor({ ...input, text: prefix + 'second' })).not.toBe(first);
  const content = [{ type: 'image' as const, data: 'original-image', mediaType: 'image/png' }];
  const image = owner.keyFor({ ...input, content });
  content[0]!.data = 'changed-image';
  expect(owner.keyFor({ ...input, content })).not.toBe(image);
  expect(owner.keyFor({ ...input, content: [{ type: 'image', data: 'original-image', mediaType: 'image/png' }] })).toBe(image);
});

test('session and transcript position scope a submission; clearing releases every active input', () => {
  const owner = new TurnSubmissionOwner(), first = owner.keyFor(input);
  expect(owner.keyFor({ ...input, sessionId: 'another-session' })).not.toBe(first);
  expect(owner.keyFor({ ...input, position: 1 })).not.toBe(first);
  owner.clear();
  expect(owner.keyFor(input)).not.toBe(first);
});

test('native permitted runs are independent and do not replace ordinary duplicate ownership', () => {
  const owner = new TurnSubmissionOwner(), ordinary = owner.keyFor(input);
  const first = owner.keyFor(input, true), second = owner.keyFor(input, true);
  expect(first).not.toBe(second);
  expect(first).not.toBe(ordinary);
  owner.release(first);
  expect(owner.keyFor(input)).toBe(ordinary);
});
