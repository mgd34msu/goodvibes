/**
 * JudgmentFallbackEditor, the draft behaviours an operator feels: a stale
 * save notice clears once they act on it, and a half-typed Advanced JSON
 * buffer is never overwritten by the row controls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { JudgmentFallbackEditor } from './JudgmentFallbackEditor';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  document.body.innerHTML = '';
});

function render(value: unknown): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(JudgmentFallbackEditor, { value, onCommit: () => Promise.resolve() }));
  });
  mounted.push(() => {
    flushSync(() => root.unmount());
    container.remove();
  });
  return container;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function click(el: Element): void {
  flushSync(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function typeInto(el: HTMLTextAreaElement, text: string): void {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('JudgmentFallbackEditor', () => {
  test('the save notice for a concealed stored value clears once a fallback is added', () => {
    const el = render(undefined);
    click(button(el, 'Save'));
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    click(button(el, 'Add fallback'));
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelectorAll('fieldset')).toHaveLength(1);
  });

  test('Add fallback is unavailable while the Advanced JSON is not valid, and the text is kept', () => {
    const el = render([]);
    const area = el.querySelector('textarea[aria-label="judgment.fallbacks"]') as HTMLTextAreaElement;
    typeInto(area, '[{"model": ');
    const add = button(el, 'Add fallback');
    expect(add.disabled).toBe(true);
    click(add);
    expect((el.querySelector('textarea[aria-label="judgment.fallbacks"]') as HTMLTextAreaElement).value).toBe('[{"model": ');
    typeInto(area, '[]');
    expect(button(el, 'Add fallback').disabled).toBe(false);
  });
});
