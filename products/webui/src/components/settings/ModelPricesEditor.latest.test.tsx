import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ModelPricesEditor } from './ModelPricesEditor';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function render(props: React.ComponentProps<typeof ModelPricesEditor>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<ModelPricesEditor {...props} />));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  return container;
}
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}
function click(el: Element | null): void {
  flushSync(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

const SHOWN = { 'a:one': { input: 1, output: 2 }, 'a:two': { input: 3, output: 4 } };
const DAEMON = { ...SHOWN, 'b:added-elsewhere': { input: 5, output: 6 } };

describe('ModelPricesEditor against the daemon table', () => {
  test('removing a row keeps a price another client added since the last refresh', async () => {
    const commits: Record<string, unknown>[] = [];
    const el = render({
      value: SHOWN,
      onCommit: async (next) => { commits.push(next); },
      readLatest: async () => DAEMON,
    });
    click(el.querySelector('[aria-label="Remove price for a:one"]'));
    await settle();
    expect(Object.keys(commits[0]!).sort()).toEqual(['a:two', 'b:added-elsewhere']);
  });

  test('a failed read of the current table writes nothing and says so', async () => {
    const commits: Record<string, unknown>[] = [];
    const el = render({
      value: SHOWN,
      onCommit: async (next) => { commits.push(next); },
      readLatest: async () => { throw new Error('offline'); },
    });
    click(el.querySelector('[aria-label="Remove price for a:one"]'));
    await settle();
    expect(commits).toEqual([]);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('nothing was changed');
  });
});
