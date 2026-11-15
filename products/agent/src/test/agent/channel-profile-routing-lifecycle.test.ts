/**
 * channel-profile-routing-lifecycle.test.ts, a route removed here is removed
 * where the platform routes, and overlapping writers do not undo each other.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  CHANNEL_ROUTING_ASSIGN_METHOD,
  CHANNEL_ROUTING_DELETE_METHOD,
  assignChannelToProfile,
  getProfileForChannel,
  readChannelProfileRoutes,
  removeChannelProfileRoute,
  removeChannelProfileRouteEverywhere,
  syncChannelProfileRoutes,
} from '../../agent/channel-profile-routing.ts';
import { readChannelRoutingSyncReceipts } from '../../agent/channel-routing-sync-receipts.ts';
import type { DaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';

let root: string;
const shellPaths = { resolveUserPath: (...segments: string[]) => join(root, ...segments) };

beforeEach(() => { root = makeProjectTempDir('gv-route-life'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface Call { readonly methodId: string; readonly input: Record<string, unknown>; readonly explicitUserRequest: boolean | undefined }

const down: DaemonOperatorInvoke = async (methodId) => ({ ok: false, methodId, route: '', kind: 'connected_host_unavailable', error: 'down' });

function daemon(calls: Call[], during?: (call: Call) => void | Promise<void>): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    const call = { methodId, input, explicitUserRequest: options.explicitUserRequest };
    calls.push(call);
    await during?.(call);
    return { ok: true, methodId, route: '', body: methodId === CHANNEL_ROUTING_ASSIGN_METHOD ? { assignmentId: `daemon-${String(input.routeId ?? 'x')}` } : { deleted: true } };
  };
}

describe('removing a route the daemon holds', () => {
  test('asks the daemon to delete its assignment, then removes the local row', async () => {
    const calls: Call[] = [];
    const assigned = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }, { invoke: daemon(calls) });

    const result = await removeChannelProfileRouteEverywhere(shellPaths, assigned.route.id, { invoke: daemon(calls) });

    expect(result).toEqual({ removed: true, daemon: { status: 'deleted' } });
    const deletion = calls.find((c) => c.methodId === CHANNEL_ROUTING_DELETE_METHOD);
    expect(deletion?.input).toMatchObject({ assignmentId: 'daemon-C1', confirm: true });
    expect(readChannelProfileRoutes(shellPaths).routes).toHaveLength(0);
  });

  test('keeps the local row when the daemon does not answer, so the removal can be retried', async () => {
    const assigned = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }, { invoke: daemon([]) });

    const result = await removeChannelProfileRouteEverywhere(shellPaths, assigned.route.id, { invoke: down });

    expect(result.removed).toBe(false);
    expect(result.daemon).toMatchObject({ status: 'refused', kind: 'connected_host_unavailable' });
    expect(readChannelProfileRoutes(shellPaths).routes).toHaveLength(1);
  });

  test('refuses, rather than leave the daemon routing, when no transport is supplied', async () => {
    const assigned = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }, { invoke: daemon([]) });

    const result = await removeChannelProfileRouteEverywhere(shellPaths, assigned.route.id);

    expect(result).toMatchObject({ removed: false, daemon: { status: 'refused', kind: 'not_attempted' } });
    expect(readChannelProfileRoutes(shellPaths).routes).toHaveLength(1);
  });

  test('a route the daemon never took is removed locally with no daemon call', async () => {
    const assigned = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C2', profileId: 'work' }, { invoke: down });
    const calls: Call[] = [];

    const result = await removeChannelProfileRouteEverywhere(shellPaths, assigned.route.id, { invoke: daemon(calls) });

    expect(result).toEqual({ removed: true, daemon: { status: 'not_held' } });
    expect(calls).toHaveLength(0);
  });
});

describe('a daemon call in flight does not undo other writers', () => {
  test('assigning keeps a route removed while the offer was pending removed, and keeps the new one', async () => {
    const old = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'OLD', profileId: 'work' }, { invoke: down });
    const invoke = daemon([], () => { removeChannelProfileRoute(shellPaths, old.route.id); });

    await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'NEW', profileId: 'home' }, { invoke });

    const routes = readChannelProfileRoutes(shellPaths).routes;
    expect(routes.map((r) => r.routeId)).toEqual(['NEW']);
  });

  test('sync does not bring back a route removed while it was pending, and withdraws it from the daemon', async () => {
    const gone = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'GONE', profileId: 'work' }, { invoke: down });
    const kept = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'KEPT', profileId: 'work' }, { invoke: down });
    const calls: Call[] = [];
    const invoke = daemon(calls, (call) => {
      if (call.input.routeId === 'GONE') removeChannelProfileRoute(shellPaths, gone.route.id);
    });

    await syncChannelProfileRoutes(shellPaths, invoke);

    const routes = readChannelProfileRoutes(shellPaths).routes;
    expect(routes.map((r) => r.id)).toEqual([kept.route.id]);
    expect(routes[0]!.daemonSyncState).toBe('synced');
    expect(calls.some((c) => c.methodId === CHANNEL_ROUTING_DELETE_METHOD && c.input.assignmentId === 'daemon-GONE')).toBe(true);
  });

  test('a withdrawal the daemon refuses or fails is receipted and reported, not dropped', async () => {
    for (const failure of ['refused', 'threw'] as const) {
      const gone = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: `GONE-${failure}`, profileId: 'work' }, { invoke: down });
      const invoke: DaemonOperatorInvoke = async (methodId, input = {}) => {
        if (methodId === CHANNEL_ROUTING_DELETE_METHOD) {
          if (failure === 'threw') throw new Error('socket closed');
          return { ok: false, methodId, route: '', kind: 'connected_host_error', error: 'daemon busy' };
        }
        removeChannelProfileRoute(shellPaths, gone.route.id);
        return { ok: true, methodId, route: '', body: { assignmentId: `daemon-${String(input.routeId)}` } };
      };

      const report = await syncChannelProfileRoutes(shellPaths, invoke);

      expect(report.withdrawFailed).toEqual([{ routeId: gone.route.id, assignmentId: `daemon-GONE-${failure}`, error: failure === 'threw' ? 'socket closed' : 'daemon busy' }]);
      const receipt = readChannelRoutingSyncReceipts(shellPaths).receipts.find((r) => r.routeId === gone.route.id && r.outcome === 'withdraw_failed');
      expect(receipt).toMatchObject({ outcome: 'withdraw_failed', daemonAssignmentId: `daemon-GONE-${failure}` });
    }
  });

  test('a sync is not claimed to be a person asking', async () => {
    await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C3', profileId: 'work' }, { invoke: down });
    const calls: Call[] = [];

    await syncChannelProfileRoutes(shellPaths, daemon(calls));

    expect(calls[0]!.explicitUserRequest).toBe(false);
  });
});

describe('re-assigning a route the daemon holds while it is away', () => {
  test('the row keeps the daemon assignment id, so removing it still withdraws what the daemon routes on', async () => {
    const calls: Call[] = [];
    const first = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }, { invoke: daemon(calls) });
    const moved = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'home' }, { invoke: down });
    expect(moved.route).toMatchObject({ daemonSyncState: 'pending', daemonAssignmentId: 'daemon-C1' });

    const result = await removeChannelProfileRouteEverywhere(shellPaths, first.route.id, { invoke: daemon(calls) });

    expect(result).toEqual({ removed: true, daemon: { status: 'deleted' } });
    expect(calls.filter((c) => c.methodId === CHANNEL_ROUTING_DELETE_METHOD).map((c) => c.input.assignmentId)).toEqual(['daemon-C1']);
    expect(readChannelProfileRoutes(shellPaths).routes).toHaveLength(0);
  });
});

describe('the global wildcard', () => {
  test('a stored any:<routeId> row is not a wildcard for other channels', async () => {
    await assignChannelToProfile(shellPaths, { surfaceKind: 'any', routeId: 'room1', profileId: 'narrow' });
    expect(getProfileForChannel(shellPaths, 'slack', 'C9')).toBeNull();

    await assignChannelToProfile(shellPaths, { surfaceKind: 'any', profileId: 'global' });
    expect(getProfileForChannel(shellPaths, 'slack', 'C9')).toBe('global');
  });
});

describe('re-assigning a route keeps its label', () => {
  test('an assignment that omits the label keeps the stored one', async () => {
    await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'work', label: 'Ops room' }, { invoke: daemon([]) });
    const again = await assignChannelToProfile(shellPaths, { surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }, { invoke: daemon([]) });

    expect(again.route.label).toBe('Ops room');
  });
});
