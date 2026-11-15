import { dispatchDaemonApiRoutes } from '@goodvibes-jev/engine/daemon-api';
import { GATEWAY_REST_ROUTES } from '@goodvibes-jev/engine/daemon-api';
import type { DaemonApiRouteHandlers } from '@goodvibes-jev/engine/daemon-api';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodCatalog } from './method-catalog.js';
import { MODEL_ROUTES } from '../daemon/http/model-routes.js';
import { MCP_ROUTES } from '../daemon/http/mcp-routes.js';
import { BATCH_ROUTES } from '../daemon/http/batch-routes.js';
import { CLOUDFLARE_ROUTES } from '../daemon/http/cloudflare-routes.js';
import { HOME_ASSISTANT_CONVERSATION_ROUTES } from '../daemon/http/homeassistant-routes.js';
import { HOME_GRAPH_ROUTES } from '../daemon/http/home-graph-routes.js';
import { PROJECT_PLANNING_ROUTES } from '../daemon/http/project-planning-routes.js';
import { COMPANION_CHAT_ROUTES } from '../companion/companion-chat-routes.js';

/**
 * method-catalog-route-reconcile.ts
 *
 * Advertisement-vs-route reconciliation. Every method descriptor that
 * carries an `http` binding is a promise to a caller: "this daemon actually
 * serves this endpoint." Nothing previously checked that promise against
 * the real dispatch table. method-catalog-email.ts's four email.* methods
 * advertised /api/email/* paths that no route handler anywhere has ever
 * served, so a caller invoking one through the generic method-dispatch
 * endpoint (control-plane.ts's invokeGatewayMethodCall, which synthesizes a
 * request from `http.path` and feeds it back into the real router) got a
 * plain 404 instead of an honest "this capability isn't wired up." The ad
 * lied; only a caller's own skepticism about the 404 stood between it and
 * treating the capability as real.
 *
 * This module answers, for a batch of descriptors, whether each one's http
 * binding actually resolves against the real dispatch pipeline:
 * `dispatchDaemonApiRoutes` from @goodvibes-jev/engine/daemon-api, the function
 * DaemonHttpRouter.dispatchApiRoutes (packages/platform/src/platform/daemon/http/
 * router.ts, read as this reconcile's route authority, never edited by it)
 * ultimately delegates to for every method-catalog family except the
 * sub-routers wired directly in router.ts ahead of that delegation, which
 * publish their own path tables (see DECLARED_SUB_ROUTER_ROUTES). The probe
 * dispatches a synthetic Request against handler stubs that only ever return a
 * fixed marker Response, no real service, manager, or handler body ever runs, so
 * probing stays side-effect free even for `dangerous: true` write methods
 * (email.send, automation job mutation, etc.).
 *
 * Scope note (read before extending): dispatchDaemonApiRoutes covers the
 * operator / automation / remote / session / task route families. Every
 * sub-router router.ts special-cases before it (MCP config, batch, Cloudflare,
 * Home Assistant, home graph, model routes, companion chat, project planning)
 * exports its path table, so a descriptor pointing at a path none of them serves
 * is reported 'unavailable' like any other. A new sub-router must export its
 * table and be listed in DECLARED_SUB_ROUTER_ROUTES, or its descriptors redden.
 */

export type RouteReconcileStatus = 'live' | 'unavailable' | 'unchecked';

export interface RouteReconcileResult {
  readonly methodId: string;
  readonly status: RouteReconcileStatus;
  readonly http: { readonly method: string; readonly path: string } | null;
  readonly reason: string;
}

export type RouteProbe = (method: string, path: string) => boolean | Promise<boolean>;

/**
 * Sub-routers that publish their own path table, so the probe can check them
 * for real instead of skipping them by prefix.
 *
 * `/api/models` was once skipped by prefix, and that is how `models.list`,
 * `models.current.get` and `models.current.set` stayed outside the method
 * catalog while every consumer called them: the reconcile's only question is
 * "does this descriptor's advertised path resolve", and a prefix it never looks
 * at cannot answer it either way. A sub-router that exports what it serves is
 * checkable, and a descriptor pointing at a path it does not serve reddens
 * exactly as it does for every route in the shared table.
 */
const DECLARED_SUB_ROUTER_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  ...MODEL_ROUTES,
  ...MCP_ROUTES,
  ...BATCH_ROUTES,
  ...CLOUDFLARE_ROUTES,
  ...HOME_ASSISTANT_CONVERSATION_ROUTES,
  ...HOME_GRAPH_ROUTES,
  ...PROJECT_PLANNING_ROUTES,
  ...COMPANION_CHAT_ROUTES,
];

/** Whether a declared path (`{param}` is one segment) serves this probe path. */
function declaredPathMatches(declared: string, path: string): boolean {
  const want = declared.split('/');
  const have = path.split('/');
  return want.length === have.length
    && want.every((segment, index) => (segment.startsWith('{') && segment.endsWith('}') ? have[index] !== '' : segment === have[index]));
}

/**
 * The method ids whose advertised path is served by the gateway REST table.
 *
 * These are the ones that dispatch into `catalog.invoke(methodId)`, so these
 * are the ones for which a registered handler is a REQUIREMENT rather than an
 * implementation detail. Every other served method reaches its own route
 * module's handler function and legitimately has none in the catalog.
 */
let gatewayRestMethodIdCache: ReadonlySet<string> | null = null;

function gatewayRestMethodIds(): ReadonlySet<string> {
  gatewayRestMethodIdCache ??= new Set(GATEWAY_REST_ROUTES.map((route) => route.methodId));
  return gatewayRestMethodIdCache;
}

/**
 * Whether a descriptor can only be answered by a catalog handler: it has no
 * HTTP binding (WebSocket and method dispatch reach `catalog.invoke`), or its
 * path is in the gateway REST table, which also dispatches into
 * `catalog.invoke`. A method served by its own route module, or one declared
 * `invokable: false`, needs none.
 */
function needsCatalogHandler(descriptor: GatewayMethodDescriptor): boolean {
  if (descriptor.invokable === false) return false;
  return !descriptor.http || gatewayRestMethodIds().has(descriptor.id);
}

/**
 * The ids a composed catalog advertises as callable and cannot answer: each
 * needs a catalog handler and has none, so every call to it gets a 501. One
 * pass over the descriptors with a map lookup each.
 */
export function findUnservedGatewayMethods(catalog: Pick<GatewayMethodCatalog, 'list' | 'hasHandler'>): string[] {
  return catalog.list()
    .filter((descriptor) => needsCatalogHandler(descriptor) && !catalog.hasHandler(descriptor.id))
    .map((descriptor) => descriptor.id)
    .sort();
}

/** Metadata key a start-up mark sets, so a client reads why the method is not callable. */
export const UNSERVED_METHOD_REASON_KEY = 'unservedReason';

/**
 * Makes the served catalog say what this daemon really does: every method
 * `findUnservedGatewayMethods` names is re-registered as `invokable: false`
 * with `metadata.unservedReason`, so a client reading the catalog sees it is
 * not callable, and why, instead of learning so from a 501. Returns the ids it
 * marked, for the start-up log. Call it once after composition and before the
 * scope policy bootstrap: the policy snapshot includes `invokable`, so marking
 * later is a policy change. A handler registered afterwards replaces the
 * marked descriptor as usual.
 */
export function markUnservedGatewayMethods(catalog: GatewayMethodCatalog): readonly string[] {
  const unserved = findUnservedGatewayMethods(catalog);
  for (const id of unserved) {
    const descriptor = catalog.get(id);
    if (!descriptor) continue;
    catalog.register({
      ...descriptor,
      invokable: false,
      metadata: { ...descriptor.metadata, [UNSERVED_METHOD_REASON_KEY]: 'This daemon has no handler for this method in its current configuration.' },
    }, undefined, { replace: true });
  }
  return unserved;
}

const RECONCILE_PROBE_MARKER = { reconcileProbeMarker: true };

/**
 * Replaces every `{param}` template segment with an opaque single-segment
 * placeholder. Every path-matching regex in the dispatch chain matches "one
 * non-slash segment" for a param slot, so a placeholder resolves the same
 * way a real id would without needing one.
 */
function resolveTemplatePath(template: string): string {
  return template.replace(/\{[^/}]+\}/g, 'reconcile-probe-placeholder');
}

/**
 * Builds a dispatchDaemonApiRoutes-backed probe: does *any* route in the
 * operator/automation/remote/session/task dispatch chain match this
 * method+path? Every handler in the stub is inert, a Proxy that returns a
 * single marker function for any property access, so it never needs
 * updating when DaemonApiRouteHandlers gains a field (the exact kind of
 * drift this reconcile exists to avoid reintroducing elsewhere).
 */
export function createDaemonApiRouteProbe(): RouteProbe {
  const marker = () => Response.json(RECONCILE_PROBE_MARKER);
  const inertHandlers = new Proxy(
    {},
    { get: () => marker },
  ) as unknown as DaemonApiRouteHandlers;

  return async (method, path) => {
    if (DECLARED_SUB_ROUTER_ROUTES.some((entry) => entry.method === method && declaredPathMatches(entry.path, path))) return true;
    const request = new Request(`http://reconcile-probe.invalid${path}`, { method });
    const response = await dispatchDaemonApiRoutes(request, inertHandlers);
    return response !== null;
  };
}

/** Reconciles a single descriptor's http binding (if any) against a probe. */
export async function reconcileHttpDescriptor(
  descriptor: GatewayMethodDescriptor,
  probe: RouteProbe,
): Promise<RouteReconcileResult> {
  if (!descriptor.http) {
    return { methodId: descriptor.id, status: 'unchecked', http: null, reason: 'no http binding to reconcile' };
  }
  const http = { method: descriptor.http.method, path: descriptor.http.path };
  const probePath = resolveTemplatePath(descriptor.http.path);
  const resolved = await probe(descriptor.http.method, probePath);
  if (!resolved) {
    return {
      methodId: descriptor.id,
      status: 'unavailable',
      http,
      reason: `no registered route serves ${descriptor.http.method} ${descriptor.http.path}`,
    };
  }
  return { methodId: descriptor.id, status: 'live', http, reason: 'route resolved via dispatchDaemonApiRoutes' };
}

/** Reconciles a full descriptor list against a probe, in catalog order. */
export async function reconcileCatalogRoutes(
  descriptors: readonly GatewayMethodDescriptor[],
  probe: RouteProbe,
): Promise<RouteReconcileResult[]> {
  const results: RouteReconcileResult[] = [];
  for (const descriptor of descriptors) {
    results.push(await reconcileHttpDescriptor(descriptor, probe));
  }
  return results;
}

/**
 * The regression gate. Every descriptor whose http binding was actually
 * checked (status !== 'unchecked') and resolved to no live route must
 * already be marked `invokable: false` at the source, i.e. the
 * advertisement itself must already say "don't call this" instead of
 * silently 404ing a caller who trusted it. Returns the ids that violate
 * that rule. A non-empty result means some descriptor is advertised as
 * live but isn't backed by a route, and isn't marked unavailable either,
 * an email.inbox.list-shaped regression. The capability route reconciliation
 * tests assert that the result is empty.
 */
export function findUnreconciledAdvertisements(
  descriptors: readonly GatewayMethodDescriptor[],
  results: readonly RouteReconcileResult[],
): string[] {
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor] as const));
  const violations: string[] = [];
  for (const result of results) {
    if (result.status !== 'unavailable') continue;
    const descriptor = descriptorsById.get(result.methodId);
    if (descriptor && descriptor.invokable !== false) {
      violations.push(result.methodId);
    }
  }
  return violations;
}
