/**
 * State inspector: snapshots, transition detection by revision, and
 * subscriber notification, driven by in-memory domains.
 */

import { describe, expect, test } from 'bun:test';
import { createStateInspector } from '../platform/src/platform/runtime/inspection/state-inspector.js';

function fakeDomain(name: string, initial: Record<string, unknown> = {}) {
  let state = initial;
  let revision = 0;
  return {
    name,
    getState: () => state,
    getRevision: () => revision,
    getLastUpdatedAt: () => revision * 10,
    set(next: Record<string, unknown>) {
      state = next;
      revision += 1;
    },
  };
}

describe('platform/runtime/inspection/state-inspector', () => {
  test('getSnapshot captures each domain state and honours the domain filter', () => {
    const session = fakeDomain('session', { id: 's1' });
    const tasks = fakeDomain('tasks', { open: 2 });
    session.set({ id: 's2' });
    const inspector = createStateInspector({ domains: [session, tasks] });

    const all = inspector.getSnapshot();
    expect(all.domainCount).toBe(2);
    expect(all.domains).toEqual([
      { domain: 'session', revision: 1, lastUpdatedAt: 10, state: { id: 's2' } },
      { domain: 'tasks', revision: 0, lastUpdatedAt: 0, state: { open: 2 } },
    ]);
    expect(inspector.getSnapshot(['tasks']).domains.map((d) => d.domain)).toEqual(['tasks']);
    expect(inspector.registeredDomainNames()).toEqual(['session', 'tasks']);
  });

  test('poll records a transition only when a domain revision changed', () => {
    const session = fakeDomain('session', { source: 'boot' });
    const inspector = createStateInspector({ domains: [session] });
    expect(inspector.totalTransitions).toBe(0);

    // First sight of a domain at revision 0 is recorded once, from revision 0.
    expect(inspector.poll()).toBe(1);
    expect(inspector.poll()).toBe(0);

    session.set({ source: 'user-edit', value: 1 });
    expect(inspector.poll()).toBe(1);
    expect(inspector.poll()).toBe(0);

    expect(inspector.totalTransitions).toBe(2);
    const last = inspector.getLastTransitions(1)[0]!;
    expect(last).toMatchObject({ domain: 'session', fromRevision: 0, toRevision: 1, source: 'user-edit', state: { source: 'user-edit', value: 1 } });
    expect(inspector.getTransitionsByDomain('other')).toEqual([]);
  });

  test('subscribers hear about transitions, a throwing subscriber is counted and does not block others, and unsubscribe stops delivery', () => {
    const session = fakeDomain('session');
    const inspector = createStateInspector({ domains: [session] });
    let heard = 0;
    inspector.subscribe(() => { throw new Error('subscriber failed'); }, 'broken');
    const good = inspector.subscribe(() => { heard += 1; }, 'good');
    expect(inspector.subscriptionCount).toBe(2);

    session.set({ a: 1 });
    inspector.poll();
    expect(heard).toBe(1);
    const infos = new Map(inspector.getSubscriptions().map((info) => [info.label, info]));
    expect(infos.get('broken')).toMatchObject({ errorCount: 1, notificationCount: 0, lastError: expect.stringContaining('subscriber failed') });
    expect(infos.get('good')).toMatchObject({ errorCount: 0, notificationCount: 1 });

    good.unsubscribe();
    expect(inspector.subscriptionCount).toBe(1);
    session.set({ a: 2 });
    inspector.poll();
    expect(heard).toBe(1);
  });

  test('observedDomains limits which domains are polled', () => {
    const session = fakeDomain('session');
    const tasks = fakeDomain('tasks');
    const inspector = createStateInspector({ domains: [session, tasks], observedDomains: ['tasks'] });
    expect(inspector.poll()).toBe(1);
    expect(inspector.getTransitionHistory().map((entry) => entry.domain)).toEqual(['tasks']);
  });
});

describe('state inspector masking', () => {
  const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

  test('getSnapshot, poll history and the timeline never hold a credential in the clear', () => {
    const session = fakeDomain('session', { source: 'boot', note: `key ${TOKEN}`, plain: 'visible' });
    const inspector = createStateInspector({ domains: [session] });

    const snapshot = inspector.getSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(snapshot.domains[0]!.state['plain']).toBe('visible');

    inspector.poll();
    expect(JSON.stringify(inspector.getTransitionHistory())).not.toContain(TOKEN);
    expect(JSON.stringify(inspector.getTimeline())).not.toContain(TOKEN);
  });
});
