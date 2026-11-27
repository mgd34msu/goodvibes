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
 * There is no route the daemon serves outside the checks a method passes: an effect row and an alias go through the
 * same folder check, reach check, owner's shared things and owner decision before the route runs (daemon/http/router.ts
 * `admit`, `decide`; the socket's method-and-path call too). So an effect row declares, as a method does, what it
 * addresses (`addresses`): each input naming a record by id, its kind or why it names none
 * (control-plane/record-addresses.ts: the one reach check reads it; a path parameter is a named group of `path`), the
 * inputs naming a folder a turn or process works in (`workFolders`) and a file on this disk (`daemonFiles`), and how the
 * owner's decision of it is made (`decided`: `none`, it changes nothing the owner decides; or the route decides it itself,
 * saying where). A row without them, or with a path parameter named like an id that it does not declare, stops the
 * router, as an undeclared method input stops the catalog. An alias is held to its method, with the path parameters its
 * method's path names.
 *
 * Cost: one regex scan of this list, only for a path with no catalog binding.
 */
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../../control-plane/method-catalog.js';
import { declareRouteAddresses, type Addressed } from '../../control-plane/record-addresses.js';
import { isEffectId, type EffectId } from '../../security/effect-authority.js';

/** What an effect row addresses, declared as a method's inputs are (see the file's comment). */
export interface DaemonRouteAddresses {
  /** Each path parameter (a named group of the row's `path`) and body or query input that names a record by id. */
  readonly inputs: Readonly<Record<string, Addressed>>;
  /** The inputs naming a folder a turn or process will work in (the folder check). */
  readonly workFolders?: readonly string[] | undefined;
  /** The inputs naming a file on this disk (the folder check's file rule). */
  readonly daemonFiles?: readonly string[] | undefined;
  /** `none`: it changes nothing the owner decides; else the route decides it itself, and where. */
  readonly decided: 'none' | { readonly byRoute: string };
}

export type DaemonRouteDeclaration =
  | { readonly method: string; readonly path: RegExp; readonly id: string; readonly kind: 'alias'; readonly aliasOf: { readonly method: string; readonly path: string } }
  | { readonly method: string; readonly path: RegExp; readonly id: string; readonly kind: 'effects'; readonly effects: readonly EffectId[]; readonly addresses: DaemonRouteAddresses }
  | { readonly method: string; readonly path: RegExp; readonly id: string; readonly kind: 'public' | 'own-credential' | 'retired'; readonly reason: string };

const ANY = '*';
const NOTHING: DaemonRouteAddresses = { inputs: {}, decided: 'none' };

export const DAEMON_ROUTE_MANIFEST: readonly DaemonRouteDeclaration[] = [
  // Held to an effect, and to every check a method passes.
  // The kept events, each filtered by what its reader may reach (control-plane/event-reach.ts).
  { method: 'GET', path: /^\/api\/control-plane\/recent-events$/, id: 'route GET /api/control-plane/recent-events', kind: 'effects', effects: ['events.control-plane'], addresses: NOTHING },
  { method: 'GET', path: /^\/api\/sessions\/(?<sessionId>[^/]+)\/events$/, id: 'route GET /api/sessions/:id/events', kind: 'effects', effects: ['sessions.inspect'],
    addresses: { inputs: { sessionId: 'session' }, decided: 'none' } },
  // `GET /task/{agentId}` is the catalog's `tasks.status` and `POST /task` its `tasks.create`; the bare GET answers
  // nothing here (daemon-api tasks.ts leaves it to an extension router).
  { method: 'GET', path: /^\/task$/, id: 'route GET /task', kind: 'effects', effects: ['tasks.read'], addresses: NOTHING },
  // Discarding a knowledge-ingest upload the owner refused (media-routes.ts handleArtifactDiscard): the upload's own
  // effect, on an upload its caller may reach (a file is its maker's: caller-reach.ts `artifact`).
  { method: 'DELETE', path: /^\/api\/artifacts\/(?<artifactId>[^/]+)$/, id: 'route DELETE /api/artifacts/:id', kind: 'effects', effects: ['artifacts.administer'],
    addresses: { inputs: { artifactId: 'artifact' }, decided: 'none' } },
  // Aliases of a cataloged path.
  { method: 'GET', path: /^\/api\/events$/, id: 'route GET /api/events', kind: 'alias', aliasOf: { method: 'GET', path: '/api/control-plane/events' } },
  { method: 'PATCH', path: /^\/api\/channels\/policies\/[^/]+$/, id: 'route PATCH /api/channels/policies/:surface', kind: 'alias', aliasOf: { method: 'POST', path: '/api/channels/policies/x' } },
  { method: 'GET', path: /^\/api\/knowledge\/graphql$/, id: 'route GET /api/knowledge/graphql', kind: 'alias', aliasOf: { method: 'POST', path: '/api/knowledge/graphql' } },
  { method: 'GET', path: /^\/api\/homeassistant\/home-graph\/map$/, id: 'route GET /api/homeassistant/home-graph/map', kind: 'alias', aliasOf: { method: 'POST', path: '/api/homeassistant/home-graph/map' } },
  { method: 'GET', path: /^\/api\/homeassistant$/, id: 'route GET /api/homeassistant', kind: 'alias', aliasOf: { method: 'GET', path: '/api/homeassistant/health' } },
  { method: 'GET', path: /^\/api\/batch(?:\/config)?$/, id: 'route GET /api/batch', kind: 'alias', aliasOf: { method: 'GET', path: '/api/batch/runtime' } },
  { method: 'GET', path: /^\/api\/cloudflare$/, id: 'route GET /api/cloudflare', kind: 'alias', aliasOf: { method: 'GET', path: '/api/cloudflare/status' } },
  { method: 'GET', path: /^\/api\/cloudflare\/token\/requirements$/, id: 'route GET /api/cloudflare/token/requirements', kind: 'alias', aliasOf: { method: 'POST', path: '/api/cloudflare/token/requirements' } },
  // No effect row, with the reason.
  { method: ANY, path: /^\/(?:healthz?)?$/, id: 'route /, /health, /healthz', kind: 'public', reason: 'liveness and the web UI shell: no credential, no effect' },
  { method: 'GET', path: /^\/status$/, id: 'route GET /status', kind: 'public', reason: 'liveness for the installer and service managers' },
  { method: 'POST', path: /^\/(?:login|logout)$/, id: 'route POST /login, /logout', kind: 'public', reason: 'signing in and out (auth.sign-in)' },
  { method: 'POST', path: /^\/api\/browser-session\/node(?:\/end)?$/, id: 'route POST /api/browser-session/node(/end)', kind: 'own-credential', reason: 'the web UI phone node: authenticated by the remote peer token it presents (the peer routes\' own check), held to the daemon\'s own origin, and bound to its own HttpOnly cookie scoped to /api/remote; /end clears it (browser-session.ts)' },
  { method: 'POST', path: /^\/api\/control-plane\/programs\/expect$/, id: 'route POST /api/control-plane/programs/expect', kind: 'public', reason: 'a program on the daemon\'s own machine names a secret of its own before it connects to the program socket, so the daemon can prove it is the daemon behind this listener (program-socket.ts expectProgramNonce); from this machine only, it grants nothing and reads nothing' },
  { method: 'POST', path: /^\/api\/browser-session$/, id: 'route POST /api/browser-session', kind: 'own-credential', reason: 'the web UI sign-in: authenticated by the code, token or password it presents (a password through POST /login\'s handler), held to the daemon\'s own origin, and bound to an HttpOnly cookie (browser-session.ts)' },
  { method: 'POST', path: /^\/webhook(?:\/github)?$/, id: 'route POST /webhook', kind: 'own-credential', reason: 'authenticated by the webhook secret or the GitHub signature, then admitted as hook.fire (http-listener.ts)' },
  { method: 'POST', path: /^\/api\/v1\/telemetry\/otlp\/v1\/(?:logs|traces|metrics)$/, id: 'route POST /api/v1/telemetry/otlp/v1/*', kind: 'own-credential', reason: 'authenticated by the telemetry ingest credential an exporter holds (telemetry-routes.ts authenticateTelemetryIngest)' },
  { method: ANY, path: /^\/api\/projects\/planning\/(?:state|evaluate|language)$/, id: 'route POST /api/projects/planning/*', kind: 'retired', reason: 'answers 410 to everyone: the planning interview is retired and nothing runs' },
];

/** Where the Agent's own knowledge is served: the `/api/knowledge` routes over another store, held to the same methods. */
export const AGENT_KNOWLEDGE_PREFIX = '/api/goodvibes-agent/knowledge';

/**
 * The cataloged path a request path is served as: a path under the Agent
 * knowledge prefix is the `/api/knowledge` path with the same suffix; any
 * other path is itself. The router serves the alias at this path and the gate
 * and the replay key look the method up by it, so the two cannot drift.
 */
export function catalogPathname(pathname: string): string {
  if (pathname !== AGENT_KNOWLEDGE_PREFIX && !pathname.startsWith(`${AGENT_KNOWLEDGE_PREFIX}/`)) return pathname;
  return `/api/knowledge${pathname.slice(AGENT_KNOWLEDGE_PREFIX.length)}`;
}

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
  return declaredRouteTarget(catalog, method, pathname)?.descriptor ?? null;
}

/** What a route is checked as: the method it is (or an alias serves), or its effect row's declaration, and the values its path names. */
export interface DaemonRouteTarget {
  readonly descriptor: Pick<GatewayMethodDescriptor, 'id' | 'access' | 'scopes' | 'ownerOnly' | 'effects' | 'workFolders' | 'daemonFiles'> & Partial<Pick<GatewayMethodDescriptor, 'http' | 'risk'>>;
  /** The path's `{param}` (a method's) or named group (an effect row's) values. */
  readonly params: Readonly<Record<string, string>>;
  /** The method served, when the route is a catalog method's binding or an alias of one. */
  readonly method?: GatewayMethodDescriptor | undefined;
}

/** A method's path template's `{param}` values in `pathname`, or undefined when the two do not fit. */
export function pathParamsOfTemplate(template: string, pathname: string): Record<string, string> | undefined {
  const want = (template.replace(/\/+$/, '') || '/').split('/');
  const parts = (pathname.replace(/\/+$/, '') || '/').split('/');
  if (want.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index]!;
    if (!segment.startsWith('{') || !segment.endsWith('}')) continue;
    try { params[segment.slice(1, -1)] = decodeURIComponent(parts[index]!); } catch { params[segment.slice(1, -1)] = parts[index]!; }
  }
  return params;
}

/**
 * Every route the router serves after authentication, as the checks read it: a catalog method's binding (the method,
 * its path's values), an alias (the method it serves, the values the request path gives that method's path), or an
 * effect row (its declaration, its named groups' values). Null: a route declared with a reason (public, its own
 * credential, retired), or none at all.
 */
export function declaredRouteTarget(catalog: Pick<GatewayMethodCatalog, 'findByHttpBinding'>, method: string, pathname: string): DaemonRouteTarget | null {
  const bound = catalog.findByHttpBinding(method, pathname);
  if (bound) return { descriptor: bound, method: bound, params: bound.http ? pathParamsOfTemplate(bound.http.path, pathname) ?? {} : {} };
  const entry = declaredRoute(method, pathname);
  if (!entry) return null;
  if (entry.kind === 'alias') {
    const served = catalog.findByHttpBinding(entry.aliasOf.method, entry.aliasOf.path);
    if (!served) return null;
    return { descriptor: served, method: served, params: served.http ? pathParamsOfTemplate(served.http.path, pathname) ?? {} : {} };
  }
  if (entry.kind === 'effects') {
    const groups = entry.path.exec(pathname)?.groups ?? {};
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(groups)) {
      if (typeof value !== 'string') continue;
      try { params[name] = decodeURIComponent(value); } catch { params[name] = value; }
    }
    return {
      descriptor: {
        id: entry.id, access: 'authenticated', scopes: [], ownerOnly: false, effects: [...entry.effects],
        ...(entry.addresses.workFolders ? { workFolders: [...entry.addresses.workFolders] } : {}),
        ...(entry.addresses.daemonFiles ? { daemonFiles: [...entry.addresses.daemonFiles] } : {}),
        risk: 'none',
      },
      params,
    };
  }
  return null;
}

/** The named groups of a route's path regex. */
function namedGroupsOf(path: RegExp): string[] {
  return [...path.source.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((match) => match[1]!);
}

/**
 * Refuses, when the router is built, a manifest whose alias names no cataloged method, whose row names no effect, or
 * whose effect row does not declare what it addresses (each path parameter named like an id, its kind or why it names
 * none) and how the owner's decision of it is made. Registers each effect row's addresses for the one reach check.
 */
export function assertDaemonRouteManifest(catalog: Pick<GatewayMethodCatalog, 'findByHttpBinding'>): void {
  const problems: string[] = [];
  for (const entry of DAEMON_ROUTE_MANIFEST) {
    if (entry.kind === 'alias' && !catalog.findByHttpBinding(entry.aliasOf.method, entry.aliasOf.path)) {
      problems.push(`${entry.id} is declared an alias of ${entry.aliasOf.method} ${entry.aliasOf.path}, which no catalog method binds`);
    }
    if (entry.kind === 'effects' && (entry.effects.length === 0 || entry.effects.some((id) => !isEffectId(id)))) {
      problems.push(`${entry.id} names no effect, or one the effect table does not have`);
    }
    if (entry.kind === 'effects') {
      const addresses = (entry as { readonly addresses?: DaemonRouteAddresses }).addresses;
      if (!addresses || typeof addresses.inputs !== 'object' || addresses.inputs === null) {
        problems.push(`${entry.id} does not declare what it addresses (addresses.inputs): every route is held to the checks a method is`);
      } else {
        if (addresses.decided !== 'none' && (typeof addresses.decided !== 'object' || !addresses.decided.byRoute?.trim())) {
          problems.push(`${entry.id} does not say how the owner's decision of it is made (addresses.decided)`);
        }
        problems.push(...declareRouteAddresses(entry.id, namedGroupsOf(entry.path), addresses.inputs).map((input) => `${entry.id} takes ${input} by id without declaring what it addresses`));
      }
    }
    if ((entry.kind === 'public' || entry.kind === 'own-credential' || entry.kind === 'retired') && entry.reason.trim().length === 0) {
      problems.push(`${entry.id} is declared ${entry.kind} without a reason`);
    }
  }
  if (problems.length > 0) throw new Error(`The daemon's route manifest is not sound; the router was not built:\n${problems.join('\n')}`);
}
