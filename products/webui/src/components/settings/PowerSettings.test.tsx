/**
 * PowerSettings, the admin Power panel. Covers the ruled shape (one toggle,
 * no timers, no AC-only sub-options), the "held because X" line, and the
 * honest lid-split note rendering verbatim when served.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

let mockStatus: {
  isPending: boolean;
  isError: boolean;
  error?: unknown;
  data?: unknown;
  refetch: () => void;
} = { isPending: false, isError: false, data: undefined, refetch: () => {} };

let mutateCalls: boolean[] = [];
let mockMutation: { isPending: boolean; isError: boolean; error?: unknown; variables?: boolean; mutate: (v: boolean) => void } = {
  isPending: false,
  isError: false,
  mutate: (v: boolean) => { mutateCalls.push(v); },
};

mock.module('../../hooks/usePowerStatus', () => ({
  usePowerStatus: () => mockStatus,
  useSetKeepAwake: () => mockMutation,
}));

const { PowerSettings } = await import('./PowerSettings');

function render(): { el: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(React.createElement(PowerSettings)); });
  return {
    el: container,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mutateCalls = [];
  mockStatus = { isPending: false, isError: false, data: undefined, refetch: () => {} };
  mockMutation = { isPending: false, isError: false, mutate: (v: boolean) => { mutateCalls.push(v); } };
});

const NOT_HELD_STATE = {
  platform: 'linux',
  work: { held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 0, capExpiresAt: null, capExpired: false },
  keepAwake: { enabled: false, held: false, grantedClasses: [], deniedClasses: [], note: null },
};

describe('PowerSettings', () => {
  test('loading state renders no toggle', () => {
    mockStatus = { isPending: true, isError: false, data: undefined, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('button[role="switch"]')).toBeNull();
    expect(el.querySelector('[aria-label="Loading power state"][aria-busy="true"]')).not.toBeNull();
  });

  test('error state renders no toggle', () => {
    mockStatus = { isPending: false, isError: true, error: new Error('boom'), data: undefined, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('button[role="switch"]')).toBeNull();
    expect(el.textContent).toContain('Power state unavailable');
  });

  test('OFF state: toggle unchecked', () => {
    mockStatus = { isPending: false, isError: false, data: NOT_HELD_STATE, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  test('the ruled shape: exactly one switch, no timer or AC-only controls', () => {
    mockStatus = { isPending: false, isError: false, data: NOT_HELD_STATE, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelectorAll('button[role="switch"]')).toHaveLength(1);
    expect(el.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(el.textContent).not.toMatch(/\bAC\b|battery|for \d+ ?(m|min|h)\b/i);
  });

  test('ON state: toggle checked, granted and denied classes shown', () => {
    mockStatus = {
      isPending: false,
      isError: false,
      data: {
        ...NOT_HELD_STATE,
        keepAwake: { enabled: true, held: true, grantedClasses: ['idle', 'sleep'], deniedClasses: ['handle-lid-switch'], note: null },
      },
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(el.textContent).toContain('idle');
    expect(el.textContent).toContain('sleep');
    expect(el.textContent).toContain('handle-lid-switch');
  });

  test('the honest lid-split note renders verbatim when served', () => {
    const note = 'idle sleep blocked; lid-close suspend is controlled by your OS here';
    mockStatus = {
      isPending: false,
      isError: false,
      data: { ...NOT_HELD_STATE, keepAwake: { enabled: true, held: true, grantedClasses: ['idle'], deniedClasses: ['handle-lid-switch'], note } },
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.textContent).toContain(note);
  });

  test('keep-awake on but refused by the OS shows the refusal note and no "Sleep disabled" state', () => {
    const note = 'keep-awake is on, but the OS refused the sleep inhibitor, so this host can still sleep; it retries on wake and whenever keep-awake is turned on again';
    mockStatus = {
      isPending: false,
      isError: false,
      data: { ...NOT_HELD_STATE, keepAwake: { enabled: true, held: false, grantedClasses: [], deniedClasses: [], note } },
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.textContent).toContain(note);
    expect(el.textContent).not.toContain('Sleep disabled');
  });

  test('work inhibitor held renders "held because X" verbatim from work.reasons', () => {
    mockStatus = {
      isPending: false,
      isError: false,
      data: { ...NOT_HELD_STATE, work: { ...NOT_HELD_STATE.work, held: true, reasons: ['active turn in session s-1'] } },
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.textContent).toContain('active turn in session s-1');
  });

  test('toggling the checkbox calls the keepAwake.set mutation with the new value', () => {
    mockStatus = { isPending: false, isError: false, data: NOT_HELD_STATE, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    const toggle = el.querySelector('button[role="switch"]') as HTMLButtonElement;
    flushSync(() => { toggle.click(); });
    expect(mutateCalls).toEqual([true]);
  });

  test('mutation error surfaces a warning banner', () => {
    mockStatus = { isPending: false, isError: false, data: NOT_HELD_STATE, refetch: () => {} };
    mockMutation = { isPending: false, isError: true, error: new Error('daemon refused'), mutate: (v: boolean) => { mutateCalls.push(v); } };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('.banner.warning')).not.toBeNull();
  });
});
