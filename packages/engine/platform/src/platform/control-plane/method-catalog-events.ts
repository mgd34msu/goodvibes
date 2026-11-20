import type { GatewayEventDescriptor } from './method-catalog-shared.js';
import { STRING_SCHEMA,NUMBER_SCHEMA,JSON_OBJECT_SCHEMA,arraySchema,objectSchema,eventDescriptor,runtimeDomainEvent } from './method-catalog-shared.js';
import { CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA } from './operator-contract-schemas.js';
import { APPROVAL_READING_SCHEMA, ASK_PRESENTATION_SCHEMA, SHARED_APPROVAL_RECORD_SCHEMA } from './operator-contract-schemas-approvals.js';
import { OWNER_ITEM_SCHEMA } from './operator-contract-schemas-owner-inbox.js';
import { HOSTED_SESSION_RECORD_SCHEMA } from './method-catalog-hosted-sessions.js';
import { RUNTIME_EVENT_DOMAINS, type RuntimeEventDomain } from '../../events/domain-map.js';
import { EFFECTS, type EffectId } from '../security/effect-authority.js';

/**
 * The discriminated `event` values carried inside every `session-update` wire frame.
 *
 * The SharedSessionBroker collapses ALL of its lifecycle signals onto a single wire event
 * named `session-update` (session-broker.ts `publishUpdate`); the real lifecycle name lives
 * in the frame's `payload.event` field. This list is the source of truth for that
 * discriminant and is documented by the `control.session_update` descriptor below so a
 * subscriber (webui/TUI) can switch on `payload.event` against a contract-backed enum
 * instead of guessing from undocumented behavior.
 *
 * NOTE: new broker signals flow through the SAME
 * `session-update` wire channel automatically because `publishUpdate` is generic, when
 * the `sessions.register` flow emits e.g. `session-registered`, only THIS enum needs the
 * added string (the wire channel already carries it). Keep this list aligned with the
 * broker's publishUpdate/publishInputLifecycleEvent call sites.
 */
export const SESSION_UPDATE_WIRE_EVENTS = [
  'session-created',
  'session-closed',
  'session-deleted',
  'session-reopened',
  'session-permission-mode-changed',
  'session-agent-bound',
  'session-agent-completed',
  'session-message-appended',
  'session-message-forwarded',
  'session-route-attached',
  'session-detached',
  'session-input-queued',
  'session-input-queued-for-surface',
  'session-input-delivered',
  'session-input-spawned',
  'session-input-completed',
  'session-input-failed',
  'session-input-rejected',
  'session-input-cancelled',
  'session-follow-up-queued',
  'session-follow-up-spawned',
] as const;

/**
 * Maps each cross-surface invalidation intent to the concrete `payload.event` value(s) a
 * subscriber must react to. Documented in the descriptor so the webui/TUI do not guess.
 */
export const SESSION_UPDATE_INTENT_MAP = {
  created: ['session-created'],
  updated: ['session-permission-mode-changed', 'session-message-appended', 'session-agent-completed', 'session-route-attached', 'session-detached', 'session-reopened'],
  steered: ['session-input-queued-for-surface', 'session-input-delivered', 'session-message-forwarded'],
  closed: ['session-closed'],
  deleted: ['session-deleted'],
} as const satisfies Record<string, readonly (typeof SESSION_UPDATE_WIRE_EVENTS)[number][]>;

/** The intent mapping as prose, built from the map so the description cannot drift from it. */
function intentMappingText(): string {
  return Object.entries(SESSION_UPDATE_INTENT_MAP)
    .map(([intent, events]) => `${intent} \u21d0 ${events.join(' / ')}`)
    .join('; ');
}

/**
 * The lifecycle names carried in a `hosted-session-update` frame's
 * `payload.event`. Kept beside the descriptor so a subscriber switches on a
 * contract-backed list rather than guessing from observed behavior.
 */
export const HOSTED_SESSION_UPDATE_WIRE_EVENTS = [
  'hosted-session-created',
  'hosted-session-attached',
  'hosted-session-detached',
  'hosted-session-turn-started',
  'hosted-session-turn-ended',
  'hosted-session-terminated',
  'hosted-session-restored',
  'hosted-session-contract-started',
  'hosted-session-contract-notice',
] as const;

const RUNTIME_DOMAIN_DESCRIPTIONS = {
  session: 'Shared-session lifecycle, participant, and message events.',
  turn: 'Turn submission and completion events.',
  providers: 'Provider health, selection, and routing events.',
  tools: 'Tool start, result, and failure events.',
  tasks: 'Runtime task lifecycle and status events.',
  agents: 'Agent lifecycle, planning, and completion events.',
  contracts: 'Contract runner events: a contract from creation through shaping, planning and the plan checks, each unit and group status, every Jev check with its per-criterion readings, nudges and their consumption, regressions, stalls, planned fixes, owner escalations and replies, gates, commit, and the pass, failure or cancellation.',
  communication: 'Agent communication and policy events.',
  planner: 'Planner updates and plan mutation events.',
  gate: 'Gate events: each call through the deterministic boundary, its Jev stakes reading, the preset decision, approvals and preset changes.',
  plugins: 'Plugin registration and lifecycle events.',
  mcp: 'MCP server, tool, and connection events.',
  transport: 'Transport connect, disconnect, and lifecycle events.',
  compaction: 'Context compaction and summary events.',
  ui: 'Terminal app panel and view changes: UI_PANEL_OPEN, UI_PANEL_CLOSE, UI_PANEL_FOCUS (panelId) and UI_VIEW_CHANGED (from, to: main, agent:<id> or process:<id>), published by the TUI and the Agent as they happen.',
  ops: 'Operational diagnostics and control events.',
  forensics: 'Forensics and incident trail events.',
  security: 'Security posture and policy events.',
  automation: 'Automation job, schedule, and run events.',
  routes: 'Route binding and surface-link events.',
  'control-plane': 'Control-plane client, auth, and subscription events.',
  deliveries: 'Delivery queue and outcome events.',
  watchers: 'Watcher state and heartbeat events.',
  surfaces: 'Surface registration and health events.',
  knowledge: 'Knowledge ingest, extraction, projection, packet, and job events.',
  workspace: 'Workspace swap lifecycle events (start, complete, refuse).',
  fleet: 'Live process-registry node lifecycle events (started, state-changed, finished, blocked-on-user, unblocked), the poll-free counterpart to fleet.snapshot.',
  config: 'Key-level settings-change notices (CONFIG_KEY_CHANGED), carrying the dotted key, its ownership scope (daemon/client/user) and the new value, EXCEPT for a secret-bearing key, which travels by name only with secret:true and no value field at all. The poll-free counterpart to config.get for a client whose settings live in the daemon: an in-process ConfigManager.subscribe cannot see a write that happened on another machine, so a client without this stream keeps running on whatever it read at startup.',
} satisfies Record<RuntimeEventDomain, string>;

/**
 * Who may receive an event stream entry: any authenticated principal holding
 * the descriptor's scopes, or only an admin. A domain is admin-only when its
 * events carry setting values, approvals and tool arguments, conversation or
 * tool output, other principals' credentials and connections, or the owner's
 * records (knowledge sources and the task a packet was built for; the fleet's
 * agents and what they are doing; a task's prompt, which its title and
 * description are; the work plan's tasks and notes; a delivery's recipient);
 * the rest describe state a non-admin can already read through the request
 * path.
 */
export type GatewayEventAccess = 'authenticated' | 'admin';

/** The effect each runtime domain's frames are (security/effect-authority.ts); its row says who may watch it. */
export const RUNTIME_DOMAIN_EFFECTS = {
  session: 'events.session',
  turn: 'events.turn',
  providers: 'events.providers',
  tools: 'events.tools',
  tasks: 'events.tasks',
  agents: 'events.agents',
  contracts: 'events.contracts',
  communication: 'events.communication',
  planner: 'events.planner',
  gate: 'events.gate',
  plugins: 'events.plugins',
  mcp: 'events.mcp',
  transport: 'events.transport',
  compaction: 'events.compaction',
  ui: 'events.ui',
  ops: 'events.ops',
  forensics: 'events.forensics',
  security: 'events.security',
  automation: 'events.automation',
  routes: 'events.routes',
  'control-plane': 'events.control-plane',
  deliveries: 'events.deliveries',
  watchers: 'events.watchers',
  surfaces: 'events.surfaces',
  knowledge: 'events.knowledge',
  workspace: 'events.workspace',
  fleet: 'events.fleet',
  config: 'events.config',
} as const satisfies Record<RuntimeEventDomain, EffectId>;

/** The descriptor that declares `read:own-sessions`; delivery is decided frame by frame in gateway-scope-enforcement.ts. */
export const OWN_SESSION_ACTIVITY_EVENT_ID = 'control.own_session_activity';
/** The scope that lets a credential without the admin role watch the sessions its principal owns: the `session.watch` row's. */
export const OWN_SESSIONS_SCOPE = EFFECTS['session.watch'].scope;

/** The wire events the distributed runtime publishes about paired peers and the work they run. */
export const REMOTE_RUNTIME_WIRE_EVENTS = [
  'remote-pair-requested',
  'remote-pair-approved',
  'remote-pair-rejected',
  'remote-pair-verified',
  'remote-peer',
  'remote-peer-heartbeat',
  'remote-peer-disconnected',
  'remote-token-rotated',
  'remote-token-revoked',
  'remote-work-queued',
  'remote-work-claimed',
  'remote-work-settled',
  'remote-work-cancelled',
] as const;

/** Access of the builtin broadcast (non-domain) event descriptors, by descriptor id. */
const BROADCAST_EVENT_ACCESS: Readonly<Record<string, GatewayEventAccess>> = {
  'control.ready': 'authenticated',
  'control.heartbeat': 'authenticated',
  'control.surface_message': 'authenticated',
  'control.remote_update': 'authenticated',
  'control.approval_update': 'admin',
  'control.owner_inbox_update': 'admin',
  'control.hosted_session_update': 'admin',
  'control.session_update': 'admin',
  // Delivers only frames of sessions the caller's principal owns (gateway-scope-enforcement.ts).
  [OWN_SESSION_ACTIVITY_EVENT_ID]: 'authenticated',
};

/** The access an event descriptor requires. A descriptor this table does not know (a plugin's) is admin-only. */
export function gatewayEventAccess(descriptor: Pick<GatewayEventDescriptor, 'id' | 'category' | 'domains'>): GatewayEventAccess {
  if (descriptor.category === 'runtime-domain') {
    const domain = descriptor.domains?.[0];
    if (domain === undefined || !Object.hasOwn(RUNTIME_DOMAIN_EFFECTS, domain)) return 'admin';
    const least = EFFECTS[RUNTIME_DOMAIN_EFFECTS[domain]].least;
    return least === 'owner' || least === 'admin' ? 'admin' : 'authenticated';
  }
  return BROADCAST_EVENT_ACCESS[descriptor.id] ?? 'admin';
}

export const builtinGatewayEventDescriptors: readonly GatewayEventDescriptor[] = [
  ...RUNTIME_EVENT_DOMAINS.map((domain) => runtimeDomainEvent(domain, RUNTIME_DOMAIN_DESCRIPTIONS[domain])),
  eventDescriptor({
    id: 'control.remote_update',
    title: 'Remote Peer and Work Update',
    description:
      'Distributed-runtime notices about paired peers and the work they run: a pair request and its '
      + 'approval, rejection or verification, a peer connecting, its heartbeat and disconnect, a peer '
      + 'token rotated or revoked, and remote work queued, claimed, settled or cancelled. The wire event '
      + 'name is the notice; the payload carries the sanitized peer and, for work, the work record. '
      + 'Requires read:remote, the scope remote.peers.list and remote.work.list require.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events', 'read:remote'],
    wireEvents: [...REMOTE_RUNTIME_WIRE_EVENTS],
    outputSchema: JSON_OBJECT_SCHEMA,
  }),
  eventDescriptor({
    id: 'control.ready',
    title: 'Ready Handshake',
    description: 'Initial SSE/WebSocket handshake event emitted after a control-plane subscription is opened. `domains` is what the stream delivers; `withheldDomains` names requested domains this credential may not read; `unrecognisedDomains` names requested `?domains=` values that are not runtime event domains, so nothing will arrive for them (a request naming only unknown domains is refused with 400 UNKNOWN_EVENT_DOMAIN).',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['ready'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      domains: arraySchema(STRING_SCHEMA),
      transport: STRING_SCHEMA,
      withheldDomains: arraySchema(STRING_SCHEMA),
      unrecognisedDomains: arraySchema(STRING_SCHEMA),
    }, ['clientId', 'domains', 'transport']),
  }),
  eventDescriptor({
    id: 'control.heartbeat',
    title: 'Heartbeat',
    description: 'Keepalive event emitted by the SSE control-plane transport.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['heartbeat'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      ts: NUMBER_SCHEMA,
    }, ['clientId', 'ts'], { additionalProperties: false }),
  }),
  eventDescriptor({
    id: 'control.surface_message',
    title: 'Surface Message',
    description: 'Out-of-band control-plane surface messages for operators and connected clients. Each carries the message text, so it needs read:transcripts, as control.messages.list does.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events', 'read:transcripts'],
    wireEvents: ['surface-message'],
    outputSchema: CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA,
  }),
  eventDescriptor({
    id: 'control.approval_update',
    title: 'Approval Record Update',
    description:
      'Every approval record transition, pushed the moment the broker records it: an ask RAISED (status '
      + 'pending, this is the prompt arriving), claimed by a surface, approved, denied, cancelled, or '
      + 'expired. The payload is the whole '
      + '`approval` record plus the `createdAt` of the notice, so a subscriber renders the prompt from the '
      + 'event and never needs a follow-up read to draw it. '
      + 'This is the channel that makes approvals.raise usable from a surface that is not in the daemon '
      + 'process: raise returns the pending record and the DECISION arrives here, so a client gets '
      + 'keystroke-fast prompt delivery instead of polling approvals.list on a timer. '
      + 'Domain-tagged `gate` (gateway-scope-enforcement.ts EVENT_DOMAIN), so a client that opened '
      + 'the stream with ?domains=… must include `gate` to receive it; a client that opted into no '
      + 'domain narrowing receives it as before. '
      + 'The record is the daemon\'s, not the subscriber\'s: several surfaces see the same transition and the '
      + 'daemon remains the single source of the applied result, a surface renders what the record says '
      + 'rather than what it locally decided. '
      + 'The payload also carries `reading`, the record\'s reading for an admin who may answer (what is waiting, '
      + 'on whom, the deadline, the decision and whether the asker received it), and every record carries '
      + '`revision`. A subscriber applies a frame only when its revision is higher than the one it holds, so a '
      + 'late or repeated frame never makes a settled approval actionable again; after a gap or a reconnect it '
      + 'reads approvals.list once, because frames are not replayed.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['approval-update'],
    domains: ['gate'],
    outputSchema: objectSchema({
      approval: SHARED_APPROVAL_RECORD_SCHEMA,
      reading: APPROVAL_READING_SCHEMA,
      // While it waits: the ask's words, compact (no details), so a surface draws the card from the frame.
      presentation: ASK_PRESENTATION_SCHEMA,
      createdAt: NUMBER_SCHEMA,
    }, ['approval', 'createdAt']),
  }),
  eventDescriptor({
    id: 'control.owner_inbox_update',
    title: 'Owner Inbox Update',
    description:
      'A question, claim, purchase window or queued action in the owner inbox was posted, answered or '
      + 'withdrawn. The payload is the whole `item` plus the `createdAt` of the notice, so a surface '
      + 'renders the change and an agent waiting on its question reads the answer without a follow-up '
      + 'inbox.list. Approvals are not repeated here; they arrive on control.approval_update. '
      + 'Domain-tagged `gate`, like approvals: a client narrowing with ?domains=… must include `gate`.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['owner-inbox-update'],
    domains: ['gate'],
    outputSchema: objectSchema({
      item: OWNER_ITEM_SCHEMA,
      createdAt: NUMBER_SCHEMA,
    }, ['item', 'createdAt']),
  }),
  eventDescriptor({
    id: 'control.hosted_session_update',
    title: 'Hosted Session Lifecycle Update',
    description:
      'Every lifecycle transition of a session whose loop runs INSIDE the daemon: created, attached, '
      + 'detached, turn started, turn ended, terminated, and restored after a restart, plus a contract '
      + 'started in the session and a line the session said for one of its contracts (a question for '
      + 'the owner, or the outcome). The payload '
      + 'carries the whole hosted-session record plus the transition name, the client it is about '
      + '(attach/detach) and a short detail, so a subscriber renders the change from the event and '
      + 'needs no follow-up read. '
      + 'This channel is LIFECYCLE ONLY. The turn itself, streamed tokens, tool calls, tool results, '
      + 'turn transitions, is already on the `turn` and `tools` runtime domains, stamped with the '
      + 'hosted session id, because a hosted session runs the ordinary orchestrator; a client watches '
      + 'those exactly as it does for a local session and filters on the id it was handed. A second '
      + 'copy of that stream is not published here. '
      + 'Domain-tagged `session`, so a client narrowing with ?domains=… must include `session` to '
      + 'receive it. The record is the daemon\'s: `effectiveDetachPolicy` says what leaving would do '
      + 'right now, and `terminatedReason` says why a session ended, a hosted session never simply '
      + 'disappears.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:sessions'],
    wireEvents: ['hosted-session-update'],
    domains: ['session'],
    outputSchema: objectSchema({
      event: { type: 'string', enum: [...HOSTED_SESSION_UPDATE_WIRE_EVENTS] },
      session: HOSTED_SESSION_RECORD_SCHEMA,
      createdAt: NUMBER_SCHEMA,
      clientId: STRING_SCHEMA,
      detail: STRING_SCHEMA,
    }, ['event', 'session', 'createdAt']),
  }),
  eventDescriptor({
    id: OWN_SESSION_ACTIVITY_EVENT_ID,
    title: 'Own Session Activity',
    description:
      'What a credential without the admin role holding `read:own-sessions` receives of the sessions '
      + 'its own principal created or an owner shared with it (sessions.hosted.create, sessions.hosted.share): '
      + 'their `turn`, `tools`, `gate` and `session` runtime frames (streamed text, tool calls and '
      + 'results, permission decisions, turn transitions), their `approval-update` events and their '
      + '`hosted-session-update` notices. Frames of every other session, and frames naming no session, '
      + 'are withheld; the admin-only domains stay admin-only for everything else. Open the stream with '
      + '`?domains=turn,tools,gate,session` (or subscribe to those domains on the socket) and filter '
      + 'on the session id. Ownership is saved with the session, so it holds across a daemon restart.',
    category: 'sessions',
    transport: ['sse', 'ws'],
    scopes: [OWN_SESSIONS_SCOPE],
  }),
  eventDescriptor({
    id: 'control.session_update',
    title: 'Session Lifecycle Update',
    description:
      'Shared-session lifecycle broadcast. Every session created / closed / deleted / reopened / '
      + 'agent-bound / agent-completed / message-appended / message-forwarded / route-attached '
      + 'and every input & follow-up lifecycle transition is published on the single '
      + '`session-update` wire event; the specific lifecycle name is the discriminated '
      + '`payload.event` field. Cross-surface invalidation mapping (webui/TUI): '
      + `${intentMappingText()}. A deleted session is a hard removal: the record is gone, not merely closed. `
      + 'Domain-tagged `session` (gateway-scope-enforcement.ts EVENT_DOMAIN), the same tag '
      + 'control.hosted_session_update carries: both are session lifecycle, so a client that '
      + 'narrows with ?domains=… must include `session` to receive EITHER of them, and one that '
      + 'opted into no narrowing receives both. It is dropped entirely when the '
      + 'control-plane-gateway flag is turned off (no phantom buffering).',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:sessions'],
    wireEvents: ['session-update'],
    domains: ['session'],
    outputSchema: objectSchema({
      event: { type: 'string', enum: [...SESSION_UPDATE_WIRE_EVENTS] },
      payload: JSON_OBJECT_SCHEMA,
      createdAt: NUMBER_SCHEMA,
    }, ['event', 'payload', 'createdAt']),
  }),
];
