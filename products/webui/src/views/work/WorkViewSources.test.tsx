/**
 * WorkView when a source cannot be read: a failing best-of-N or approvals read
 * shows its own notice, a daemon without the verb stays quiet, an unreadable
 * hosted list is disclosed on All (never a false empty state), and the archive's
 * header counts what is archived.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const T = 1_700_000_000_000;

let attemptsError: Error | null = null;
let approvalsError: Error | null = null;
let hostedResult: unknown = { sessions: [] };
let archivedNodes: unknown[] = [];

const methodMissing = () => Object.assign(new Error('Unknown method'), { code: 'METHOD_NOT_FOUND', status: 404 });
const serverError = () => Object.assign(new Error('Internal error'), { status: 500 });

mock.module('../../lib/goodvibes', () => ({
  GOODVIBES_BASE_URL: 'http://localhost',
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  WEBUI_SURFACE_ID: 'goodvibes-webui',
  WEBUI_SURFACE_KIND: 'webui',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  hostedSessionDetachBeacon: () => {},
  hasStoredTokenSync: () => true,
  client: {
    streams: { open: () => Promise.resolve(() => {}) },
    operator: {
      fleet: {
        snapshot: () => Promise.resolve({ capturedAt: T, truncated: false, totalCount: 0, nodes: [] }),
        archivedList: () => Promise.resolve({ capturedAt: T, nodes: archivedNodes }),
        attempts: { list: () => attemptsError ? Promise.reject(attemptsError) : Promise.resolve({ groups: [] }) },
      },
      approvals: {
        list: () => approvalsError ? Promise.reject(approvalsError) : Promise.resolve({ approvals: [] }),
      },
      sessions: {
        list: () => Promise.resolve({ totals: {}, sessions: [] }),
        hosted: { list: () => Promise.resolve(hostedResult) },
      },
      tasks: {
        list: () => Promise.resolve({ queued: 0, running: 0, blocked: 0, totals: {}, tasks: [] }),
      },
      ci: { watches: { list: () => Promise.resolve({ watches: [] }) } },
      contracts: { list: () => Promise.resolve({ contracts: [] }) },
      control: { methodInfo: () => Promise.resolve({}) },
      cost: { attribution: { get: () => Promise.resolve({ rows: [] }) } },
      permissions: { rules: { list: () => Promise.resolve({ rules: [] }) } },
    },
  },
}));

const { WorkView } = await import('./WorkView');
const { ToastProvider } = await import('../../lib/toast');
const { ToastViewport } = await import('../../components/toast/ToastViewport');

function render(tab?: string): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        ToastProvider,
        null,
        React.createElement(WorkView, { tab, onTabChange: () => {} }),
        React.createElement(ToastViewport),
      ),
    ));
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target missing');
  flushSync(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function type(el: Element | null | undefined, value: string) {
  if (!el) throw new Error('type target missing');
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
}

function rowButton(scope: ParentNode, title: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('.gv-row__main')].find((b) => b.textContent?.includes(title));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  attemptsError = null;
  approvalsError = null;
  hostedResult = { sessions: [] };
  archivedNodes = [];
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

const alerts = (el: ParentNode) => [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '');

describe('a Work source that cannot be read', () => {
  test('a failing best-of-N read says so instead of silently listing nothing', async () => {
    attemptsError = serverError();
    const { el, unmount } = render();
    await waitFor(() => alerts(el).some((text) => text.includes('Could not load best-of-N groups')));
    unmount();
  });

  test('a failing approvals read says so', async () => {
    approvalsError = serverError();
    const { el, unmount } = render();
    await waitFor(() => alerts(el).some((text) => text.includes('Could not load approvals')));
    unmount();
  });

  test('a daemon without the verb stays quiet', async () => {
    attemptsError = methodMissing();
    approvalsError = methodMissing();
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('appear here while they run'));
    expect(alerts(el).filter((text) => !text.includes('contracts'))).toEqual([]);
    unmount();
  });

  test('an unreadable hosted list is disclosed on All and is not shown as an empty page', async () => {
    hostedResult = {};
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('hosted sessions are not shown'));
    expect(el.textContent).not.toContain('appear here while they run');
    unmount();
  });

  test('an unreadable hosted list does not blank the Agents filter, which never shows hosted sessions', async () => {
    hostedResult = {};
    const { el, unmount } = render('agents');
    await waitFor(() => (el.textContent ?? '').includes('appear here while they run'));
    expect(el.textContent).not.toContain('hosted sessions are not shown');
    unmount();
  });
});

describe('the archive', () => {
  test('the header counts what is archived, not zero running', async () => {
    archivedNodes = [{
      id: 'old-1', kind: 'agent', label: 'Old agent', state: 'done', elapsedMs: 10, startedAt: T,
      costUsd: null, costState: 'unpriced',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    }];
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('appear here while they run'));
    click(el.querySelector('button[aria-label="Show"]'));
    click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('Archive')));
    await waitFor(() => (el.textContent ?? '').includes('1 archived'));
    expect(el.textContent).not.toContain('0 running');
    unmount();
  });
});
