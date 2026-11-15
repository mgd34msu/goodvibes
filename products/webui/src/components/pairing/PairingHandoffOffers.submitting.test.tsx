/**
 * While the hand-off ceremony runs, dismissing the dialog would hide its
 * outcome and drop the only chance to retry from the same link, so the scrim,
 * Escape and the close control do nothing until the results are shown.
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const completeCalls: unknown[] = [];
let release!: (value: { results: { kind: string; status: string }[] }) => void;

mock.module('../../lib/goodvibes', () => ({
  client: {
    operator: {
      pairing: {
        handoff: {
          complete: (input: unknown) => {
            completeCalls.push(input);
            return new Promise((resolve) => { release = resolve as typeof release; });
          },
        },
      },
    },
  },
}));
mock.module('../../lib/push/push-client', () => ({
  ensureBrowserPushSubscription: () => Promise.resolve({ endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } }),
  ensureDeviceId: () => 'device-1',
  describePushSubscribeError: (error: unknown) => String(error),
}));
mock.module('../../lib/stepup', () => ({
  registerPasskey: () => Promise.reject(new Error('unused')),
  describeStepUpError: (error: unknown) => String(error),
  stepUpAvailability: () => ({ supported: true }),
  setRegisteredCredential: () => {},
}));

const { PairingHandoffOffers } = await import('./PairingHandoffOffers');

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  if (!predicate()) throw new Error('waitFor: condition never held');
}

describe('PairingHandoffOffers while submitting', () => {
  test('the scrim and Escape do not dismiss until the outcome is shown', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let dismissed = 0;
    flushSync(() => {
      root.render(React.createElement(PairingHandoffOffers, { offers: ['relay'], onDone: () => { dismissed += 1; } }));
    });
    const find = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    flushSync(() => find('Continue')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await waitFor(() => completeCalls.length > 0);

    flushSync(() => document.body.querySelector('.scrim')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    flushSync(() => {
      document.body.querySelector('[role="dialog"]')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dismissed).toBe(0);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    release({ results: [{ kind: 'relay', status: 'completed' }] });
    await waitFor(() => Boolean(find('Continue to the app')));
    flushSync(() => document.body.querySelector('.scrim')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(dismissed).toBe(1);
    flushSync(() => root.unmount());
    container.remove();
  });
});
