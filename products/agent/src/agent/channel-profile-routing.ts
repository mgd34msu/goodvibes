/**
 * channel-profile-routing.ts
 *
 * Which profile an incoming channel interaction is answered as.
 *
 * An assignment binds a channel (surface kind, optional route id) to a
 * GoodVibes profile. The daemon owns the routing table the platform routes
 * against, `channels.routing.assign` writes it, and every surface reads the
 * same one, so an assignment made here is offered to the daemon first and
 * kept here as well.
 *
 * The local file is a MIRROR, not a second opinion. It exists because the
 * daemon is a peer this process does not control: a laptop off the LAN, a
 * daemon mid-restart, a token not yet minted. An assignment made in one of
 * those moments is still the operator's instruction, and dropping it because
 * the peer was busy would be worse than holding it. Held assignments carry
 * `daemonSyncState: 'pending'` with the reason the daemon gave, and are
 * offered again when the channel is assigned again, and whenever another
 * assignment reaches the daemon (`syncChannelProfileRoutes`).
 * Removing a route the daemon holds removes it from the daemon too:
 * `removeChannelProfileRouteEverywhere`.
 *
 * Persistence: JSON file at {agentRoot}/channels/profile-routes.json via
 * ShellPathService.
 */

import { randomUUID } from 'node:crypto';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  readJsonStore,
  runStoreFileUpdateSync,
  writeJsonStore,
  type JsonStoreContents,
  type JsonStoreSpec,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { retainChannelStoreSource, type ChannelStoreEffectOptions } from './channel-store-lifetime.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from './daemon-operator-client.ts';

/** The daemon method that owns the routing table. */
export const CHANNEL_ROUTING_ASSIGN_METHOD = 'channels.routing.assign';
export const CHANNEL_ROUTING_DELETE_METHOD = 'channels.routing.delete';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where an assignment stands with the daemon.
 *
 * `synced`, the daemon holds it, and `assignmentId` is the daemon's own id.
 * `pending`, it was offered and the daemon did not take it; `syncError` says
 *   why, in the daemon's words. The assignment is live locally and is
 *   offered again when the channel is assigned again.
 */
export type ChannelProfileRouteSyncState = 'synced' | 'pending';

/**
 * Represents a channel-to-profile assignment.
 *
 * `surfaceKind` maps to the existing ChannelDeliverySurfaceKind values
 * (slack, discord, telegram, etc.) plus 'any' as a wildcard.
 */
export interface ChannelProfileRoute {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The channel surface kind (e.g. 'slack', 'discord', 'telegram'). Use 'any' as wildcard. */
  readonly surfaceKind: string;
  /** Optional route id to narrow beyond surface kind. */
  readonly routeId?: string;
  /** The profile id to route this channel to. */
  readonly profileId: string;
  /** Optional human-readable label. */
  readonly label?: string;
  /** Whether the daemon holds this assignment. */
  readonly daemonSyncState: ChannelProfileRouteSyncState;
  /** The daemon's id for this assignment, once it has taken it. */
  readonly daemonAssignmentId?: string;
  /** Why the daemon did not take it, in the daemon's words. Absent when synced. */
  readonly syncError?: string;
  /** The classified shape of that refusal, for a caller that renders by kind. */
  readonly syncFailureKind?: DaemonInvokeFailureKind;
}

export interface ChannelProfileRouteSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly routes: readonly ChannelProfileRoute[];
  readonly parseError?: string;
  /** Stored routes this version cannot read; they stay in the file as found. */
  readonly unreadableEntries?: number;
}

export interface ChannelProfileRouteAssignResult {
  readonly route: ChannelProfileRoute;
  readonly path: string;
  readonly created: boolean;
  /** What the daemon said when this assignment was offered to it. */
  readonly daemon: ChannelProfileRouteSyncOutcome;
  /** Held assignments offered again because the daemon answered this one; absent when none were held. */
  readonly heldOffered?: ChannelProfileRouteSyncReport;
}

/** The result of offering one assignment to the daemon. */
export type ChannelProfileRouteSyncOutcome =
  | { readonly synced: true; readonly assignmentId: string }
  | { readonly synced: false; readonly kind: DaemonInvokeFailureKind; readonly error: string }
  /** No daemon transport was supplied, so nothing was offered and nothing is claimed. */
  | { readonly synced: false; readonly kind: 'not_attempted'; readonly error: string };

// ---------------------------------------------------------------------------
// Internal file model
// ---------------------------------------------------------------------------

type ShellPaths = Pick<ShellPathService, 'resolveUserPath'>;

const ROUTE_VERSION = 1 as const;
const ROUTE_FILE_VERSION = 1 as const;
const ROUTE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function channelProfileRouteFilePath(shellPaths: ShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'channels', 'profile-routes.json');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptString(value: unknown): string | undefined {
  const s = readString(value);
  return s || undefined;
}

function parseSyncState(value: unknown): ChannelProfileRouteSyncState {
  // Anything else, including the retired 'local_only' written by builds from
  // before the daemon held this table, reads as pending. That is the honest
  // reading: the daemon has not been told about the record, so it is owed an
  // offer, which assigning the channel again makes.
  return value === 'synced' ? 'synced' : 'pending';
}

function parseRoute(value: unknown): ChannelProfileRoute | null {
  if (!isRecord(value) || value.version !== ROUTE_VERSION) return null;
  const id = readString(value.id);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  const surfaceKind = readString(value.surfaceKind);
  const profileId = readString(value.profileId);
  if (!id || !createdAt || !updatedAt || !surfaceKind || !profileId) return null;
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
  const daemonSyncState = parseSyncState(value.daemonSyncState);
  return {
    version: ROUTE_VERSION,
    id,
    createdAt,
    updatedAt,
    surfaceKind,
    profileId,
    ...( readOptString(value.routeId) ? { routeId: readOptString(value.routeId) } : {}),
    ...( readOptString(value.label) ? { label: readOptString(value.label) } : {}),
    daemonSyncState,
    ...( readOptString(value.daemonAssignmentId) ? { daemonAssignmentId: readOptString(value.daemonAssignmentId) } : {}),
    ...( daemonSyncState === 'pending' && readOptString(value.syncError) ? { syncError: readOptString(value.syncError) } : {}),
  };
}

const ROUTE_STORE: JsonStoreSpec<ChannelProfileRoute> = {
  label: 'channel routing store',
  entriesKey: 'routes',
  version: ROUTE_FILE_VERSION,
  parseEntry: parseRoute,
};

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function toSnapshot(contents: JsonStoreContents<ChannelProfileRoute>): ChannelProfileRouteSnapshot {
  const parseError = contents.unreadable
    ?? (contents.newerVersion === undefined ? undefined : `written by a newer GoodVibes (file version ${contents.newerVersion})`);
  return {
    path: contents.path,
    exists: contents.exists,
    routes: contents.entries,
    ...(parseError === undefined ? {} : { parseError }),
    ...(contents.keptAsFound.length > 0 ? { unreadableEntries: contents.keptAsFound.length } : {}),
  };
}

export function readChannelProfileRoutes(shellPaths: ShellPaths): ChannelProfileRouteSnapshot {
  return toSnapshot(readJsonStore(channelProfileRouteFilePath(shellPaths), ROUTE_STORE));
}

/** One locked read-modify-write of the routing file; routes this version cannot read are written back as found. */
function updateRoutes<T>(
  path: string,
  mutate: (routes: readonly ChannelProfileRoute[]) => { readonly value: T; readonly routes?: readonly ChannelProfileRoute[] },
  assertCurrent?: () => void,
): T {
  return runStoreFileUpdateSync(path, () => {
    const read = readJsonStore(path, ROUTE_STORE);
    const change = mutate(read.entries);
    if (change.routes !== undefined) writeJsonStore(read, ROUTE_STORE, { entries: change.routes.slice(0, ROUTE_LIMIT) }, { assertCurrent });
    return change.value;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function readDaemonAssignmentId(body: unknown): string {
  if (!isRecord(body)) return '';
  return readString(body.assignmentId);
}

/**
 * Offer one assignment to the daemon's routing table.
 *
 * Manual callers use the native confirmation protocol. The admitted model
 * transport replaces that envelope with a request for fresh native admission.
 */
async function offerRouteToDaemon(
  invoke: DaemonOperatorInvoke | undefined,
  route: ChannelProfileRoute,
  options: ChannelStoreEffectOptions = {},
): Promise<ChannelProfileRouteSyncOutcome> {
  if (!invoke) {
    return {
      synced: false,
      kind: 'not_attempted',
      error: 'no connected-host transport was supplied, so the daemon was not offered this assignment',
    };
  }
  const result = await invoke(
    CHANNEL_ROUTING_ASSIGN_METHOD,
    {
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      ...(route.routeId ? { routeId: route.routeId } : {}),
      ...(route.label ? { label: route.label } : {}),
      confirm: true,
    },
    { signal: options.signal, assertCurrent: options.assertCurrent, explicitUserRequest: options.explicitUserRequest ?? true },
  );
  if (!result.ok) return { synced: false, kind: result.kind, error: result.error };
  const assignmentId = readDaemonAssignmentId(result.body);
  if (!assignmentId) {
    return {
      synced: false,
      kind: 'connected_host_error',
      error: `${CHANNEL_ROUTING_ASSIGN_METHOD} answered without an assignmentId, so nothing proves the daemon holds this assignment`,
    };
  }
  return { synced: true, assignmentId };
}

/** Fold a sync outcome onto a record, so the record states only what is true. */
function withSyncOutcome(
  route: ChannelProfileRoute,
  outcome: ChannelProfileRouteSyncOutcome,
): ChannelProfileRoute {
  if (outcome.synced) {
    const { syncError: _dropped, syncFailureKind: _alsoDropped, ...rest } = route;
    return { ...rest, daemonSyncState: 'synced', daemonAssignmentId: outcome.assignmentId };
  }
  return {
    ...route,
    daemonSyncState: 'pending',
    syncError: outcome.error,
    ...(outcome.kind === 'not_attempted' ? {} : { syncFailureKind: outcome.kind }),
  };
}

/**
 * Assign a channel (identified by surfaceKind + optional routeId) to a profile.
 *
 * If an assignment for the same (surfaceKind, routeId) pair already exists,
 * it is updated in-place. Otherwise a new assignment is created.
 *
 * The daemon is offered the assignment first, because the daemon's table is the
 * one the platform routes against. The local write happens either way: the
 * record is the operator's instruction, and a daemon that could not be reached
 * is a reason to hold it, not to lose it.
 */
// An omitted label keeps the stored one so a retry that repeats only the target does not drop it.
function labelFor(input: string | undefined, existing: string | undefined): string | undefined {
  return input === undefined ? existing : input.trim() || undefined;
}

export async function assignChannelToProfile(
  shellPaths: ShellPaths,
  input: {
    readonly surfaceKind: string;
    readonly routeId?: string;
    readonly profileId: string;
    readonly label?: string;
  },
  options: ChannelStoreEffectOptions = {},
): Promise<ChannelProfileRouteAssignResult> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const surfaceKind = input.surfaceKind.trim();
  const profileId = input.profileId.trim();
  if (!surfaceKind) throw new Error('surfaceKind is required for channel-to-profile assignment.');
  if (!profileId) throw new Error('profileId is required for channel-to-profile assignment.');

  const path = channelProfileRouteFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  const snapshot = readChannelProfileRoutes(shellPaths);
  const now = new Date().toISOString();

  // Find existing assignment for the same (surfaceKind, routeId) pair
  const routeId = input.routeId?.trim() || undefined;
  const existingIndex = snapshot.routes.findIndex(
    (r) => r.surfaceKind === surfaceKind && r.routeId === routeId,
  );
  const existing = existingIndex >= 0 ? snapshot.routes[existingIndex] : null;
  const created = !existing;

  const draft: ChannelProfileRoute = {
    version: ROUTE_VERSION,
    id: existing?.id ?? `cpr-${randomUUID()}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    surfaceKind,
    profileId,
    ...(routeId ? { routeId } : {}),
    ...(labelFor(input.label, existing?.label) ? { label: labelFor(input.label, existing?.label)! } : {}),
    daemonSyncState: 'pending',
    // The daemon keeps routing on the assignment it already holds until it is told otherwise,
    // so a refused re-assignment must not forget which one that is.
    ...(existing?.daemonAssignmentId ? { daemonAssignmentId: existing.daemonAssignmentId } : {}),
  };

  const daemon = await offerRouteToDaemon(options.invoke, draft, { ...options, assertCurrent });
  assertCurrent();
  const route = withSyncOutcome(draft, daemon);

  // The daemon call above can take a while. Merge this assignment into the file
  // as it is now, not the snapshot from before the await, so a route removed or
  // assigned by another writer in the meantime is not undone.
  const stored = updateRoutes(path, (fresh) => {
    const freshIndex = fresh.findIndex((r) => r.id === route.id || (r.surfaceKind === surfaceKind && r.routeId === routeId));
    const merged = freshIndex >= 0 ? { ...route, id: fresh[freshIndex]!.id, createdAt: fresh[freshIndex]!.createdAt } : route;
    const updatedRoutes = freshIndex >= 0
      ? fresh.map((r, i) => (i === freshIndex ? merged : r))
      : [merged, ...fresh];
    return { value: merged, routes: updatedRoutes };
  }, assertCurrent);
  // The daemon just answered, so assignments held while it could not be reached
  // are offered now instead of waiting for the operator to repeat each one.
  const heldOffered = daemon.synced && options.invoke
    ? await syncChannelProfileRoutes(shellPaths, options.invoke, { signal: options.signal, assertCurrent: options.assertCurrent })
    : undefined;
  return { route: stored, path, created, daemon, ...(heldOffered && heldOffered.attempted > 0 ? { heldOffered } : {}) };
}

export interface ChannelProfileRouteSyncReport {
  readonly attempted: number;
  readonly synced: number;
  readonly refused: number;
  readonly routes: readonly ChannelProfileRoute[];
  /** Routes removed locally while offered whose withdrawal from the daemon failed; the daemon may still route on them. */
  readonly withdrawFailed: readonly { readonly routeId: string; readonly assignmentId: string; readonly error: string }[];
}

/**
 * Offer every assignment the daemon does not hold.
 *
 * This is both the retry for an assignment made while the daemon was
 * unreachable and the migration for records written before the daemon held
 * this table at all (the retired `local_only` state reads as pending). Each
 * row's own `daemonSyncState` and `syncError` record the outcome; the report
 * says what happened in this run.
 */
export async function syncChannelProfileRoutes(
  shellPaths: ShellPaths,
  invoke: DaemonOperatorInvoke,
  options: Pick<ChannelStoreEffectOptions, 'signal' | 'assertCurrent'> = {},
): Promise<ChannelProfileRouteSyncReport> {
  const snapshot = readChannelProfileRoutes(shellPaths);
  const pending = snapshot.routes.filter((route) => route.daemonSyncState !== 'synced');
  if (pending.length === 0) {
    return { attempted: 0, synced: 0, refused: 0, routes: snapshot.routes, withdrawFailed: [] };
  }

  const updatedById = new Map<string, ChannelProfileRoute>();
  const pendingById = new Map(pending.map((route) => [route.id, route] as const));
  let synced = 0;
  let refused = 0;

  for (const route of pending) {
    // The store syncing itself is not a person asking, so it does not claim to be.
    const outcome = await offerRouteToDaemon(invoke, route, { ...options, explicitUserRequest: false });
    updatedById.set(route.id, withSyncOutcome(route, outcome));
    if (outcome.synced) synced += 1;
    else refused += 1;
  }

  // Apply each outcome to the file as it is after the awaits: a route removed
  // while the daemon was answering stays removed, and one reassigned meanwhile
  // keeps its newer content. The outcome describes the copy that was offered.
  const path = channelProfileRouteFilePath(shellPaths);
  const vanished: { readonly route: ChannelProfileRoute; readonly assignmentId: string }[] = [];
  const routes = updateRoutes(path, (fresh) => {
    for (const [id, next] of updatedById) {
      if (next.daemonSyncState === 'synced' && next.daemonAssignmentId && !fresh.some((r) => r.id === id)) vanished.push({ route: next, assignmentId: next.daemonAssignmentId });
    }
    const merged = fresh.map((route) => {
      const offered = pendingById.get(route.id);
      return offered && offered.updatedAt === route.updatedAt && offered.profileId === route.profileId
        ? (updatedById.get(route.id) ?? route)
        : route;
    });
    return { value: merged, routes: merged };
  });
  // A route removed locally while its offer was in flight can still have been
  // taken by the daemon; withdraw it there so the removal is not undone. A
  // withdrawal that fails is reported with the assignment id, since no local
  // row is left to retry from.
  const withdrawFailed: { routeId: string; assignmentId: string; error: string }[] = [];
  for (const { route, assignmentId } of vanished) {
    let error: string | undefined;
    try {
      const result = await invoke(CHANNEL_ROUTING_DELETE_METHOD, { assignmentId, confirm: true }, { ...options, explicitUserRequest: false });
      if (!result.ok) error = result.error;
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    if (error !== undefined) withdrawFailed.push({ routeId: route.id, assignmentId, error });
  }
  return { attempted: pending.length, synced, refused, routes, withdrawFailed };
}

/** One line per outcome of a sync run, for a caller to print. */
export function formatChannelProfileRouteSyncReport(report: ChannelProfileRouteSyncReport): string {
  if (report.attempted === 0 && report.withdrawFailed.length === 0) return 'No held channel routes to offer.';
  return [
    `Held channel routes offered to the daemon: ${report.attempted} (${report.synced} taken, ${report.refused} still held)`,
    ...report.withdrawFailed.map((failure) => `  route ${failure.routeId} was removed here but the daemon still holds assignment ${failure.assignmentId}: ${failure.error}`),
  ].join('\n');
}

/** List all channel-to-profile assignments, optionally filtered by profileId. */
export function listChannelProfileRoutes(
  shellPaths: ShellPaths,
  options: { readonly profileId?: string; readonly surfaceKind?: string } = {},
): ChannelProfileRouteSnapshot {
  const snapshot = readChannelProfileRoutes(shellPaths);
  let routes = snapshot.routes;
  if (options.profileId) {
    routes = routes.filter((r) => r.profileId === options.profileId);
  }
  if (options.surfaceKind) {
    routes = routes.filter((r) => r.surfaceKind === options.surfaceKind || r.surfaceKind === 'any');
  }
  return { ...snapshot, routes };
}

/**
 * Get the profile id for an incoming channel message.
 *
 * Resolution order: exact (surfaceKind + routeId) → surface wildcard (surfaceKind only) → any wildcard.
 * Returns null if no assignment exists.
 */
export function getProfileForChannel(
  shellPaths: ShellPaths,
  surfaceKind: string,
  routeId?: string,
): string | null {
  const snapshot = readChannelProfileRoutes(shellPaths);
  const { routes } = snapshot;

  // Exact match: surfaceKind + routeId
  if (routeId) {
    const exact = routes.find((r) => r.surfaceKind === surfaceKind && r.routeId === routeId);
    if (exact) return exact.profileId;
  }

  // Surface match: surfaceKind only (no routeId on the assignment)
  const surfaceMatch = routes.find((r) => r.surfaceKind === surfaceKind && !r.routeId);
  if (surfaceMatch) return surfaceMatch.profileId;

  // Wildcard match
  // A stored `any:<routeId>` row (the daemon now refuses to create one) is not a global wildcard.
  const wildcard = routes.find((r) => r.surfaceKind === 'any' && !r.routeId);
  if (wildcard) return wildcard.profileId;

  return null;
}

/**
 * Remove a channel-to-profile assignment from this mirror only. Returns true if
 * removed. A route the daemon holds keeps routing there; use
 * `removeChannelProfileRouteEverywhere` to remove that one too.
 */
export function removeChannelProfileRoute(
  shellPaths: ShellPaths,
  routeId: string,
  options: ChannelStoreEffectOptions = {},
): boolean {
  const path = channelProfileRouteFilePath(shellPaths);
  const assertCurrent = retainChannelStoreSource(path, options);
  return updateRoutes(path, (routes) => {
    const updated = routes.filter((r) => r.id !== routeId);
    return updated.length === routes.length ? { value: false } : { value: true, routes: updated };
  }, assertCurrent);
}

/** What happened to the daemon's copy of a route being removed. */
export type ChannelProfileRouteDeleteOutcome =
  | { readonly status: 'deleted' }
  /** The daemon was never told about this route, so there is nothing to withdraw there. */
  | { readonly status: 'not_held' }
  | { readonly status: 'refused'; readonly kind: DaemonInvokeFailureKind | 'not_attempted'; readonly error: string };

export interface ChannelProfileRouteRemoveResult {
  /** True when the route is gone from this mirror. */
  readonly removed: boolean;
  readonly daemon: ChannelProfileRouteDeleteOutcome;
}

/**
 * Remove a route here and, when the daemon holds it, there.
 *
 * The daemon's table is the one the platform routes against, so a route it holds
 * keeps routing until the daemon drops it. The daemon is asked first, and the
 * local row stays when it does not answer, so the removal can be retried and the
 * mirror never claims a route is gone while the daemon still routes on it. A
 * route the daemon was never told about is removed locally.
 */
export async function removeChannelProfileRouteEverywhere(
  shellPaths: ShellPaths,
  routeId: string,
  options: ChannelStoreEffectOptions = {},
): Promise<ChannelProfileRouteRemoveResult> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const target = readChannelProfileRoutes(shellPaths).routes.find((r) => r.id === routeId);
  if (!target) return { removed: false, daemon: { status: 'not_held' } };
  let daemon: ChannelProfileRouteDeleteOutcome = { status: 'not_held' };
  // Any row that carries an assignment id is withdrawn, pending or not: a refused
  // re-assignment leaves the daemon routing on the id the row still holds.
  if (target.daemonAssignmentId) {
    if (!options.invoke) {
      return { removed: false, daemon: { status: 'refused', kind: 'not_attempted',
        error: 'the daemon holds this route and no connected-host transport was supplied to withdraw it, so it was not removed' } };
    }
    const result = await options.invoke(
      CHANNEL_ROUTING_DELETE_METHOD,
      { assignmentId: target.daemonAssignmentId, confirm: true },
      { signal: options.signal, assertCurrent: options.assertCurrent, explicitUserRequest: options.explicitUserRequest ?? true },
    );
    if (!result.ok) return { removed: false, daemon: { status: 'refused', kind: result.kind, error: result.error } };
    daemon = { status: 'deleted' };
  }
  const removed = removeChannelProfileRoute(shellPaths, routeId, { signal: options.signal, assertCurrent: options.assertCurrent });
  return { removed, daemon };
}

/** Format the routing table for human-readable output. */
export function formatChannelProfileRoutes(snapshot: ChannelProfileRouteSnapshot): string {
  const pending = snapshot.routes.filter((route) => route.daemonSyncState !== 'synced').length;
  const lines = [
    'Channel-to-Profile Routing',
    `  path: ${snapshot.path}`,
    `  total: ${snapshot.routes.length}`,
    `  daemon: ${snapshot.routes.length - pending} synced, ${pending} awaiting ${CHANNEL_ROUTING_ASSIGN_METHOD}`,
    `  status: ${snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty'}`,
    ...(snapshot.parseError ? [`  parse error: ${snapshot.parseError}`] : []),
    ...(snapshot.unreadableEntries ? [`  kept as found: ${snapshot.unreadableEntries} stored route${snapshot.unreadableEntries === 1 ? '' : 's'} this version cannot read`] : []),
    '',
  ];
  if (snapshot.routes.length === 0) {
    lines.push('  no channel-to-profile assignments');
  } else {
    for (const route of snapshot.routes) {
      const channelDesc = route.routeId ? `${route.surfaceKind}:${route.routeId}` : route.surfaceKind;
      lines.push(`  ${route.id}  channel=${channelDesc} → profile=${route.profileId}${route.label ? ` (${route.label})` : ''}  sync=${route.daemonSyncState}`);
      if (route.syncError) lines.push(`    daemon: ${route.syncError}`);
    }
  }
  return lines.join('\n');
}
