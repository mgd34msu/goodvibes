/**
 * route-manifest.ts, every route the daemon serves that the method catalog
 * does not bind, declared with what it is held to.
 *
 * A route the router dispatches is either a catalog method's HTTP binding
 * (held to that method's effects by gateway-binding-gate.ts) or an entry here:
 * an alias of a cataloged path (held to that method), an effect row, or a
 * stated reason it needs none (public, its own credential, retired). There is
 * no third kind, so an authenticated route without an effect cannot exist:
 *  - `assertDaemonRouteManifest` runs when the router is built and refuses a
 *    manifest whose alias names no cataloged method or whose row names no effect;
 *  - `bun run architecture:check` (scripts/daemon-architecture-check.ts
 *    `undeclaredRouteProblems`) reads every route the dispatchers match and
 *    fails on one that is neither cataloged nor declared here.
 *
 * Cost: one regex scan of this list, only for a path with no catalog binding.
 */
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';
import { isEffectId, type EffectId } from '../../security/effect-authority.js';

export type DaemonRouteDeclaration =
  | { readonly method: string; readonly path: RegExp; readonly id: string; readonly kind: 'alias'; readonly aliasOf: { readonly method: string; readonly path: string } }
  | { readonly method: string; readonly path: RegExp; readonly id: string; readonly kind: 'effects'; readonly effects: readonly EffectId[] }
  | { readonly method: string; readonly path: RegExp; readonly id: string; readonly kind: 'public' | 'own-credential' | 'retired'; readonly reason: string };

const ANY = '*';

export const DAEMON_ROUTE_MANIFEST: readonly DaemonRouteDeclaration[] = [
  // ── Held to an effect ──
  { method: 'GET', path: /^\/api\/control-plane\/recent-events$/, id: 'route GET /api/control-plane/recent-events', kind: 'effects', effects: ['events.control-plane'] },
  { method: 'GET', path: /^\/api\/sessions\/[^/]+\/events$/, id: 'route GET /api/sessions/:id/events', kind: 'effects', effects: ['sessions.inspect'] },
  { method: 'POST', path: /^\/api\/mcp\/config\/servers\/[^/]+\/tools\/[^/]+(?:\/(?:allow|deny))?$/, id: 'route POST /api/mcp/config/servers/:server/tools/:tool/(allow|deny)', kind: 'effects', effects: ['mcp.administer', 'owner.act'] },
  { method: 'GET', path: /^\/config(?:\/credentials)?$/, id: 'route GET /config', kind: 'effects', effects: ['config.inspect'] },
  { method: 'POST', path: /^\/config(?:\/many|\/reset)?$/, id: 'route POST /config', kind: 'effects', effects: ['config.administer'] },
  { method: 'GET', path: /^\/task(?:\/[^/]+)?$/, id: 'route GET /task', kind: 'effects', effects: ['tasks.read'] },
  { method: 'POST', path: /^\/task$/, id: 'route POST /task', kind: 'effects', effects: ['tasks.administer'] },
  // ── Aliases of a cataloged path ──
  { method: 'GET', path: /^\/api\/events$/, id: 'route GET /api/events', kind: 'alias', aliasOf: { method: 'GET', path: '/api/control-plane/events' } },
  { method: 'PATCH', path: /^\/api\/channels\/policies\/[^/]+$/, id: 'route PATCH /api/channels/policies/:surface', kind: 'alias', aliasOf: { method: 'POST', path: '/api/channels/policies/x' } },
  { method: 'GET', path: /^\/api\/knowledge\/graphql$/, id: 'route GET /api/knowledge/graphql', kind: 'alias', aliasOf: { method: 'POST', path: '/api/knowledge/graphql' } },
  { method: 'GET', path: /^\/api\/homeassistant\/home-graph\/map$/, id: 'route GET /api/homeassistant/home-graph/map', kind: 'alias', aliasOf: { method: 'POST', path: '/api/homeassistant/home-graph/map' } },
  { method: 'GET', path: /^\/api\/homeassistant$/, id: 'route GET /api/homeassistant', kind: 'alias', aliasOf: { method: 'GET', path: '/api/homeassistant/health' } },
  { method: 'GET', path: /^\/api\/batch(?:\/config)?$/, id: 'route GET /api/batch', kind: 'alias', aliasOf: { method: 'GET', path: '/api/batch/runtime' } },
  { method: 'GET', path: /^\/api\/cloudflare$/, id: 'route GET /api/cloudflare', kind: 'alias', aliasOf: { method: 'GET', path: '/api/cloudflare/status' } },
  { method: 'GET', path: /^\/api\/cloudflare\/token\/requirements$/, id: 'route GET /api/cloudflare/token/requirements', kind: 'alias', aliasOf: { method: 'POST', path: '/api/cloudflare/token/requirements' } },
  // ── No effect row, with the reason ──
  { method: ANY, path: /^\/(?:healthz?)?$/, id: 'route /, /health, /healthz', kind: 'public', reason: 'liveness and the web UI shell: no credential, no effect' },
  { method: 'GET', path: /^\/status$/, id: 'route GET /status', kind: 'public', reason: 'liveness for the installer and service managers' },
  { method: 'POST', path: /^\/(?:login|logout)$/, id: 'route POST /login, /logout', kind: 'public', reason: 'signing in and out (auth.sign-in)' },
  { method: 'POST', path: /^\/api\/browser-session$/, id: 'route POST /api/browser-session', kind: 'own-credential', reason: 'the web UI sign-in: authenticated by the code, token or password it presents (a password through POST /login\'s handler), held to the daemon\'s own origin, and bound to an HttpOnly cookie (browser-session.ts)' },
  { method: 'POST', path: /^\/webhook(?:\/github)?$/, id: 'route POST /webhook', kind: 'own-credential', reason: 'authenticated by the webhook secret or the GitHub signature, then admitted as hook.fire (http-listener.ts)' },
  { method: 'POST', path: /^\/api\/v1\/telemetry\/otlp\/v1\/(?:logs|traces|metrics)$/, id: 'route POST /api/v1/telemetry/otlp/v1/*', kind: 'own-credential', reason: 'authenticated by the telemetry ingest credential an exporter holds (telemetry-routes.ts authenticateTelemetryIngest)' },
  { method: ANY, path: /^\/api\/projects\/planning\/(?:state|evaluate|language)$/, id: 'route POST /api/projects/planning/*', kind: 'retired', reason: 'answers 410 to everyone: the planning interview is retired and nothing runs' },
];

function matches(entry: DaemonRouteDeclaration, method: string, pathname: string): boolean {
  return (entry.method === ANY || entry.method === method) && entry.path.test(pathname);
}

/** The declaration for a route the catalog does not bind, or null when there is none. */
export function declaredRoute(method: string, pathname: string): DaemonRouteDeclaration | null {
  return DAEMON_ROUTE_MANIFEST.find((entry) => matches(entry, method, pathname)) ?? null;
}

/**
 * The rules an uncataloged route is held to: its alias's method, or its
 * effect row; null for a route declared with a reason (or not declared,
 * which the architecture check refuses before it can ship).
 */
export function declaredRouteDescriptor(
  catalog: Pick<GatewayMethodCatalog, 'findByHttpBinding'>, method: string, pathname: string,
): Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'ownerOnly' | 'effects'> | null {
  const entry = declaredRoute(method, pathname);
  if (!entry) return null;
  if (entry.kind === 'alias') return catalog.findByHttpBinding(entry.aliasOf.method, entry.aliasOf.path);
  if (entry.kind === 'effects') return { id: entry.id, access: 'authenticated', scopes: [], ownerOnly: false, effects: [...entry.effects] };
  return null;
}

/** Refuses, when the router is built, a manifest whose alias names no cataloged method or whose row names no effect. */
export function assertDaemonRouteManifest(catalog: Pick<GatewayMethodCatalog, 'findByHttpBinding'>): void {
  const problems: string[] = [];
  for (const entry of DAEMON_ROUTE_MANIFEST) {
    if (entry.kind === 'alias' && !catalog.findByHttpBinding(entry.aliasOf.method, entry.aliasOf.path)) {
      problems.push(`${entry.id} is declared an alias of ${entry.aliasOf.method} ${entry.aliasOf.path}, which no catalog method binds`);
    }
    if (entry.kind === 'effects' && (entry.effects.length === 0 || entry.effects.some((id) => !isEffectId(id)))) {
      problems.push(`${entry.id} names no effect, or one the effect table does not have`);
    }
    if ((entry.kind === 'public' || entry.kind === 'own-credential' || entry.kind === 'retired') && entry.reason.trim().length === 0) {
      problems.push(`${entry.id} is declared ${entry.kind} without a reason`);
    }
  }
  if (problems.length > 0) throw new Error(`The daemon's route manifest is not sound; the router was not built:\n${problems.join('\n')}`);
}
