import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DateField } from './DateField';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function render(initial: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes: string[] = [];
  function Host() {
    const [value, setValue] = React.useState(initial);
    return <DateField value={value} onChange={(next) => { changes.push(next); setValue(next); }} aria-label="Due" />;
  }
  flushSync(() => root.render(<Host />));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  return { input: container.querySelector('input')!, changes };
}
function type(input: HTMLInputElement, text: string): void {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function blur(input: HTMLInputElement): void {
  flushSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

describe('DateField unparseable text', () => {
  test('stays visible and invalid after blur instead of reverting to the older date', () => {
    const { input, changes } = render('2026-05-01');
    type(input, '2026-13-45');
    blur(input);
    expect(input.value).toBe('2026-13-45');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.validity.valid).toBe(false);
    expect(changes).toEqual([]);
  });

  test('typing a real date afterwards is accepted and clears the invalid state', () => {
    const { input, changes } = render('2026-05-01');
    type(input, '2026-13-45');
    blur(input);
    type(input, '2026-06-02');
    blur(input);
    expect(changes).toEqual(['2026-06-02']);
    expect(input.value).toBe('2026-06-02');
    expect(input.validity.valid).toBe(true);
  });
});
