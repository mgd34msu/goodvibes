import { expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DecisionRouterEditor } from './DecisionRouterEditor';

// Every field of the routing draft is locked while it saves: an edit typed then
// would otherwise be dropped without a trace.
test('the routing context fields are locked while a save is in flight', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['models'], { providers: [{ id: 'answer', name: 'Answer', models: [{ id: 'general', registryKey: 'answer:general' }] }] });
  const el = document.createElement('div'); document.body.appendChild(el); const root = createRoot(el);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  flushSync(() => root.render(<QueryClientProvider client={client}><DecisionRouterEditor
    value={{ categories: { general: { target: { provider: 'answer', model: 'general' } } } }} onCommit={() => held} /></QueryClientProvider>));
  try {
    const general = el.querySelector('[aria-label="General model"]') as HTMLInputElement;
    flushSync(() => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(general, 'replacement'); general.dispatchEvent(new window.Event('input', { bubbles: true })); });
    const save = [...el.querySelectorAll('button')].find(button => button.textContent === 'Save routing')!;
    flushSync(() => save.click());
    await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {});
    for (const label of ['Initial routing context (characters)', 'Expanded routing context (characters)']) {
      expect((el.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).disabled).toBe(true);
    }
    finish(); await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {});
    expect((el.querySelector('[aria-label="Initial routing context (characters)"]') as HTMLInputElement).disabled).toBe(false);
  } finally { finish(); flushSync(() => root.unmount()); el.remove(); client.clear(); }
});
