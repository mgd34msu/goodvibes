/**
 * LibraryView: the page header, the one search field, the tab switch with the Review count,
 * and Add memory as the primary action opening a dialog that saves through memory.records.add.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { flushSync } from 'react-dom';
import { click, fakeRecord, renderInto, searchResult, waitFor } from './test-harness';

const adds: unknown[] = [];
let addGate: Promise<void> | null = null;
let addFails = false;
const searches: unknown[] = [];
let memoryServed = true;

mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  VIBE_PERSONA_TAG: 'vibe',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string) => Promise.resolve(
    method === 'knowledge.candidates.list'
      ? { candidates: [{ id: 'c1', candidateType: 'promotion', status: 'pending', title: 'Candidate', score: 0.5 }] }
      : { sources: [], nodes: [], issues: [], targets: [], tasks: [] },
  ),
  client: {
    knowledge: { status: () => Promise.resolve({}), map: () => Promise.resolve({}) },
    operator: {
      memory: {
        search: (input: unknown) => {
          searches.push(input);
          if (!memoryServed) return Promise.reject(Object.assign(new Error('Method not found'), { status: 404, code: 'METHOD_NOT_FOUND' }));
          return Promise.resolve(searchResult([fakeRecord()]));
        },
        reviewQueue: () => Promise.resolve({ records: [fakeRecord({ id: 'r2', summary: 'Queued' })] }),
        consolidation: {
          receipts: () => Promise.resolve({
            receipts: [],
            pendingProposals: [{ kind: 'contradiction', ids: ['r2'], route: '', reason: 'Two records disagree' }],
          }),
        },
        add: async (input: unknown) => {
          adds.push(input);
          if (addGate) await addGate;
          if (addFails) throw new Error('could not save');
          return { record: fakeRecord() };
        },
      },
    },
  },
}));

const { LibraryView } = await import('./LibraryView');

afterEach(() => {
  adds.length = 0;
  addGate = null;
  addFails = false;
  searches.length = 0;
  memoryServed = true;
});

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
  flushSync(() => { input.dispatchEvent(new window.Event('input', { bubbles: true })); });
}

describe('LibraryView', () => {
  test('the Review tab counts every row waiting there', async () => {
    const tabs: string[] = [];
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: (t: string) => { tabs.push(t); } }));
    await waitFor(() => (el.textContent ?? '').includes('The daemon is the single writer'));
    // One queued record, one pending proposal, one undecided candidate.
    await waitFor(() => [...el.querySelectorAll('[role="radio"]')].some((r) => r.textContent?.includes('3')));
    unmount();
  });

  test('typing in the search field searches memory with that text', async () => {
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    await waitFor(() => searches.length > 0);
    setValue(el.querySelector('input[type="search"]') as HTMLInputElement, 'daemon');
    await waitFor(() => searches.some((s) => (s as { query?: string }).query === 'daemon'));
    unmount();
  });

  test('Add memory opens a dialog and saves type, scope and summary through memory.records.add', async () => {
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add memory'));
    await waitFor(() => Boolean(document.body.querySelector('[role="dialog"]')));
    setValue(document.body.querySelector('input[aria-label="Memory summary"]') as HTMLInputElement, 'A brand new fact');
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Add memory'));
    await waitFor(() => adds.length === 1);
    expect(adds[0]).toEqual({ cls: 'fact', scope: 'project', summary: 'A brand new fact' });
    unmount();
  });

  test('a daemon that does not serve memory gets no Add memory action, since adding could only fail', async () => {
    memoryServed = false;
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    const addButton = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add memory');
    await waitFor(() => searches.length > 0 && addButton() === undefined);
    expect(addButton()).toBeUndefined();
    unmount();
  });

  test('a late add success does not close a dialog the operator reopened meanwhile', async () => {
    let release!: () => void;
    addGate = new Promise<void>((resolve) => { release = resolve; });
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    const headerAdd = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add memory');
    const dialog = () => document.body.querySelector('[role="dialog"]');
    await waitFor(() => headerAdd() !== undefined);
    click(headerAdd());
    await waitFor(() => Boolean(dialog()));
    setValue(document.body.querySelector('input[aria-label="Memory summary"]') as HTMLInputElement, 'First fact');
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Add memory'));
    await waitFor(() => adds.length === 1);

    // Cancel while the save is in flight, then open the dialog again.
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel'));
    await waitFor(() => !dialog());
    click(headerAdd());
    await waitFor(() => Boolean(dialog()));

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    flushSync(() => {});
    expect(dialog()).not.toBeNull();
    unmount();
  });

  test('reopening the dialog after a failed save starts without the stale error', async () => {
    addFails = true;
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    const headerAdd = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add memory');
    const dialog = () => document.body.querySelector('[role="dialog"]');
    await waitFor(() => headerAdd() !== undefined);
    click(headerAdd());
    await waitFor(() => Boolean(dialog()));
    setValue(document.body.querySelector('input[aria-label="Memory summary"]') as HTMLInputElement, 'Fact');
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Add memory'));
    await waitFor(() => (dialog()?.textContent ?? '').includes('could not save'));

    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel'));
    await waitFor(() => !dialog());
    click(headerAdd());
    await waitFor(() => Boolean(dialog()));
    expect(dialog()?.textContent ?? '').not.toContain('could not save');
    unmount();
  });
});
