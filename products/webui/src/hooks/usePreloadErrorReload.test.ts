import { describe, expect, test } from 'bun:test';
import { installPreloadErrorReload, PRELOAD_RELOAD_WINDOW_MS } from './usePreloadErrorReload';

function harness(initial: string | null = null, storage: { readable: boolean } = { readable: true }) {
  const listeners = new Map<string, (event: Event) => void>();
  let stored = initial;
  let clock = 1_000_000;
  let reloads = 0;
  const dispose = installPreloadErrorReload({
    target: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => { listeners.set(type, listener as (event: Event) => void); },
      removeEventListener: (type: string) => { listeners.delete(type); },
    },
    now: () => clock,
    reload: () => { reloads += 1; },
    read: () => (storage.readable ? stored : null),
    write: (value) => { if (!storage.readable) return false; stored = value; return true; },
  });
  const fire = (): Event => {
    const event = new Event('vite:preloadError', { cancelable: true });
    listeners.get('vite:preloadError')?.(event);
    return event;
  };
  return { fire, dispose, listeners, reloads: () => reloads, advance: (ms: number) => { clock += ms; } };
}

describe('installPreloadErrorReload', () => {
  test('the first failed chunk reloads once and cancels the failed import', () => {
    const h = harness();
    const event = h.fire();
    expect(h.reloads()).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test('a second failure inside the window does not reload again', () => {
    const h = harness();
    h.fire();
    h.advance(PRELOAD_RELOAD_WINDOW_MS - 1);
    const event = h.fire();
    expect(h.reloads()).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });

  test('a failure after the window is a new upgrade and reloads again', () => {
    const h = harness();
    h.fire();
    h.advance(PRELOAD_RELOAD_WINDOW_MS);
    h.fire();
    expect(h.reloads()).toBe(2);
  });

  test('when the record cannot be stored no reload happens, so an unreadable store cannot loop', () => {
    const h = harness(null, { readable: false });
    const first = h.fire();
    const second = h.fire();
    expect(h.reloads()).toBe(0);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
  });

  test('disposing removes the listener', () => {
    const h = harness();
    h.dispose();
    expect(h.listeners.size).toBe(0);
  });
});
