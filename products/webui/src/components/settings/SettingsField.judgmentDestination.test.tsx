import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ConfigFieldModel } from '../../lib/settings-model';
import { SettingsField } from './SettingsField';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function render(field: ConfigFieldModel, onCommit: (key: string, value: unknown) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<SettingsField field={field} onCommit={onCommit} />));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  return container;
}

const endpoint: ConfigFieldModel = {
  key: 'judgment.endpoint', type: 'string', default: 'https://old.example/decide', liveValue: 'https://old.example/decide',
  present: true, description: '', isSecret: false, daemonOwned: false,
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe('judgment endpoint change', () => {
  test('a refused endpoint write after the credential reset tells the user the source was reset', async () => {
    const writes: string[] = [];
    const container = render(endpoint, async (key) => {
      writes.push(key);
      if (key === 'judgment.endpoint') throw new Error('Invalid endpoint');
    });
    const input = container.querySelector('input')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://new.example/decide');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await settle();
    expect(writes).toEqual(['judgment.keySource', 'judgment.endpoint']);
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('credential source was reset to none');
    expect(alert).toContain('Invalid endpoint');
  });

  test('a refused reset leaves the endpoint unwritten and reports the plain error', async () => {
    const writes: string[] = [];
    const container = render(endpoint, async (key) => {
      writes.push(key);
      throw new Error('offline');
    });
    const input = container.querySelector('input')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://new.example/decide');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await settle();
    expect(writes).toEqual(['judgment.keySource']);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('offline');
  });
});
