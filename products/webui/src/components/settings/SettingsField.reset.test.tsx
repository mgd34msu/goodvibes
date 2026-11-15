import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ConfigFieldModel } from '../../lib/settings-model';
import { SettingsField } from './SettingsField';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function render(field: ConfigFieldModel, onReset?: (key: string) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(
    <SettingsField field={field} onCommit={async () => {}} {...(onReset ? { onReset } : {})} />,
  ));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  return {
    container,
    reset: () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reset to default'),
  };
}

const field = (overrides: Partial<ConfigFieldModel> = {}): ConfigFieldModel => ({
  key: 'display.collapseThreshold', type: 'number', default: 30, liveValue: 50, present: true, description: '',
  isSecret: false, daemonOwned: true, ...overrides,
});

test('a value that differs from its default offers a reset that asks the daemon to remove it', async () => {
  const asked: string[] = [];
  const view = render(field(), async (key) => { asked.push(key); });
  view.reset()!.click();
  await Promise.resolve();
  expect(asked).toEqual(['display.collapseThreshold']);
});

test('a refused reset is shown on the row', async () => {
  const view = render(field(), async () => { throw new Error('The host cannot reset this setting.'); });
  view.reset()!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('The host cannot reset this setting.');
});

test('no reset is offered for a default value, a secret, or when the page cannot reset', () => {
  const reset = async () => {};
  expect(render(field({ liveValue: 30 }), reset).reset()).toBeUndefined();
  expect(render(field({ present: false }), reset).reset()).toBeUndefined();
  expect(render(field({ isSecret: true, type: 'string', default: '', liveValue: 'x' }), reset).reset()).toBeUndefined();
  expect(render(field()).reset()).toBeUndefined();
});
