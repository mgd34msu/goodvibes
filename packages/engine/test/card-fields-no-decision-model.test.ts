/**
 * With no decision model, a page snapshot reports a form control's value only
 * when its input type cannot hold card material. A select (an expiry) and an
 * input with an unknown or misspelt type (a text box to a browser) keep their
 * value back, so a typed card number never reaches the model.
 *
 * The real classifier and policy dispatch; the policy reads "no decision model
 * set", as on an install that never chose one.
 */
import { expect, test } from 'bun:test';
import { installDecisionModelPolicyObserver } from '../errors/src/decision-policy.js';
import { classifyCardFields, type FormControlDescriptor } from '../platform/src/platform/security/card-fields.js';

installDecisionModelPolicyObserver(() => ({ policy: 'Hybrid', operation: 'no-decision-model', reason: 'not-set', revision: 1 }));

function control(tag: string, type: string, name: string): FormControlDescriptor {
  return { tag, type, name, autocomplete: '', id: '', placeholder: '', ariaLabel: '', label: '' };
}

test('with no decision model only controls that cannot hold card material report their value', async () => {
  const decisions = await classifyCardFields([
    control('select', '', 'exp-month'),
    control('input', 'creditcard', 'pan'),
    control('input', 'numeric', 'number'),
    control('input', 'text', 'card'),
    control('textarea', '', 'notes'),
    control('input', 'email', 'email'),
    control('input', 'checkbox', 'save'),
  ]);
  expect(decisions).toEqual([
    'no-decision-model', 'no-decision-model', 'no-decision-model', 'no-decision-model', 'no-decision-model',
    'reported', 'reported',
  ]);
});
