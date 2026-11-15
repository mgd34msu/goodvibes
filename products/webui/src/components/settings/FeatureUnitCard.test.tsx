/**
 * FeatureUnitCard, the enablement commit: a saved toggle writes the enablement
 * key, a refused one shows the daemon's reason.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { FeatureUnitModel } from '../../lib/settings-model';
import { FeatureUnitCard } from './FeatureUnitCard';

const unit = {
  feature: {
    id: 'demo',
    name: 'Demo feature',
    description: 'A feature used by this test.',
    restartRequired: false,
    enablement: { key: 'demo.enabled', kind: 'boolean' },
  },
  enabled: false,
  explicit: true,
  enablementField: null,
  fields: [],
  daemonOwned: false,
} as unknown as FeatureUnitModel;

function render(onCommit: (key: string, value: unknown) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(FeatureUnitCard, {
      unit,
      onCommit,
      persistedByKey: {},
      pendingRestart: null,
    }));
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  if (!predicate()) throw new Error('waitFor: condition never held');
}

function toggle(el: HTMLElement): void {
  flushSync(() => el.querySelector('[aria-label="Enable Demo feature"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

describe('FeatureUnitCard enablement', () => {
  test('flipping the toggle writes the enablement key', async () => {
    const writes: [string, unknown][] = [];
    const view = render(async (key, value) => { writes.push([key, value]); });
    toggle(view.el);
    await waitFor(() => writes.length === 1);
    expect(writes).toEqual([['demo.enabled', true]]);
    expect(view.el.querySelector('[role="alert"]')).toBeNull();
    view.unmount();
  });

  test('a refused write shows the reason', async () => {
    const view = render(() => Promise.reject(new Error('daemon said no')));
    toggle(view.el);
    await waitFor(() => view.el.querySelector('[role="alert"]') !== null);
    expect(view.el.querySelector('[role="alert"]')?.textContent).toBe('daemon said no');
    view.unmount();
  });
});
