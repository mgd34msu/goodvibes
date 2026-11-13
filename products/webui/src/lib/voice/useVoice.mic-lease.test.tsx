/**
 * useVoiceInput, the exclusive microphone lease. A cancel or unmount that lands
 * while acquireExclusive() is still pending must not leave the lease held: a leaked
 * lease keeps wake stood down and hangs every later acquire.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useVoiceInput, type UseVoiceInputResult } from './useVoice';
import { micArbiter, type MicLease } from './mic-arbiter';

const originalAcquire = micArbiter.acquireExclusive;
const originalOpen = micArbiter.openCapture;
const originalFetch = globalThis.fetch;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let released = 0;
let opens = 0;
let acquires = 0;
let grant!: (lease: MicLease) => void;

beforeEach(() => {
  released = 0;
  opens = 0;
  acquires = 0;
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  micArbiter.acquireExclusive = () => {
    acquires += 1;
    return new Promise<MicLease>((resolve) => { grant = resolve; });
  };
  (micArbiter as { openCapture: typeof micArbiter.openCapture }).openCapture = (() => {
    opens += 1;
    return Promise.resolve({ label: 'mic', deviceSelectable: true, stop: () => Promise.resolve() });
  }) as typeof micArbiter.openCapture;
});

afterEach(() => {
  micArbiter.acquireExclusive = originalAcquire;
  (micArbiter as { openCapture: typeof micArbiter.openCapture }).openCapture = originalOpen;
  globalThis.fetch = originalFetch;
});

function mount(): { voice: () => UseVoiceInputResult; unmount: () => void } {
  let voice!: UseVoiceInputResult;
  function Harness(): null {
    voice = useVoiceInput(() => undefined);
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['voice', 'status'], {});
  client.setQueryData(['voice', 'config'], {});
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  return { voice: () => voice, unmount: () => { act(() => root.unmount()); client.clear(); } };
}

const lease: () => MicLease = () => async () => { released += 1; };
const tick = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

test('cancel() while requesting releases the lease the moment it arrives and opens no mic', async () => {
  const harness = mount();
  let starting!: Promise<void>;
  act(() => { starting = harness.voice().start(); });
  expect(harness.voice().phase).toBe('requesting');
  act(() => harness.voice().cancel());
  expect(harness.voice().phase).toBe('idle');

  grant(lease());
  await act(async () => { await starting; });
  await tick();

  expect(released).toBe(1);
  expect(opens).toBe(0);
  expect(harness.voice().phase).toBe('idle');
  harness.unmount();
});

test('unmount while requesting releases the lease the moment it arrives and opens no mic', async () => {
  const harness = mount();
  let starting!: Promise<void>;
  act(() => { starting = harness.voice().start(); });
  harness.unmount();

  grant(lease());
  await starting;
  await tick();

  expect(released).toBe(1);
  expect(opens).toBe(0);
});

test('an uninterrupted press still records and keeps its lease until stopped', async () => {
  const harness = mount();
  let starting!: Promise<void>;
  act(() => { starting = harness.voice().start(); });
  grant(lease());
  await act(async () => { await starting; });

  expect(harness.voice().phase).toBe('recording');
  expect(opens).toBe(1);
  expect(released).toBe(0);
  act(() => harness.voice().cancel());
  await tick();
  expect(released).toBe(1);
  harness.unmount();
});

test('a second start while one is already requesting does not take a second lease', async () => {
  const harness = mount();
  act(() => { void harness.voice().start(); });
  await act(async () => { await harness.voice().start(); });
  expect(acquires).toBe(1);
  grant(lease());
  await tick();
  act(() => harness.voice().cancel());
  await tick();
  harness.unmount();
});
