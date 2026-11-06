import { afterEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DecisionPolicyNotice } from './DecisionPolicyNotice';
import { browserDecisionPolicy } from '../lib/decision-policy';
import { invalidateClientLifetime } from '../lib/client-lifetime';

let root: Root | undefined;
afterEach(() => { if (root) flushSync(() => root?.unmount()); root = undefined; browserDecisionPolicy.reset(); });
function mount() {
  browserDecisionPolicy.reset();
  const container = document.createElement('div');
  root = createRoot(container);
  flushSync(() => root?.render(<DecisionPolicyNotice />));
  return container;
}
function observe(policy: string, reason: string | null) {
  flushSync(() => browserDecisionPolicy.observe(new Headers({
    'x-goodvibes-decision-policy': JSON.stringify({ policy, operation: reason === null ? 'decision' : 'classic', reason, revision: 0 }),
  })));
}

test('Classic is visible with permission and verification limits, and clears when the client identity changes', () => {
  const container = mount();
  expect(container.textContent).toBe('');
  observe('Classic - Off', 'selected');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Classic - Off: decision models are disabled.');
  expect(container.textContent).toContain('Tools follow owner permission rules.');
  expect(container.textContent).toContain('Responses have no independent semantic verification.');
  flushSync(() => invalidateClientLifetime());
  expect(container.textContent).toBe('');
});

test('Preferred fallback is distinguished from an enabled Default policy and malformed observations', () => {
  const container = mount();
  observe('Preferred', 'unavailable');
  expect(container.textContent).toContain('Preferred: decision models were unavailable; this operation used Classic.');
  observe('Default - On', 'unavailable');
  expect(container.textContent).toContain('Preferred:');
  observe('Default - On', null);
  expect(container.textContent).toBe('');
});
