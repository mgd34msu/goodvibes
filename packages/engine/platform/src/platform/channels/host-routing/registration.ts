// ---------------------------------------------------------------------------
// Channel routing surface, HANDLERS for the platform-defined methods
//   - channels.routing.list   (read-only)
//   - channels.routing.assign (admin, confirmation-gated; only surfaces that
//     consult the assignment, PROFILE_ROUTED_SURFACE_KINDS)
//   - channels.routing.delete (admin, dangerous, confirmation-gated)
//
// The platform's GatewayMethodCatalog already registered the canonical descriptors
// (id, input/output schema, access, scopes, dangerous) for these three method
// ids with `handler: undefined`. This module NEVER re-declares an id, schema,
// or descriptor: it looks each one up by id and attaches a typed handler via
// `registerCatalogHandlers`, flipping the builtin method from HTTP-fallback to
// in-process execution. Handler outputs match the platform output schemas exactly.
//
// Manual assign/delete require explicit confirmation. A call made with the
// Agent's credential requires fresh recorded native admission under current paired owner authority,
// retained through durable publication. Listing remains a read operation.
// ---------------------------------------------------------------------------

import type { RoutingHostContext as HandlerContext } from './registration-types.js';
import { assertConfirmed } from '../../control-plane/host-handlers.js';
import { isDelegatedCaller, runNativeMutation } from '../../control-plane/native-mutation.js';
import {
  registerCatalogHandlers,
  HandlerError,
  type CatalogHandlerEntry,
  type TypedHandler,
  type Unregister,
} from '../../control-plane/host-handlers.js';
import {
  buildChannelId,
  parseChannelId,
  RouteStore,
  toRouteListItem,
  type RoutingChannelRoute,
  type RoutingRouteListItem,
} from './route-store.js';
import { createRoutingResolver, WILDCARD_SURFACE, type RoutingResolver } from './routing-resolver.js';
import { ROUTE_SURFACE_KINDS } from '../../../events/routes.js';
import { CHANNEL_SURFACE_KINDS } from '../../../events/surfaces.js';

export { createInboxRouteResolver, type RouteResolver, type RouteResolverInput } from './inbox-bridge.js';
export {
  buildChannelId,
  parseChannelId,
  RouteStore,
  toRouteListItem,
  type RoutingChannelRoute,
  type RoutingRouteListItem,
} from './route-store.js';
export {
  createRoutingResolver,
  resolveProfile,
  WILDCARD_SURFACE,
  type RoutingResolver,
} from './routing-resolver.js';

// ---------------------------------------------------------------------------
// Wire shapes (derived from the platform contracts; NOT re-declared schemas).
//
// list   in : { profileId?, surfaceKind?, limit? }
//         out: { routes: [{ id, createdAt, updatedAt, surfaceKind, routeId?,
//                           profileId, label? }], total }   (platform route-item shape)
// assign in : { channelId?, surfaceKind, routeId?, profileId, label? }
//             out: { assignmentId, channelId?, surfaceKind, routeId?, profileId, label?, createdAt, updatedAt }
// delete in : { assignmentId }                        out: { deleted, assignmentId }
// ---------------------------------------------------------------------------

interface RoutingListBody {
  profileId?: unknown;
  surfaceKind?: unknown;
  limit?: unknown;
}
interface RoutingListResult {
  routes: RoutingRouteListItem[];
  total: number;
}

interface RoutingAssignBody {
  channelId?: unknown;
  surfaceKind?: unknown;
  routeId?: unknown;
  profileId?: unknown;
  label?: unknown;
}
interface RoutingAssignResult {
  assignmentId: string;
  channelId: string;
  surfaceKind: string;
  routeId?: string;
  profileId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

interface RoutingDeleteBody {
  assignmentId?: unknown;
}
interface RoutingDeleteResult {
  deleted: boolean;
  assignmentId: string;
}

const LIST_METHOD = 'channels.routing.list';
const ASSIGN_METHOD = 'channels.routing.assign';
const DELETE_METHOD = 'channels.routing.delete';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Route surfaces, the mail inbox (routed by provider name, not a delivery surface), and the wildcard. */
const KNOWN_SURFACE_KINDS: readonly string[] = [...ROUTE_SURFACE_KINDS, 'email', WILDCARD_SURFACE];

/**
 * The surfaces whose messages this daemon answers under an assigned profile:
 * every third-party channel, whose agents take the profile's model when they
 * start (daemon/channel-profile-assignment.ts), and the Slack, Discord and
 * email inboxes, which stamp each item with it (inbox-bridge.ts). The wildcard
 * reaches all of them. A terminal app, the web UI and services are the owner's
 * own surfaces, where the model is chosen in the surface itself, so an
 * assignment there would never apply and is refused.
 */
const PROFILE_ROUTED_SURFACE_KINDS: readonly string[] = [...CHANNEL_SURFACE_KINDS, 'email', WILDCARD_SURFACE];

/**
 * An assignment that can never match an inbound route is refused when it is
 * made, not left to look created. A surface the daemon does not route, a
 * surface that does not consult the assignment, or a surfaceKind/routeId that
 * disagrees with the channelId it came with, would be stored and silently
 * never apply.
 */
function assertAssignableChannel(channelId: string, surfaceKind: string | undefined, routeId: string | undefined): void {
  const parsed = parseChannelId(channelId);
  if (!KNOWN_SURFACE_KINDS.includes(parsed.surfaceKind)) {
    throw new HandlerError(
      `Unknown surfaceKind '${parsed.surfaceKind}'; use one of: ${PROFILE_ROUTED_SURFACE_KINDS.join(', ')}`,
      'ROUTING_INVALID_SURFACE_KIND',
      400,
    );
  }
  if (!PROFILE_ROUTED_SURFACE_KINDS.includes(parsed.surfaceKind)) {
    throw new HandlerError(
      `Not assigned: ${parsed.surfaceKind} is the owner's own surface, where the model is chosen in the surface itself, so this assignment would never apply. `
        + `Profile assignments apply to: ${PROFILE_ROUTED_SURFACE_KINDS.join(', ')}.`,
      'ROUTING_SURFACE_NOT_ROUTED',
      400,
    );
  }
  if (surfaceKind !== undefined && surfaceKind !== parsed.surfaceKind) {
    throw new HandlerError(
      `surfaceKind '${surfaceKind}' does not match channelId '${channelId}'; send one or the other`,
      'ROUTING_INVALID_CHANNEL_ID',
      400,
    );
  }
  // A routeId beside a channelId that names none would otherwise be dropped, storing a broader assignment than asked for.
  if (routeId !== undefined && parsed.routeId !== routeId) {
    throw new HandlerError(
      `routeId '${routeId}' does not match channelId '${channelId}'; send one or the other`,
      'ROUTING_INVALID_CHANNEL_ID',
      400,
    );
  }
  if (parsed.surfaceKind === WILDCARD_SURFACE && parsed.routeId !== undefined) {
    throw new HandlerError(
      `'${WILDCARD_SURFACE}' assigns a profile to every surface and cannot be limited to a route; use a specific surfaceKind with the route, or '${WILDCARD_SURFACE}' alone`,
      'ROUTING_INVALID_CHANNEL_ID',
      400,
    );
  }
}

function clampLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.floor(n));
}

/**
 * Routing surface handle. Satisfies the foundation `RoutingRegistration`
 * (`{ unregister, resolveProfileId }`) and exposes the live
 * {@link RoutingResolver} and {@link RouteStore} so the inbox surface and tests
 * can reuse routing resolution without going through the catalog.
 */
export interface RoutingRegistration {
  readonly unregister: Unregister;
  /** Explicit lazy readiness. Await before the synchronous resolver is used. */
  readonly initialize: () => Promise<void>;
  /** Stop admission and await all owned handlers/storage before replacement. */
  readonly close: () => Promise<void>;
  readonly resolveProfileId: (surfaceKind: string, routeId?: string) => string | null;
  readonly resolver: RoutingResolver;
  readonly store: RouteStore;
}

/**
 * Attach the channel-routing handlers to the platform gateway catalog held by `ctx`.
 *
 * The {@link RouteStore} is lazily initialized on first invocation (the
 * register contract is synchronous) so registration never blocks on disk I/O.
 * Await initialize() before using the synchronous resolver; catalog calls warm
 * storage lazily themselves. Await close() before transferring ownership.
 */
export function registerRoutingMethods(ctx: HandlerContext): RoutingRegistration {
  const descriptors = [LIST_METHOD, ASSIGN_METHOD, DELETE_METHOD].map((id) => {
    const descriptor = ctx.catalog.get(id);
    if (!descriptor) throw new HandlerError(`Unknown gateway method: ${id}`, 'METHOD_NOT_FOUND', 404);
    return descriptor;
  });
  const store = new RouteStore({ workingDirectory: ctx.workingDirectory });
  const rawResolver = createRoutingResolver(store);
  let closed = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  let mutationTail: Promise<unknown> = Promise.resolve();
  const closedError = (): HandlerError => new HandlerError('Routing surface is closed', 'ROUTING_SURFACE_CLOSED', 409);
  const own = <T>(operation: () => Promise<T>, mutation = false): Promise<T> => {
    if (closed) return Promise.reject(closedError());
    const work = (mutation ? mutationTail : Promise.resolve()).then(operation);
    active.add(work);
    if (mutation) mutationTail = work.then(() => {}, () => {});
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  const admit = (handler: TypedHandler<unknown, unknown>, mutation = false): TypedHandler<unknown, unknown> =>
    (input) => own(() => { input.context.signal?.throwIfAborted(); return handler(input); }, mutation);

  let initPromise: Promise<void> | null = null;
  const ensureInit = async (): Promise<void> => {
    if (!initPromise) {
      initPromise = store.init().then(() => {
        const recovered = store.recoveryNotice();
        if (recovered !== undefined) { try { ctx.recordReceipt?.(recovered); } catch { /* the log line stays */ } }
      }, (error: unknown) => {
        // Allow a later invocation to retry initialization.
        initPromise = null;
        throw error;
      });
    }
    await initPromise;
  };

  const listHandler: TypedHandler<RoutingListBody, RoutingListResult> = async ({ body }) => {
    await ensureInit();
    const profileId = optionalString(body.profileId);
    const surfaceKind = optionalString(body.surfaceKind);
    const routes = store.list({
      ...(profileId !== undefined ? { profileId } : {}),
      ...(surfaceKind !== undefined ? { surfaceKind } : {}),
    });
    const limit = clampLimit(body.limit);
    const limited = limit !== undefined ? routes.slice(0, limit) : routes;
    // `total` counts every matching assignment, as the drafts list does, so a
    // caller that asked for a page can tell there are more.
    // Project to the platform `channels.routing.list` item shape: emit `id`
    // (= assignmentId) and drop the daemon-internal `channelId`/`assignmentId`,
    // which additionalProperties:false forbids.
    const items = limited.map(toRouteListItem);
    return { routes: items, total: routes.length };
  };

  const assignHandler: TypedHandler<RoutingAssignBody, RoutingAssignResult> = async ({ body, context }) => {
    const autonomous = isDelegatedCaller(context);
    if (!autonomous) assertConfirmed(body, context);
    context.signal?.throwIfAborted();
    await ensureInit();
    const profileId = optionalString(body.profileId);
    if (profileId === undefined) {
      throw new HandlerError('profileId is required', 'ROUTING_INVALID_PROFILE_ID', 400);
    }
    // The platform contract accepts either a composite `channelId` or the
    // `surfaceKind` (+ optional `routeId`) parts. Prefer an explicit
    // channelId; otherwise build one from the parts.
    const explicitChannelId = optionalString(body.channelId);
    const surfaceKind = optionalString(body.surfaceKind);
    const routeId = optionalString(body.routeId);
    const channelId = explicitChannelId ?? (
      surfaceKind !== undefined ? buildChannelId(surfaceKind, routeId) : undefined
    );
    if (channelId === undefined) {
      throw new HandlerError('surfaceKind (or channelId) is required', 'ROUTING_INVALID_CHANNEL_ID', 400);
    }
    assertAssignableChannel(channelId, surfaceKind, routeId);
    const label = optionalString(body.label);
    const input = {
      channelId,
      profileId,
      ...(label !== undefined ? { label } : {}),
    };
    // The row this assignment read; an autonomous write applies only to it.
    const selected = autonomous ? store.selectRow('channel', channelId) : undefined;
    const { route, created } = await runNativeMutation({ host: ctx.nativeMutationHost, method: ASSIGN_METHOD, body, context,
      target: { channelId, current: selected?.target ?? null }, assertTargetCurrent: () => { if (closed) throw closedError(); },
      mutate: (assertCurrent, _admission, withPublication) => store.upsert(input, autonomous ? assertCurrent : undefined, withPublication, selected?.updatedAt) });
    // A surface that owns its own profiles can legitimately name one this host has never seen,
    // so a typo is surfaced to the operator log rather than refused.
    if (ctx.hasProfile !== undefined && !ctx.hasProfile(profileId)) {
      ctx.logger.warn('channels.routing.assign: no profile with this id is known to this host; the assignment was saved and applies only if the surface that owns profiles has it', {
        assignmentId: route.assignmentId,
        profileId,
      });
    }
    ctx.logger.info('channels.routing.assign', {
      assignmentId: route.assignmentId,
      channelId: route.channelId,
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      created,
      principalId: context.principalId,
    });
    const result: RoutingAssignResult = {
      assignmentId: route.assignmentId,
      channelId: route.channelId,
      surfaceKind: route.surfaceKind,
      profileId: route.profileId,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
    if (route.routeId !== undefined) result.routeId = route.routeId;
    if (route.label !== undefined) result.label = route.label;
    return result;
  };

  const deleteHandler: TypedHandler<RoutingDeleteBody, RoutingDeleteResult> = async ({ body, context }) => {
    const autonomous = isDelegatedCaller(context);
    if (!autonomous) assertConfirmed(body, context);
    context.signal?.throwIfAborted();
    await ensureInit();
    const assignmentId = optionalString(body.assignmentId);
    if (assignmentId === undefined) {
      throw new HandlerError('assignmentId is required; list the routes to find it.', 'ROUTING_INVALID_ASSIGNMENT_ID', 400);
    }
    const selected = autonomous ? store.selectRow('assignment', assignmentId) : undefined;
    const deleted = await runNativeMutation({ host: ctx.nativeMutationHost, method: DELETE_METHOD, body, context,
      target: { assignmentId, current: selected?.target ?? null }, assertTargetCurrent: () => { if (closed) throw closedError(); },
      mutate: (assertCurrent, _admission, withPublication) => store.delete(assignmentId, autonomous ? assertCurrent : undefined, withPublication, selected?.updatedAt) });
    ctx.logger.info('channels.routing.delete', {
      assignmentId,
      deleted,
      principalId: context.principalId,
    });
    return { deleted, assignmentId };
  };

  const entries: CatalogHandlerEntry[] = [
    { id: LIST_METHOD, handler: admit(listHandler as TypedHandler<unknown, unknown>) },
    {
      id: ASSIGN_METHOD,
      handler: admit(assignHandler as TypedHandler<unknown, unknown>, true),
    },
    {
      id: DELETE_METHOD,
      handler: admit(deleteHandler as TypedHandler<unknown, unknown>, true),
    },
  ];

  const teardownHandlers = registerCatalogHandlers(ctx.catalog, entries);

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    const errors: unknown[] = [];
    try { teardownHandlers(); } catch (error) { errors.push(error); }
    for (const descriptor of descriptors) {
      try { ctx.catalog.register(descriptor, undefined, { replace: true }); } catch (error) { errors.push(error); }
    }
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...active]);
      try { await store.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Routing surface did not close cleanly');
    });
    void closing.catch(() => {
      try { ctx.logger.warn('Routing surface did not close cleanly'); } catch { /* Preserve cleanup failure. */ }
    });
    return closing;
  };
  const resolve = (surfaceKind: string, routeId?: string): string | null => {
    if (closed) throw closedError();
    return rawResolver.getProfileForChannel(surfaceKind, routeId);
  };
  return {
    unregister: () => { void close(); },
    initialize: () => own(async () => {
      await ensureInit();
      // A stopped startup must not tell a new intake consumer it is ready.
      if (closed) throw closedError();
    }),
    close,
    resolveProfileId: resolve,
    resolver: { getProfileForChannel: resolve, resolveProfile: resolve },
    store,
  };
}

/**
 * Provider entry point consumed by `registerDaemonHandlers`
 * (`DaemonHandlerSurfaceProviders.registerRouting`).
 */
export const registerRouting = (ctx: HandlerContext): RoutingRegistration =>
  registerRoutingMethods(ctx);
