/**
 * Tests for useUrlState hook.
 * Uses react-dom/client + flushSync + happy-dom (bunfig.toml preload).
 *
 * CRITICAL StrictMode coverage: each setter must push exactly ONE history
 * entry even under React StrictMode (which double-invokes state updaters).
 *
 * Note on popstate dispatching:
 *   happy-dom installs its Event class at globalThis.Event, but bun's native
 *   globalThis.dispatchEvent() rejects non-native Event objects. To avoid this
 *   we intercept window.addEventListener before hook mount to capture the
 *   popstate handler, then call it directly after mutating the URL.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useUrlState } from './useUrlState';
import type { UseUrlStateReturn } from './useUrlState';

// ---------------------------------------------------------------------------
// Hook harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function HookOwner({ onHandle }: { onHandle: (h: UseUrlStateReturn) => void }): null {
  const handle = useUrlState();
  React.useLayoutEffect(() => { onHandle(handle); });
  return null;
}

function renderHook(
  strict = false,
): { getHandle: () => UseUrlStateReturn; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let handle!: UseUrlStateReturn;
  const ui = <HookOwner onHandle={(h) => { handle = h; }} />;
  flushSync(() => {
    root.render(strict ? <StrictMode>{ui}</StrictMode> : ui);
  });
  // Unmounted in afterEach so a failed assertion cannot leave the root mounted.
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => { root.unmount(); });
    if (container.parentNode) container.parentNode.removeChild(container);
  };
  cleanups.push(unmount);
  return { getHandle: () => handle, unmount };
}

// ---------------------------------------------------------------------------
// Spy helpers for history
// ---------------------------------------------------------------------------

let pushCallCount = 0;
let replaceCallCount = 0;
let _originalPush: typeof window.history.pushState;
let _originalReplace: typeof window.history.replaceState;

function installSpies(): void {
  pushCallCount = 0;
  replaceCallCount = 0;
  _originalPush = window.history.pushState.bind(window.history);
  _originalReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = (
    state: unknown,
    title: string,
    url?: string | URL | null,
  ) => {
    pushCallCount++;
    _originalPush(state, title, url);
  };
  window.history.replaceState = (
    state: unknown,
    title: string,
    url?: string | URL | null,
  ) => {
    replaceCallCount++;
    _originalReplace(state, title, url);
  };
}

function removeSpies(): void {
  if (_originalPush) window.history.pushState = _originalPush;
  if (_originalReplace) window.history.replaceState = _originalReplace;
}

// ---------------------------------------------------------------------------
// popstate helper
// ---------------------------------------------------------------------------

/**
 * Wraps a test that needs to simulate popstate. Because bun's native
 * globalThis.dispatchEvent() rejects happy-dom Event instances, we intercept
 * window.addEventListener BEFORE the hook mounts so we can capture and
 * directly invoke the popstate handler without going through dispatchEvent.
 *
 * Usage:
 *   withPopstateTrap((hook, triggerPopstate) => {
 *     // ... call setters, mutate URL ...
 *     triggerPopstate(); // calls the captured handler directly
 *   });
 */
function withPopstateTrap(
  fn: (hook: { getHandle: () => UseUrlStateReturn; unmount: () => void }, trigger: () => void) => void,
  strict = false,
): void {
  let capturedHandler: (() => void) | null = null;
  const origAdd = window.addEventListener.bind(window);

  // Temporarily override addEventListener to sniff the popstate registration
  (window as unknown as Record<string, unknown>).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: unknown,
  ) => {
    if (type === 'popstate') {
      capturedHandler = handler as () => void;
    }
    origAdd(type, handler as EventListener, options as AddEventListenerOptions);
  };

  const hook = renderHook(strict);

  // Restore after hook mount
  (window as unknown as Record<string, unknown>).addEventListener = origAdd;

  fn(hook, () => {
    if (capturedHandler) {
      flushSync(() => { (capturedHandler as () => void)(); });
    }
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  installSpies();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  removeSpies();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useUrlState: initial state', () => {
  test('defaults to chat when no view param', () => {
    const { getHandle } = renderHook();
    expect(getHandle().view).toBe('chat');
  });

  test('decodes view from URL', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=library&tab=knowledge');
    installSpies();
    const { getHandle } = renderHook();
    expect(getHandle().view).toBe('library');
    expect(getHandle().tab).toBe('knowledge');
  });

  test('decodes session from URL', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&session=abc-123');
    installSpies();
    const { getHandle } = renderHook();
    expect(getHandle().session).toBe('abc-123');
  });

  test('decodes filters from URL', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Bstatus%5D=active');
    installSpies();
    const { getHandle } = renderHook();
    expect(getHandle().filters).toEqual({ status: 'active' });
  });
});

// ---------------------------------------------------------------------------
// setView
// ---------------------------------------------------------------------------

describe('useUrlState: setView', () => {
  test('updates view in returned state', () => {
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setView('work'); });
    expect(getHandle().view).toBe('work');
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setView('library'); });
    expect(pushCallCount).toBe(1);
  });

  test('STRICTMODE: setView adds exactly ONE history entry under React.StrictMode', () => {
    const { getHandle } = renderHook(true);
    pushCallCount = 0;
    flushSync(() => { getHandle().setView('personal'); });
    expect(pushCallCount).toBe(1);
  });

  test('replace option uses replaceState instead of pushState', () => {
    const { getHandle } = renderHook();
    pushCallCount = 0;
    replaceCallCount = 0;
    flushSync(() => { getHandle().setView('work', { replace: true }); });
    expect(pushCallCount).toBe(0);
    expect(replaceCallCount).toBeGreaterThanOrEqual(1);
  });

  test('preserves session and filters when changing view', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&session=s1&filter%5Ba%5D=1');
    installSpies();
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setView('work'); });
    expect(getHandle().session).toBe('s1');
    expect(getHandle().filters).toEqual({ a: '1' });
  });
});

describe('useUrlState: destination tabs', () => {
  test('setTab replaces the history entry and keeps the view', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=work');
    installSpies();
    const { getHandle } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setTab('agents'); });
    expect(getHandle().view).toBe('work');
    expect(getHandle().tab).toBe('agents');
    expect(pushCallCount).toBe(0);
    expect(window.location.search).toContain('tab=agents');
  });

  test('moving to another view drops the tab, unless one is given', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=work&tab=agents');
    installSpies();
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setView('library'); });
    expect(getHandle().tab).toBeUndefined();
    flushSync(() => { getHandle().setView('personal', { tab: 'mail' }); });
    expect(getHandle().tab).toBe('mail');
  });

  test('an old data-view link is rewritten in place to its destination, keeping the fragment', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=fleet#fleet-node=n1');
    installSpies();
    const { getHandle } = renderHook();
    expect(getHandle().view).toBe('work');
    expect(getHandle().tab).toBe('all');
    expect(window.location.search).toBe('?view=work&tab=all');
    expect(window.location.hash).toBe('#fleet-node=n1');
  });
});

// ---------------------------------------------------------------------------
// setSession
// ---------------------------------------------------------------------------

describe('useUrlState: setSession', () => {
  test('updates session in returned state', () => {
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setSession('sess-xyz'); });
    expect(getHandle().session).toBe('sess-xyz');
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setSession('s1'); });
    expect(pushCallCount).toBe(1);
  });

  test('STRICTMODE: setSession adds exactly ONE history entry under React.StrictMode', () => {
    const { getHandle } = renderHook(true);
    pushCallCount = 0;
    flushSync(() => { getHandle().setSession('strict-sess'); });
    expect(pushCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setFilters
// ---------------------------------------------------------------------------

describe('useUrlState: setFilters', () => {
  test('merges new filter keys into existing filters', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Ba%5D=1');
    installSpies();
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setFilters({ b: '2' }); });
    expect(getHandle().filters).toEqual({ a: '1', b: '2' });
  });

  test('removes filter key when value is undefined', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Ba%5D=1&filter%5Bb%5D=2');
    installSpies();
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setFilters({ a: undefined }); });
    expect(getHandle().filters).toEqual({ b: '2' });
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setFilters({ q: 'hello' }); });
    expect(pushCallCount).toBe(1);
  });

  test('STRICTMODE: setFilters adds exactly ONE history entry under React.StrictMode', () => {
    const { getHandle } = renderHook(true);
    pushCallCount = 0;
    flushSync(() => { getHandle().setFilters({ q: 'strict' }); });
    expect(pushCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resetFilters
// ---------------------------------------------------------------------------

describe('useUrlState: resetFilters', () => {
  test('replaces entire filters object', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Bold%5D=x');
    installSpies();
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().resetFilters({ fresh: 'yes' }); });
    expect(getHandle().filters).toEqual({ fresh: 'yes' });
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().resetFilters({ x: '1' }); });
    expect(pushCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setUrlState
// ---------------------------------------------------------------------------

describe('useUrlState: setUrlState', () => {
  test('merges partial state', () => {
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setUrlState({ view: 'work', session: 'x' }); });
    expect(getHandle().view).toBe('work');
    expect(getHandle().session).toBe('x');
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setUrlState({ view: 'work' }); });
    expect(pushCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// settings dialog param
// ---------------------------------------------------------------------------

describe('useUrlState: the settings dialog section', () => {
  test('setUrlState opens and closes the dialog through ?settings=', () => {
    const { getHandle } = renderHook();
    flushSync(() => { getHandle().setUrlState({ settings: 'models' }); });
    expect(getHandle().settings).toBe('models');
    expect(window.location.search).toContain('settings=models');
    flushSync(() => { getHandle().setUrlState({ settings: '' }); });
    expect(window.location.search).not.toContain('settings=');
  });

  test('an old ?view=admin link is rewritten to the chat view with Account open', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=admin');
    installSpies();
    const { getHandle } = renderHook();
    expect(getHandle().view).toBe('chat');
    expect(getHandle().settings).toBe('account');
    expect(window.location.search).toContain('settings=account');
    expect(window.location.search).not.toContain('view=admin');
  });
});

// ---------------------------------------------------------------------------
// popstate (back/forward navigation)
// ---------------------------------------------------------------------------

describe('useUrlState: popstate', () => {
  test('popstate event updates state to new URL', () => {
    withPopstateTrap((hook, triggerPopstate) => {
      const { getHandle } = hook;
      window.history.pushState(null, '', '/?view=library&session=s99');
      triggerPopstate();
      expect(getHandle().view).toBe('library');
      expect(getHandle().session).toBe('s99');
    });
  });

  test('unmount removes the same popstate listener the hook registered', () => {
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    const target = window as unknown as Record<string, unknown>;
    target.addEventListener = (type: string, handler: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'popstate') added.push(handler);
      origAdd(type, handler as EventListener, options as AddEventListenerOptions);
    };
    target.removeEventListener = (type: string, handler: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'popstate') removed.push(handler);
      origRemove(type, handler as EventListener, options as EventListenerOptions);
    };
    try {
      const { unmount } = renderHook();
      expect(added).toHaveLength(1);
      expect(removed).toHaveLength(0);
      unmount();
    } finally {
      target.addEventListener = origAdd;
      target.removeEventListener = origRemove;
    }
    expect(removed).toEqual(added);
  });

  test('no feedback loop: handling popstate does not push a new history entry', () => {
    withPopstateTrap((hook, triggerPopstate) => {
      
      window.history.pushState(null, '', '/?view=library');
      pushCallCount = 0;
      triggerPopstate();
      expect(pushCallCount).toBe(0);
    });
  });
});


describe('useUrlState: chat selection generation', () => {
  test('batched away-and-back selection retires the original generation', () => {
    const { getHandle } = renderHook(true);
    flushSync(() => { getHandle().setSession('session-a'); });
    const tracker = getHandle().chatSelection;
    const original = tracker.capture();
    flushSync(() => {
      getHandle().setSession('session-b');
      expect(tracker.isCurrent(original)).toBe(false);
      getHandle().setSession('session-a');
    });
    expect(getHandle().session).toBe('session-a');
    expect(tracker.isCurrent(original)).toBe(false);
    expect(tracker.capture().sessionId).toBe('session-a');
  });

  test('a new draft retires a previous draft even though both have no session ID', () => {
    const { getHandle } = renderHook();
    const original = getHandle().chatSelection.capture();
    flushSync(() => { getHandle().setUrlState({ view: 'chat', session: '' }); });
    expect(getHandle().chatSelection.isCurrent(original)).toBe(false);
  });

  test('settings, tabs and filters preserve the current chat selection', () => {
    const { getHandle } = renderHook();
    const original = getHandle().chatSelection.capture();
    flushSync(() => { getHandle().setUrlState({ settings: 'models' }); });
    flushSync(() => { getHandle().setFilters({ kind: 'user' }); });
    flushSync(() => { getHandle().setTab(''); });
    expect(getHandle().chatSelection.isCurrent(original)).toBe(true);
  });

  test('leaving the chat view and returning retires the original selection', () => {
    const { getHandle } = renderHook();
    const original = getHandle().chatSelection.capture();
    flushSync(() => { getHandle().setView('work'); });
    flushSync(() => { getHandle().setView('chat'); });
    expect(getHandle().chatSelection.isCurrent(original)).toBe(false);
  });

  test('actual back/forward observations retire a prior same-ID selection', () => {
    withPopstateTrap(({ getHandle }, trigger) => {
      const original = getHandle().chatSelection.capture();
      window.history.pushState(null, '', '/?view=chat&session=other');
      trigger();
      window.history.pushState(null, '', '/?view=chat');
      trigger();
      expect(getHandle().chatSelection.isCurrent(original)).toBe(false);
    });
  });
});
