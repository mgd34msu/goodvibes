import { expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DecisionRouterEditor } from './DecisionRouterEditor';

const saved = { categories: { general: { target: { provider: 'answer', model: 'general' } } } };
function render(value: unknown = saved) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['models'], { providers: [{ id: 'answer', name: 'Answer', models: [{ id: 'general', registryKey: 'answer:general' }] }] });
  const el = document.createElement('div'); document.body.appendChild(el); const root = createRoot(el);
  const commits: unknown[] = [];
  const update = (next: unknown) => flushSync(() => root.render(<QueryClientProvider client={client}><DecisionRouterEditor value={next} onCommit={async data => { commits.push(data); }} /></QueryClientProvider>));
  update(value);
  return { el, commits, update, close: () => { flushSync(() => root.unmount()); el.remove(); client.clear(); } };
}
function input(el: Element, name: string, value: string) {
  const field = el.querySelector(`[aria-label="${name}"]`);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) throw new Error(`No input ${name}`);
  const prototype = field instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  flushSync(() => { Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value); field.dispatchEvent(new window.Event('input', { bubbles: true })); });
}
function click(el: Element, text: string) {
  const button = [...el.querySelectorAll('button')].find(button => button.textContent === text);
  if (!button) throw new Error(`Missing button ${text}`);
  flushSync(() => button.click());
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); };

test('all categories are editable and complete target changes persist without dropping empty categories', async () => {
  const view = render();
  try {
    expect(view.el.querySelectorAll('fieldset')).toHaveLength(10);
    expect(view.el.textContent).toContain('Empty categories use General');
    input(view.el, 'General model', 'replacement');
    input(view.el, 'Documentation / writing description', 'Technical guides and prose');
    click(view.el, 'Save routing'); await settle();
    expect(view.commits).toHaveLength(1);
    expect(view.commits[0]).toMatchObject({ categories: {
      general: { target: { provider: 'answer', model: 'replacement' } },
      'documentation-writing': { description: 'Technical guides and prose', target: null },
    } });
  } finally { view.close(); }
});

test('custom categories can be added and removed and require General before saving', async () => {
  const view = render({});
  try {
    input(view.el, 'Custom category id', 'legal-writing'); click(view.el, 'Add category');
    expect(view.el.querySelectorAll('fieldset')).toHaveLength(11);
    input(view.el, 'legal-writing description', 'Legal document drafting');
    click(view.el, 'Save routing'); await settle();
    expect(view.el.textContent).toContain('Choose a General provider'); expect(view.commits).toHaveLength(0);
    click(view.el, 'Remove legal-writing'); expect(view.el.querySelectorAll('fieldset')).toHaveLength(10);
  } finally { view.close(); }
});

test('a refresh cannot silently overwrite a dirty category table', async () => {
  const view = render();
  try {
    input(view.el, 'General model', 'mine');
    view.update({ categories: { general: { target: { provider: 'answer', model: 'theirs' } } } });
    expect(view.el.textContent).toContain('changed elsewhere');
    click(view.el, 'Save routing'); await settle(); expect(view.commits).toHaveLength(0);
    click(view.el, 'Use latest');
    expect((view.el.querySelector('[aria-label="General model"]') as HTMLInputElement).value).toBe('theirs');
  } finally { view.close(); }
});
