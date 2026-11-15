import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ToastProvider } from '../../lib/toast';

const removed: string[] = [];
mock.module('../../lib/stepup', () => ({
  stepUpAvailability: () => ({ supported: true }),
  getRegisteredCredential: () => null,
  setRegisteredCredential: () => {},
  clearRegisteredCredential: () => {},
  describeStepUpError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  runAssertion: () => Promise.reject(new Error('unused')),
  registerPasskey: () =>
    Promise.resolve({ rpId: 'localhost', origin: 'http://localhost', credentialId: 'cred', publicKeyCose: new Uint8Array(), signCount: 0 }),
}));
mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  client: {
    operator: {
      stepup: {
        registerCredential: () => Promise.reject(new Error('Daemon refused the credential.')),
        listCredentials: () => Promise.resolve({ credentials: [{ credentialId: 'cred-lost-phone', label: 'Lost phone', createdAt: 1, signCount: 0 }] }),
        removeCredential: (id: string) => { removed.push(id); return Promise.resolve({ credentialId: id, removed: true }); },
      },
    },
  },
}));
const { StepUpSettings } = await import('./StepUpSettings');

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('StepUpSettings registration', () => {
  test('a daemon refusal after the passkey was created says an unused passkey now exists on the device', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<ToastProvider><StepUpSettings /></ToastProvider>));
    cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Register a passkey')!;
    flushSync(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Daemon refused the credential.');
    expect(alert).toContain('A passkey was already created on this device');
  });

  test('a passkey the daemon holds is listed and removing it calls the daemon with its id', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<ToastProvider><StepUpSettings /></ToastProvider>));
    cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
    expect(container.textContent).toContain('Lost phone');
    const remove = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    flushSync(() => remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removed).toEqual(['cred-lost-phone']);
  });
});
