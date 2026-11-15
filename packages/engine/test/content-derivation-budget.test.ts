import { expect, test } from 'bun:test';
import { JudgmentError } from '@goodvibes-jev/judgment';
import {
  MAX_DERIVATION_CHARS,
  derivationView,
  exceedsDerivationBudget,
} from '../platform/src/platform/security/batteries/content-derivation.js';

const source = { surface: 'email', origin: 'a@example.com', text: 'short' };

test('an over-long outgoing field is refused with its name, size and the next step', () => {
  const text = 'x'.repeat(MAX_DERIVATION_CHARS + 1);
  let error: unknown;
  try { derivationView('body', text, source); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(JudgmentError);
  const message = (error as Error).message;
  expect(message).toContain(`outgoing body field is ${MAX_DERIVATION_CHARS + 1} characters`);
  expect(message).toContain('send it in parts');
  expect(message).not.toContain('xxxx');
});

test('an over-long source is refused naming where it was read', () => {
  expect(() => derivationView('body', 'ok', { ...source, text: 'y'.repeat(MAX_DERIVATION_CHARS + 1) })).toThrow('content read from email');
});

test('the budget check agrees with the refusal at the limit', () => {
  const atLimit = 'x'.repeat(MAX_DERIVATION_CHARS);
  expect(exceedsDerivationBudget({ body: atLimit }, [source])).toBe(false);
  expect(exceedsDerivationBudget({ body: atLimit + 'x' }, [source])).toBe(true);
  expect(exceedsDerivationBudget({ body: undefined }, [{ text: atLimit + 'x' }])).toBe(true);
  expect(() => derivationView('body', atLimit, source)).not.toThrow();
});
