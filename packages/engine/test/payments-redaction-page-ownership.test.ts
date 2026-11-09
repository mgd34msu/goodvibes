import { expect, test } from 'bun:test';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';

test('opaque session/page identities cannot collide or clear another page protection', () => {
  const redactor = new CardMaterialRedactor();
  redactor.arm('a:b', 'c', [{ kind: 'number', value: '4242424242424242' }]);
  redactor.arm('a', 'b:c', [{ kind: 'number', value: '5555555555554444' }]);
  redactor.disarm('a', 'b:c');
  expect(redactor.hasLiveMaterial('a:b', 'c')).toBe(true);
  expect(redactor.hasLiveMaterial('a', 'b:c')).toBe(false);
  expect(redactor.redact('a:b', 'c', 'Card 4242424242424242')).not.toContain('4242424242424242');
});

test('closing a session retires exactly its own pages', () => {
  const redactor = new CardMaterialRedactor();
  redactor.arm('a', 'one', [{ kind: 'cvv', value: '918' }]);
  redactor.arm('a:b', 'two', [{ kind: 'cvv', value: '819' }]);
  redactor.disarmSession('a');
  expect(redactor.hasLiveMaterial('a', 'one')).toBe(false);
  expect(redactor.hasLiveMaterial('a:b', 'two')).toBe(true);
  expect(redactor.redact('a:b', 'two', '819')).not.toContain('819');
});

test('repeated or partial fills retain every distinct material value until the page is cleared', () => {
  const redactor = new CardMaterialRedactor();
  for (let i = 0; i < 10; i++) redactor.arm('session', 'page', [{ kind: 'cvv', value: '918' }]);
  redactor.arm('session', 'page', [{ kind: 'cvv', value: '819' }]);
  const output = redactor.redact('session', 'page', '918 819');
  expect(output).not.toContain('918'); expect(output).not.toContain('819');
  redactor.disarm('session', 'page'); expect(redactor.redact('session', 'page', '918 819')).toBe('918 819');
});
