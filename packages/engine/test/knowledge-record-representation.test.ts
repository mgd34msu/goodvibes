import { expect, test } from 'bun:test';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.js';
import { knowledgeRawRepresentation, retainKnowledgeRepresentation, sameKnowledgeRecord } from '../platform/src/platform/knowledge/store-record-representation.js';

test('native representation keeps detached raw values without granting copies the original clock representation', () => {
  const value = { metadata: { stamp: { decidedAt: 4_222_222_222_222 }, description: 'Original' } };
  const original = { metadata: { stamp: { decidedAt: new Date(value.metadata.stamp.decidedAt).toISOString() }, description: 'Original' } };
  retainKnowledgeRepresentation(value, original);
  const expected = structuredClone(original);
  original.metadata.stamp.decidedAt = 'Mutated external raw input';
  expect(knowledgeRawRepresentation<unknown>(value)).toEqual(expected);
  expect(knowledgeRawRepresentation(structuredClone(value))).toEqual(value);
  value.metadata.description = 'Changed text';
  expect(knowledgeRawRepresentation<unknown>(value)).toEqual({ metadata: { stamp: expected.metadata.stamp, description: 'Changed text' } });
  value.metadata.stamp = { decidedAt: value.metadata.stamp.decidedAt };
  expect(knowledgeRawRepresentation(value)).toEqual(value);
});

test('record equality preserves absence, negative zero and complete array data while ignoring property insertion order', () => {
  expect(sameKnowledgeRecord({ first: 1, second: 'two' }, { second: 'two', first: 1 })).toBe(true);
  expect(sameKnowledgeRecord({ value: undefined }, {})).toBe(false);
  expect(sameKnowledgeRecord({ value: -0 }, { value: 0 })).toBe(false);
  const values = ['same']; Object.defineProperty(values, 'meaning', { value: 'Additional user input', enumerable: true });
  expect(sameKnowledgeRecord(values, ['same'])).toBe(false);
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 'same'; } });
  expect(() => sameKnowledgeRecord(hostile, { value: 'same' })).toThrow(JudgmentInputError);
  expect(getterCalls).toBe(0);
});


test('nested named array edits revoke the original raw binding without hiding the caller change', () => {
  const values = Object.assign(['same'], { meaning: 'Original view' });
  const record = { metadata: { values } };
  retainKnowledgeRepresentation(record, { metadata: { values: Object.assign(['same'], { meaning: 'Canonical original' }) } });
  expect(knowledgeRawRepresentation(record).metadata.values.meaning).toBe('Canonical original');
  values.meaning = 'Changed complete input';
  expect(knowledgeRawRepresentation(record).metadata.values.meaning).toBe('Changed complete input');
  expect(sameKnowledgeRecord({ values }, { values: ['same'] })).toBe(false);
  expect(sameKnowledgeRecord(new Array(1), [undefined])).toBe(false);
});
