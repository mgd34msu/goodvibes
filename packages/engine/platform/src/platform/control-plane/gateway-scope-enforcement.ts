/**
 * gateway-scope-enforcement.ts
 *
 * Per-client delivery enforcement for the control-plane event fan-out. Two
 * orthogonal, AND-ed filters live here:
 *   1. Grant: what a principal may receive at all, resolved once when the
 *      stream or socket subscribes (and again only when its credential
 *      changes) from the event descriptors' access and scopes. Delivery is a
 *      set lookup.
 *   2. Domain: a broadcast event (published via `ControlPlaneGateway.publishEvent`,
 *      i.e. NOT flowing through a runtime-bus `onDomain` subscription) carries a
 *      `RuntimeEventDomain` tag; a client that opted into a narrower set of
 *      domains only receives events whose domain is in that set.
 */

import type { RuntimeEventDomain } from '../runtime/events/index.js';
import { OWN_SESSIONS_SCOPE, builtinGatewayEventDescriptors, gatewayEventAccess } from './method-catalog-events.js';
import { missingScopes } from '@goodvibes-jev/engine/daemon-api/route-helpers';

/** The subset of a live client this decision needs. */
export interface ScopedClientView {
  readonly kind: string;
  readonly admin?: boolean | undefined;
  readonly scopes?: readonly string[] | undefined;
}

/**
 * What one client may receive. `all` is true for a client nothing restricts:
 * an in-process or internal stream that carries no principal scopes, an
 * admin, or a `*` grant.
 */
export interface EventGrant {
  readonly all: boolean;
  /** Runtime domains the client may subscribe to. */
  readonly domains: ReadonlySet<RuntimeEventDomain>;
  /** Broadcast wire events the client may receive. */
  readonly wireEvents: ReadonlySet<string>;
  /**
   * The client holds `read:own-sessions`: beyond `domains` and `wireEvents`
   * it receives the turns, tool calls, approvals and lifecycle notices of the
   * sessions its own principal started, and of no other session.
   */
  readonly ownSessions?: true | undefined;
}

/**
 * `read:own-sessions` lets a credential without the admin role watch its own
 * work live: the `turn`, `tools`, `gate` and `session` frames, the approvals
 * (`approval-update`) and the hosted-session notices (`hosted-session-update`)
 * of the sessions its principal created or attached to. Every other session's
 * frames stay withheld.
 */
export { OWN_SESSIONS_SCOPE };
/** Runtime domains `read:own-sessions` opens, frame by frame, to the sessions the principal owns. */
export const OWN_SESSION_DOMAINS: ReadonlySet<RuntimeEventDomain> = new Set<RuntimeEventDomain>(['turn', 'tools', 'gate', 'session']);
/** Broadcast events `read:own-sessions` opens, event by event, to the sessions the principal owns. */
export const OWN_SESSION_WIRE_EVENTS: ReadonlySet<string> = new Set(['approval-update', 'hosted-session-update']);

/**
 * Whether delivering `event` to a client rests only on its own-sessions grant,
 * so the frame's session must be one the client's principal owns.
 */
export function grantNeedsOwnedSession(grant: EventGrant, event: string): boolean {
  if (grant.all || grant.ownSessions !== true) return false;
  if (grant.wireEvents.has(event) || grant.domains.has(event as RuntimeEventDomain)) return false;
  return OWN_SESSION_WIRE_EVENTS.has(event) || OWN_SESSION_DOMAINS.has(event as RuntimeEventDomain);
}

export const FULL_EVENT_GRANT: EventGrant = Object.freeze({
  all: true,
  domains: new Set<RuntimeEventDomain>(),
  wireEvents: new Set<string>(),
});

/** Every wire event a builtin descriptor declares (runtime domains included, their wire event is the domain name). */
const DECLARED_WIRE_EVENTS: ReadonlySet<string> = new Set(
  builtinGatewayEventDescriptors.flatMap((descriptor) => descriptor.wireEvents ?? []),
);

/**
 * Resolve, once, what a client may receive. A client that carries a
 * principal's scopes and is not an admin is restricted, whatever kind it calls
 * itself (a socket names its own kind); for it an event is granted when its
 * descriptor's access is open to a non-admin and it holds every scope the
 * descriptor lists. In-process and internal streams carry no scopes.
 */
export function resolveEventGrant(client: Omit<ScopedClientView, 'kind'>): EventGrant {
  if (client.admin || client.scopes === undefined || client.scopes.includes('*')) return FULL_EVENT_GRANT;
  const domains = new Set<RuntimeEventDomain>();
  const wireEvents = new Set<string>();
  for (const descriptor of builtinGatewayEventDescriptors) {
    if (gatewayEventAccess(descriptor) === 'admin') continue;
    if (missingScopes(client.scopes, descriptor.scopes).length > 0) continue;
    if (descriptor.category === 'runtime-domain') {
      for (const domain of descriptor.domains ?? []) domains.add(domain);
    } else {
      for (const event of descriptor.wireEvents ?? []) wireEvents.add(event);
    }
  }
  return { all: false, domains, wireEvents, ...(missingScopes(client.scopes, [OWN_SESSIONS_SCOPE]).length === 0 ? { ownSessions: true as const } : {}) };
}

/** Whether the grant lets the client receive anything at all. */
export function isEmptyEventGrant(grant: EventGrant): boolean {
  return !grant.all && grant.domains.size === 0 && grant.wireEvents.size === 0 && grant.ownSessions !== true;
}

/** Whether the grant covers a runtime domain subscription (an own-sessions domain is then filtered frame by frame). */
export function grantAllowsDomain(grant: EventGrant, domain: RuntimeEventDomain): boolean {
  return grant.all || grant.domains.has(domain) || (grant.ownSessions === true && OWN_SESSION_DOMAINS.has(domain));
}

/**
 * Whether the grant covers one delivered event (a broadcast wire event, or a
 * runtime domain frame named by its domain). An event no builtin descriptor
 * declares (a companion chat chunk, a plugin's event) reaches a restricted
 * client only when it was addressed to that client by id.
 */
export function grantAllowsEvent(grant: EventGrant, event: string, addressedToClient: boolean): boolean {
  if (grant.all || grant.wireEvents.has(event) || grant.domains.has(event as RuntimeEventDomain)) return true;
  // Own-sessions events pass here; the gateway then checks the frame's session (grantNeedsOwnedSession).
  if (grant.ownSessions === true && (OWN_SESSION_WIRE_EVENTS.has(event) || OWN_SESSION_DOMAINS.has(event as RuntimeEventDomain))) return true;
  return addressedToClient && !DECLARED_WIRE_EVENTS.has(event);
}

/**
 * Maps a manually-broadcast wire event (published via
 * `ControlPlaneGateway.publishEvent`) to the `RuntimeEventDomain` a client must
 * have subscribed to in order to receive it. These events do NOT flow through a
 * runtime-bus `onDomain` subscription, that path is already domain-scoped by the
 * subscription itself, so without this map the fan-out ignored the subscriber's
 * declared domains and over-delivered (e.g. `session-update` reached the webui,
 * which declares no `session` domain and dropped it as inert).
 *
 * An event ABSENT from this map carries no domain tag and is delivered to every
 * permitted client regardless of its subscribed domains (deliver-all). That
 * keeps domain scoping strictly opt-in narrowing: a newly-added broadcast event
 * cannot be silently dropped just because it is not yet tagged here.
 */
export const EVENT_DOMAIN: Readonly<Record<string, RuntimeEventDomain>> = {
  'session-update': 'session',
  'approval-update': 'gate',
  // Questions and other owner-inbox items, beside the approvals they are listed with.
  'owner-inbox-update': 'gate',
  // `session-detached` and `session-deleted` are payload discriminants inside
  // `session-update` today; tagged here so a promotion to a top-level broadcast
  // stays in the session domain.
  'session-detached': 'session',
  'session-deleted': 'session',
  // The hosted-session engine's lifecycle channel. Turn content is NOT here, it
  // rides the `turn`/`tools` runtime domains (see method-catalog-hosted-sessions.ts).
  'hosted-session-update': 'session',
};

/**
 * Whether a live client that subscribed to `clientDomains` should receive
 * `event` under the domain filter.
 *
 * `clientDomains === null` means the client did NOT opt into domain narrowing
 * (it connected with no `?domains=` param) and receives everything its grant
 * allows. An event with no `EVENT_DOMAIN` tag is always delivered, so narrowing
 * can only remove events attributed to a domain the client did not subscribe to.
 */
export function clientMayReceiveEventDomain(
  clientDomains: ReadonlySet<RuntimeEventDomain> | null,
  event: string,
): boolean {
  if (clientDomains === null) return true;
  const domain = EVENT_DOMAIN[event];
  if (domain === undefined) return true;
  return clientDomains.has(domain);
}
