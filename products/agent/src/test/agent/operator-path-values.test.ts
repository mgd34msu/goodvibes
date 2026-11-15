import { describe, expect, test } from 'bun:test';
import { prepareOperatorRequest } from '../../agent/operator-contract-routes.ts';
import { getOperatorActions, renderOperatorActionPath } from '../../agent/operator-actions.ts';

describe('operator path parameters that URL parsing would collapse', () => {
  test('prepareOperatorRequest refuses ".." and "." for a path parameter and encodes a real id', () => {
    expect(() => prepareOperatorRequest('channels.drafts.delete', { draftId: '..' })).toThrow("not '..'");
    expect(() => prepareOperatorRequest('channels.drafts.delete', { draftId: '.' })).toThrow("not '.'");
    expect(prepareOperatorRequest('channels.drafts.delete', { draftId: 'a b' }).path).toContain('a%20b');
  });
  test('renderOperatorActionPath refuses ".." and an empty id for every action target', () => {
    for (const descriptor of Object.values(getOperatorActions())) {
      expect(() => renderOperatorActionPath(descriptor, '..')).toThrow('real identifier');
      expect(() => renderOperatorActionPath(descriptor, '')).toThrow('real identifier');
    }
  });
});
