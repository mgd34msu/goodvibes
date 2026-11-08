import { expect, test } from 'bun:test';
import { SelectionModal } from '../terminal-shell/src/selection-modal.js';
import { attachSelectionModalQueue, type SelectionModalCallback } from '../terminal-shell/src/selection-modal-queue.js';

function fixture() {
  let exits = 0;
  const owner = { selectionModal: new SelectionModal(), selectionCallback: null as SelectionModalCallback | null,
    syncFeedSelectionCallback: null, modalStack: [] as string[], modalOpened(name: string) { this.modalStack.push(name); }, requestRender() {}, exitApp() { exits++; } };
  const queue = attachSelectionModalQueue(owner);
  return { owner, queue, exits: () => exits };
}

test('terminal exit cancels active and queued pickers once and prevents callback-driven readmission', () => {
  const { owner, queue, exits } = fixture();
  const cancelled: string[] = [];
  queue.request({ title: 'Active', items: [{ id: 'first', label: 'First' }], opts: undefined,
    callback(result) {
      expect(result).toBeNull(); cancelled.push('active');
      queue.request({ title: 'Reentrant', items: [], opts: undefined, callback(next) { expect(next).toBeNull(); cancelled.push('reentrant'); } });
    } });
  const old = owner.selectionCallback;
  queue.request({ title: 'Queued', items: [], opts: undefined, callback(result) { expect(result).toBeNull(); cancelled.push('queued'); } });
  owner.exitApp();
  expect(cancelled).toEqual(['active', 'reentrant', 'queued']);
  expect(owner.selectionCallback).toBeNull();
  expect(owner.selectionModal.active).toBe(false);
  expect(queue.size).toBe(0);
  expect(exits()).toBe(1);
  old?.({ item: { id: 'first', label: 'First' }, action: 'select' });
  queue.close();
  expect(cancelled).toEqual(['active', 'reentrant', 'queued']);
});

test('a throwing active callback cannot orphan queued owners or prevent the actual terminal exit', () => {
  const { owner, queue, exits } = fixture();
  let queuedCancelled = false;
  queue.request({ title: 'Active', items: [], opts: undefined, callback() { throw new Error('Fixture callback failed'); } });
  queue.request({ title: 'Queued', items: [], opts: undefined, callback(value) { expect(value).toBeNull(); queuedCancelled = true; } });
  expect(() => owner.exitApp()).toThrow(AggregateError);
  expect(queuedCancelled).toBe(true);
  expect(exits()).toBe(1);
  expect(queue.size).toBe(0);
});

test('adjustment callbacks retain ownership; a terminal answer can synchronously chain its next picker', async () => {
  const { owner, queue } = fixture();
  const results: string[] = [];
  queue.request({ title: 'First', items: [{ id: 'first', label: 'First' }], opts: undefined, callback(result) {
    results.push(result?.action ?? 'cancel');
    if (result?.action === 'select') queue.request({ title: 'Next', items: [{ id: 'next', label: 'Next' }], opts: undefined,
      callback(next) { results.push(next?.item.id ?? 'cancel-next'); } });
  } });
  const first = owner.selectionCallback;
  first?.({ item: { id: 'first', label: 'First' }, action: 'increment' });
  expect(owner.selectionModal.title).toBe('First');
  owner.selectionModal.close();
  first?.({ item: { id: 'first', label: 'First' }, action: 'select' });
  expect(owner.selectionModal.title).toBe('Next');
  first?.({ item: { id: 'first', label: 'First' }, action: 'select' });
  expect(results).toEqual(['increment', 'select']);
  owner.selectionModal.close();
  owner.selectionCallback?.({ item: { id: 'next', label: 'Next' }, action: 'select' });
  await Promise.resolve();
  expect(results).toEqual(['increment', 'select', 'next']);
});

test('retiring a queued request does not close another picker; retiring the active request advances FIFO', async () => {
  const { owner, queue } = fixture();
  const active = new AbortController(), queued = new AbortController();
  const cancelled: string[] = [];
  queue.request({ title: 'First', items: [], opts: { signal: active.signal }, callback: () => cancelled.push('first') });
  queue.request({ title: 'Retired', items: [], opts: { signal: queued.signal }, callback: () => cancelled.push('retired') });
  queue.request({ title: 'Last', items: [], opts: undefined, callback: () => cancelled.push('last') });
  queued.abort();
  expect(cancelled).toEqual(['retired']);
  expect(owner.selectionModal.title).toBe('First');
  expect(queue.size).toBe(1);
  active.abort(); await Promise.resolve();
  expect(cancelled).toEqual(['retired', 'first']);
  expect(owner.selectionModal.title).toBe('Last');
  expect(owner.modalStack).toEqual(['selection']);
  owner.exitApp();
  expect(owner.modalStack).toEqual([]);
  expect(cancelled).toEqual(['retired', 'first', 'last']);
});

test('cancellation from an open hook cannot republish an already retired callback', () => {
  const { owner } = fixture(); const abort = new AbortController();
  owner.modalOpened = () => abort.abort();
  const queue = attachSelectionModalQueue(owner); let cancelled = 0;
  queue.request({ title: 'Cancelled', items: [], opts: { signal: abort.signal }, callback: () => cancelled++ });
  expect(cancelled).toBe(1);
  expect(owner.selectionModal.active).toBe(false);
  expect(owner.selectionCallback).toBeNull();
});
