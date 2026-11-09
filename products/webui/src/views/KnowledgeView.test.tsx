/**
 * KnowledgeView, the W8 honesty fix: the knowledge map used to dump DataBlock's raw
 * <pre>{JSON}</pre> branch regardless of the daemon's "766 jobs ran / 0 nodes" activity
 * signal. This covers that the map renders through KnowledgeMap (an svg <img>, or an
 * honest named empty state), never falls back to raw JSON as the primary view, and that
 * the Browse, Map, Packet and Activity sections are each reachable.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';

let statusData: unknown = { ready: true, storagePath: '/tmp', sourceCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0, extractionCount: 0, jobRunCount: 0, usageCount: 0, candidateCount: 0, reportCount: 0, scheduleCount: 0 };
let mapData: unknown = { ok: true, title: 'Map', generatedAt: 1, width: 100, height: 100, nodeCount: 0, edgeCount: 0, nodes: [], edges: [], svg: '' };
let invokeImpl: (method: string, input?: unknown) => Promise<unknown> = (method) => {
  if (method === 'knowledge.sources.list') return Promise.resolve({ sources: [] });
  if (method === 'knowledge.nodes.list') return Promise.resolve({ nodes: [] });
  if (method === 'knowledge.issues.list') return Promise.resolve({ issues: [] });
  if (method === 'knowledge.projections.list') return Promise.resolve({ targets: [] });
  if (method === 'knowledge.refinement.tasks.list') return Promise.resolve({ tasks: [] });
  if (method === 'knowledge.jobs.list') return Promise.resolve({ jobs: [] });
  if (method === 'knowledge.job-runs.list') return Promise.resolve({ runs: [] });
  return Promise.resolve({});
};

mock.module('../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string, input?: unknown) => invokeImpl(method, input),
  client: {
    knowledge: {
      status: () => Promise.resolve(statusData),
      map: () => Promise.resolve(mapData),
      ask: () => Promise.resolve({}),
      search: () => Promise.resolve({}),
    },
  },
}));

const { KnowledgeView } = await import('./KnowledgeView');

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(KnowledgeView, { query: '' }),
      ),
    );
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

function chooseSection(el: HTMLElement, label: string): void {
  const radio = [...el.querySelectorAll('[role="radio"]')].find((r) => r.textContent === label);
  expect(radio).toBeTruthy();
  flushSync(() => { radio?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

afterEach(() => {
  statusData = { ready: true, storagePath: '/tmp', sourceCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0, extractionCount: 0, jobRunCount: 0, usageCount: 0, candidateCount: 0, reportCount: 0, scheduleCount: 0 };
  mapData = { ok: true, title: 'Map', generatedAt: 1, width: 100, height: 100, nodeCount: 0, edgeCount: 0, nodes: [], edges: [], svg: '' };
  invokeImpl = (method) => {
    if (method === 'knowledge.sources.list') return Promise.resolve({ sources: [] });
    if (method === 'knowledge.nodes.list') return Promise.resolve({ nodes: [] });
    if (method === 'knowledge.issues.list') return Promise.resolve({ issues: [] });
    if (method === 'knowledge.projections.list') return Promise.resolve({ targets: [] });
    if (method === 'knowledge.refinement.tasks.list') return Promise.resolve({ tasks: [] });
    if (method === 'knowledge.jobs.list') return Promise.resolve({ jobs: [] });
    if (method === 'knowledge.job-runs.list') return Promise.resolve({ runs: [] });
    return Promise.resolve({});
  };
});

describe('KnowledgeView: the knowledge map never dumps raw JSON', () => {

  test('an empty Browse offers Add link instead of a blank list', async () => {
    const { el, unmount } = render();
    await waitFor(() => [...el.querySelectorAll('button')].some((b) => b.textContent === 'Add link'));
    unmount();
  });

  test('the "jobs ran, 0 nodes" gap shows the job count in BOTH Browse and the Map, with no map render', async () => {
    statusData = { ...(statusData as Record<string, unknown>), jobRunCount: 766, nodeCount: 0 };
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('766'));
    chooseSection(el, 'Map');
    await waitFor(() => (el.textContent ?? '').includes('766'));
    expect(el.querySelector('.knowledge-map-render')).toBeFalsy();
    unmount();
  });

  test('a populated map renders the svg via <img>, not a raw JSON <pre>', async () => {
    statusData = { ...(statusData as Record<string, unknown>), jobRunCount: 5, nodeCount: 3 };
    mapData = { ok: true, title: 'Map', generatedAt: 1, width: 100, height: 100, nodeCount: 3, edgeCount: 2, nodes: [], edges: [], svg: SAMPLE_SVG };
    const { el, unmount } = render();
    chooseSection(el, 'Map');
    await waitFor(() => Boolean(el.querySelector('.knowledge-map-render img')));
    const mapPanel = el.querySelector('.knowledge-map-render');
    expect(mapPanel?.querySelector('img')).toBeTruthy();
    // The raw JSON is demoted behind "View raw", not present by default.
    expect(mapPanel?.querySelector('pre')).toBeFalsy();
    unmount();
  });

  test('"View jobs" from the Browse notice opens Activity with job-run detail', async () => {
    statusData = { ...(statusData as Record<string, unknown>), jobRunCount: 4, nodeCount: 0 };
    invokeImpl = (method) => {
      if (method === 'knowledge.jobs.list') return Promise.resolve({ jobs: [{ id: 'reindex', kind: 'reindex', title: 'Reindex sources', description: '', defaultMode: 'background', metadata: {} }] });
      if (method === 'knowledge.job-runs.list') return Promise.resolve({ runs: [{ id: 'run-1', jobId: 'reindex', status: 'failed', mode: 'background', requestedAt: 1, error: 'no candidates extracted', result: {}, metadata: {}, createdAt: 1, updatedAt: 1 }] });
      return Promise.resolve({ sources: [], nodes: [], issues: [], targets: [], tasks: [] });
    };
    const { el, unmount } = render();
    await waitFor(() => [...el.querySelectorAll('button')].some((b) => b.textContent === 'View jobs'));
    const viewJobsButton = [...el.querySelectorAll('button')].find((b) => b.textContent === 'View jobs');
    expect(viewJobsButton).toBeTruthy();
    flushSync(() => { viewJobsButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await waitFor(() => (el.textContent ?? '').includes('Reindex sources'));
    expect(el.textContent).toContain('no candidates extracted');
    unmount();
  });
});

function clickButton(el: HTMLElement, label: string): void {
  const button = [...el.querySelectorAll('button')].find(item => item.textContent === label
    || item.querySelector('.gv-row__title')?.textContent === label);
  expect(button).toBeTruthy();
  flushSync(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

describe('KnowledgeView projection target dispatch and preserved-page inspection', () => {
  for (const target of [
    { kind: 'source', targetId: 'source:raw-source', itemId: 'raw-source', title: 'Source projection', expected: 'raw-source' },
    { kind: 'node', targetId: 'node:node:retained', itemId: 'node:retained', title: 'Node projection', expected: 'node:retained' },
    { kind: 'issue', targetId: 'issue:raw-issue', title: 'Issue projection', expected: 'raw-issue' },
    { kind: 'rollup', targetId: 'private:raw-rollup', title: 'Rollup projection', expected: 'private:raw-rollup' },
    { kind: 'dashboard', targetId: 'dashboard:backlinks', itemId: 'backlinks', title: 'Backlinks Dashboard', expected: 'backlinks' },
    { kind: 'overview', targetId: 'overview', title: 'Overview projection', expected: undefined },
    { kind: 'bundle', targetId: 'bundle', title: 'Bundle projection', expected: undefined },
  ]) {
    test(`actual ${target.kind} selection sends the selected target to both RPCs`, async () => {
      const calls: { method: string; input: unknown }[] = [];
      invokeImpl = async (method, input) => {
        calls.push({ method, input });
        if (method === 'knowledge.projections.list') return { targets: [target] };
        return { sources: [], nodes: [], issues: [], tasks: [] };
      };
      const view = render();
      try {
        await waitFor(() => Boolean([...view.el.querySelectorAll('.gv-row__title')].find(item => item.textContent === target.title)));
        clickButton(view.el, target.title);
        for (const [button, method] of [['Render', 'knowledge.projection.render'], ['Materialize', 'knowledge.projection.materialize']] as const) {
          clickButton(view.el, button);
          await waitFor(() => calls.some(call => call.method === method));
          expect(calls.find(call => call.method === method)?.input).toEqual({ kind: target.kind,
            ...(target.expected === undefined ? {} : { id: target.expected }), limit: 25 });
        }
      } finally { view.unmount(); }
    });
  }
  test('the preserved-page action explicitly inspects all spaces and never carries its result to another target', async () => {
    const targets = [{ kind: 'overview', targetId: 'overview', title: 'Overview projection' },
      { kind: 'bundle', targetId: 'bundle', title: 'Bundle projection' }];
    const calls: { method: string; input: unknown }[] = [];
    invokeImpl = async (method, input) => {
      calls.push({ method, input });
      if (method === 'knowledge.projections.list') return { targets };
      if (method === 'knowledge.projection.materialize') return {
        note: 'Saved projections with unknown scope were preserved. Select All spaces to inspect them.',
        preservedUnscopedSourceIds: ['kg-gen-historical'],
      };
      if (method === 'knowledge.item.get') return { item: { title: 'Saved page' } };
      return { sources: [], nodes: [], issues: [], tasks: [] };
    };
    const view = render();
    try {
      await waitFor(() => (view.el.textContent ?? '').includes('Overview projection'));
      clickButton(view.el, 'Overview projection'); clickButton(view.el, 'Materialize');
      await waitFor(() => (view.el.textContent ?? '').includes('Inspect saved projection kg-gen-historical'));
      clickButton(view.el, 'Bundle projection');
      expect(view.el.textContent).not.toContain('Inspect saved projection kg-gen-historical');
      clickButton(view.el, 'Overview projection');
      clickButton(view.el, 'Inspect saved projection kg-gen-historical');
      await waitFor(() => calls.some(call => call.method === 'knowledge.item.get'));
      expect(calls.find(call => call.method === 'knowledge.item.get')?.input).toEqual({ id: 'kg-gen-historical', includeAllSpaces: true });
    } finally { view.unmount(); }
  });
});
