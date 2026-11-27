/**
 * shared-kinds.ts, the owner's shared things (what belongs to no project: their mail, their calendar, their channels and what
 * arrives on them, their knowledge library, their money, their profile, their dates, their home, what the daemon told them, their
 * Cloudflare account, their watchers), and who reaches each.
 *
 * They are the owner's: the owner in person (their signed-in session, their verified program on this machine, their Agent program) and
 * their own turns (a daemon-run turn on their own input) reach them. Anyone else (a paired device, the owner's own phone included, a
 * signed-in member, the outside agent, a script with the operator token, a machine of the group, a turn on someone
 * else's input) reaches a kind ONLY when the owner gave that caller that kind: a per-caller gift, given and taken back in
 * Devices and network on the caller's row as a project is (`devices.give-shared`, `devices.take-shared`), default none,
 * whatever the effect table's scope says (both must admit the call). A caller that tries a kind it was not given puts
 * ONE question to the owner the first time ("Let the paired device "kiosk" read and send your mail?"); on the owner's yes the
 * kind is given and the call can be sent again; on the owner's No nothing is given and it is not asked again while the daemon
 * runs (daemon/shared-kind-gifts.ts). A 3.5.0 device that read these keeps working that way: after the owner's one yes.
 *
 * Which ids are which kind: a method family of control-plane/record-addresses.ts `FAMILIES` that holds the owner's own
 * things, and the capability families that act on the same things (each line below). The other `FAMILIES` lines are
 * not the owner's shared things and are not listed here: a part of a record of a kind the one reach rule holds
 * (`sessions.`, `tasks.`, `approvals.`, `companion.chat.`, `checkpoints.`, `rewind.`, `memory.`,
 * `memory.consolidation.`, `deliveries.`, `telemetry.`, `fleet.`, `ci.`, `batch.`, `artifacts.`, `inbox.`,
 * `contracts.`, `remote.` work), Work and planning routed by project (`workLedger.`, `projectPlanning.`), or the daemon's
 * own facilities and settings, held by the effect table and the owner decision classes (`automation.` routes,
 * `browser.`, `pairing.`, `stepup.`, `voice.`, `web_search.`, `media.`, `multimodal.`, `providers.`, `models.`,
 * `memory.embeddings.`, `push.`, `devices.`, `judgment.`, `relay.`, `principals.`, `local_auth.`, `control.`,
 * `capabilities.`, `hooks.`, `permissions.audit.`, `panels.`, `acp.`, `config.`, `skills.`, `mcp.`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../config/atomic-write.js';

/** The owner's shared things, by kind. */
export const SHARED_KINDS = ['mail', 'calendar', 'channels', 'knowledge', 'payments', 'profile', 'dates', 'home', 'notifications', 'cloudflare', 'watchers'] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

export function isSharedKind(value: unknown): value is SharedKind {
  return typeof value === 'string' && (SHARED_KINDS as readonly string[]).includes(value);
}

/** What a gift of each kind lets a caller do, in the owner's words (the question and the Devices row say it). */
export const SHARED_KIND_WORDS: Readonly<Record<SharedKind, string>> = {
  mail: 'read and send your mail',
  calendar: 'read and change your calendar',
  channels: 'read and use your channels (Slack, Telegram and the others) and the messages that arrive on them',
  knowledge: 'read and change your knowledge library',
  payments: 'see and use your money (cards, purchases, spending windows)',
  profile: 'read and change what GoodVibes knows about you (your profile)',
  dates: 'read and change your dates (birthdays, occasions)',
  home: 'read and control your home (Home Assistant, your home map)',
  notifications: 'read what GoodVibes told you through your webhooks and notifications',
  cloudflare: 'see and change your Cloudflare account (its token, tunnel, worker and what it serves)',
  watchers: 'see and change your watchers (what checks a feed, a file or a web address for you and tells you when it changes)',
};

/** Method id families (record-addresses.ts FAMILIES lines that hold the owner's own things), with their kind. */
const METHOD_FAMILIES: readonly (readonly [string, SharedKind])[] = [
  ['email.', 'mail'],
  ['calendar.', 'calendar'],
  ['channels.', 'channels'],
  ['inbound.telegram.', 'channels'],
  // A route binding ties a thread of the owner's channel accounts to a session: routing it is using the owner's channels.
  // Its records are still held by the one reach rule (a binding is its project's record).
  ['routes.bindings.', 'channels'],
  ['knowledge.', 'knowledge'],
  ['payments.', 'payments'],
  ['profile.', 'profile'],
  ['occasions.', 'dates'],
  ['homeassistant.', 'home'],
  ['homeGraph.', 'home'],
  ['notifications.', 'notifications'],
  ['cloudflare.', 'cloudflare'],
  // The owner's watchers (a feed, a file, a webhook watch: none keeps a project). Not their triggers (`watchers.triggers.*`):
  // a trigger is a record of its project (`trigger`, control-plane/caller-reach.ts), held by the one reach rule.
  ['watchers.', 'watchers'],
];

/** Method families under a shared kind's prefix that are a project's records instead (held by the reach rule). */
const PROJECT_FAMILIES_INSIDE: readonly string[] = ['watchers.triggers.'];

/** Capability id families that act on the same things (capabilities/builtin/*), with their kind. */
const CAPABILITY_FAMILIES: readonly (readonly [string, SharedKind])[] = [
  ['mail.', 'mail'],
  ['google.', 'mail'],
  ['calendar.', 'calendar'],
  ['channels.', 'channels'],
  ['telegram.', 'channels'],
  ['notify.', 'notifications'],
  ['knowledge.', 'knowledge'],
  ['payments.', 'payments'],
  ['about-me.', 'profile'],
  ['profile.', 'profile'],
  ['occasions.', 'dates'],
  ['home.', 'home'],
  ['homeassistant.', 'home'],
  ['cloudflare.', 'cloudflare'],
];

/**
 * The owner's registered services (config/service-registry.ts) that are one of their shared kinds, by the service's name
 * (letters and digits only, lower case): a gift of that kind lets a caller's turn send that service's stored credential
 * (security/stored-credentials.ts). Every other service is the owner's alone: no gift reaches it.
 */
const SERVICE_KINDS: readonly (readonly [RegExp, SharedKind])[] = [
  [/^(slack|telegram|discord|matrix|signal|whatsapp|mattermost|msteams|teams|ntfy|twilio)/, 'channels'],
  [/^(homeassistant|hass)/, 'home'],
  [/^(gmail|googlemail|email|mail|imap|smtp|fastmail|outlook)/, 'mail'],
  [/^(calendar|googlecalendar|gcal|caldav)/, 'calendar'],
  [/^(stripe|payments|paypal)/, 'payments'],
  [/^cloudflare/, 'cloudflare'],
];

/** The shared kind a registered service of the owner's is, or undefined (the owner's alone). */
export function sharedKindOfService(serviceName: string): SharedKind | undefined {
  const name = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SERVICE_KINDS.find(([pattern]) => pattern.test(name))?.[1];
}

/** The shared kind a daemon method acts on, or undefined (none of the owner's shared things). */
export function sharedKindOfMethod(methodId: string): SharedKind | undefined {
  if (PROJECT_FAMILIES_INSIDE.some((prefix) => methodId.startsWith(prefix))) return undefined;
  return METHOD_FAMILIES.find(([prefix]) => methodId.startsWith(prefix))?.[1];
}

/** The shared kind a capability acts on, or undefined. */
export function sharedKindOfCapability(capabilityId: string): SharedKind | undefined {
  return CAPABILITY_FAMILIES.find(([prefix]) => capabilityId.startsWith(prefix))?.[1];
}

/**
 * The shared kind a call acts on: its method's, or for `capabilities.run` the capability's it names (`id`). Undefined
 * when it acts on none.
 */
export function sharedKindOfCall(methodId: string, body: unknown): SharedKind | undefined {
  const own = sharedKindOfMethod(methodId);
  if (own !== undefined) return own;
  if (methodId !== 'capabilities.run' || body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const id = (body as Record<string, unknown>)['id'];
  return typeof id === 'string' ? sharedKindOfCapability(id.trim()) : undefined;
}

interface CallerSharedFile {
  readonly version: 1;
  readonly callers: Record<string, readonly SharedKind[]>;
  /** Of those, the kinds carried from 3.5.0 at the upgrade (`carryFrom350`), per caller, while it still has them. */
  readonly carried?: Record<string, readonly SharedKind[]> | undefined;
  /** When the one-time carry from 3.5.0 ran (it runs once per daemon home). */
  readonly carriedAt?: number | undefined;
  /**
   * The machine's operator token was among the credentials carried (a home 3.5.0 ran in): the outside agent's first
   * credential, which replaces that token for `goodvibes-daemon mcp serve`, is issued with what it was carried
   * (daemon/outside-agent.ts).
   */
  readonly operatorTokenCarried?: true | undefined;
}

/** The words a carried kind is shown with in Devices and network. */
export const CARRIED_FROM_350_WORDS = 'carried from 3.5.0';

/** A kept caller list read back: only the kinds this version knows. */
function kindLists(value: unknown): Record<string, readonly SharedKind[]> {
  const lists = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(lists).filter(([, list]) => Array.isArray(list))
    .map(([id, list]) => [id, (list as readonly unknown[]).filter(isSharedKind)]));
}

/**
 * The kinds the owner gave each caller, kept in the daemon home beside the projects it gave (`<daemon home>/
 * caller-shared.json`), keyed by the principal the daemon authenticates (`pairing:<id>`, a member's sign-in name, the
 * operator token's `local` / `shared-token`). A file that cannot be read gives nobody anything.
 */
export class CallerSharedStore {
  readonly path: string;
  constructor(daemonHome: string) { this.path = join(daemonHome, 'caller-shared.json'); }

  private read(): CallerSharedFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<CallerSharedFile>;
      return { version: 1, callers: kindLists(parsed?.callers),
        ...(parsed?.carried !== undefined ? { carried: kindLists(parsed.carried) } : {}),
        ...(typeof parsed?.carriedAt === 'number' ? { carriedAt: parsed.carriedAt } : {}),
        ...(parsed?.operatorTokenCarried === true ? { operatorTokenCarried: true as const } : {}) };
    } catch {
      return { version: 1, callers: {} };
    }
  }

  private write(file: CallerSharedFile): void {
    atomicWriteFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mkdirp: true });
  }

  /** The kinds `principalId` still has that were carried from 3.5.0 (shown so in Devices and network). */
  carriedOf(principalId: string): readonly SharedKind[] {
    const file = this.read();
    const has = file.callers[principalId] ?? [];
    return (file.carried?.[principalId] ?? []).filter((kind) => has.includes(kind));
  }

  /**
   * The one-time carry at the upgrade from 3.5.0: every caller that exists then (`existing`, each with the shared kinds
   * its released scopes let it use) is given those kinds, recorded as carried from 3.5.0; each is removable in Devices and
   * network like any gift. It runs once per daemon home (`carriedAt`): a credential made afterwards gets none by default.
   * Returns what was carried (empty when it ran before).
   */
  carryFrom350(existing: readonly { readonly principalId: string; readonly kinds: readonly SharedKind[] }[], at = Date.now()): Readonly<Record<string, readonly SharedKind[]>> {
    const file = this.read();
    if (file.carriedAt !== undefined) return {};
    const callers = { ...file.callers };
    const carried: Record<string, readonly SharedKind[]> = { ...(file.carried ?? {}) };
    const done: Record<string, readonly SharedKind[]> = {};
    for (const { principalId, kinds } of existing) {
      const had = callers[principalId] ?? [];
      const added = SHARED_KINDS.filter((kind) => kinds.includes(kind) && !had.includes(kind));
      if (added.length === 0) continue;
      callers[principalId] = SHARED_KINDS.filter((kind) => had.includes(kind) || added.includes(kind));
      carried[principalId] = added;
      done[principalId] = added;
    }
    const operatorToken = existing.some((credential) => credential.principalId === 'local');
    this.write({ version: 1, callers, carried, carriedAt: at, ...(operatorToken ? { operatorTokenCarried: true as const } : {}) });
    return done;
  }

  /** Whether the machine's operator token was carried from 3.5.0 in this daemon home (see `operatorTokenCarried`). */
  operatorTokenCarried(): boolean {
    return this.read().operatorTokenCarried === true;
  }

  /** Give `principalId` these kinds as carried from 3.5.0 (the outside agent's first credential: daemon/outside-agent.ts). */
  giveCarried(principalId: string, kinds: readonly SharedKind[]): readonly SharedKind[] {
    const file = this.read();
    const had = file.callers[principalId] ?? [];
    const added = SHARED_KINDS.filter((kind) => kinds.includes(kind) && !had.includes(kind));
    if (added.length === 0) return had;
    const callers = { ...file.callers, [principalId]: SHARED_KINDS.filter((kind) => had.includes(kind) || added.includes(kind)) };
    const carried = { ...(file.carried ?? {}), [principalId]: [...(file.carried?.[principalId] ?? []), ...added] };
    this.write({ ...file, callers, carried });
    return callers[principalId]!;
  }

  /** The kinds given to `principalId`; empty when none. */
  kindsOf(principalId: string): readonly SharedKind[] {
    return this.read().callers[principalId] ?? [];
  }

  has(principalId: string, kind: SharedKind): boolean {
    return this.kindsOf(principalId).includes(kind);
  }

  /** Every caller given a kind, with its kinds. */
  list(): Readonly<Record<string, readonly SharedKind[]>> {
    return this.read().callers;
  }

  /** Give `principalId` exactly these kinds; none takes every one away. */
  set(principalId: string, kinds: readonly SharedKind[]): readonly SharedKind[] {
    const file = this.read();
    const kept = SHARED_KINDS.filter((kind) => kinds.includes(kind));
    const callers = { ...file.callers };
    if (kept.length === 0) delete callers[principalId];
    else callers[principalId] = kept;
    // A carried kind taken away is no longer carried (given again, it is the owner's gift of now).
    const carried = { ...(file.carried ?? {}) };
    const stillCarried = (carried[principalId] ?? []).filter((kind) => kept.includes(kind));
    if (stillCarried.length === 0) delete carried[principalId];
    else carried[principalId] = stillCarried;
    this.write({ version: 1, callers, ...(file.carried !== undefined ? { carried } : {}), ...(file.carriedAt !== undefined ? { carriedAt: file.carriedAt } : {}),
      ...(file.operatorTokenCarried === true ? { operatorTokenCarried: true as const } : {}) });
    return kept;
  }
}

/** Who asks to reach a shared kind, as the dispatch established it. */
export interface SharedKindCaller {
  /** The owner in person or their own program (control-plane/caller-reach.ts `reacherOf(...).everything`). */
  readonly ownersOwn: boolean;
  /** A daemon-run turn (its in-process call, or one nested in it that the dispatch marked). */
  readonly daemonTurn: boolean;
  /** That turn acts on someone else's input (its call's `othersInput`), and for whom (`othersInputFor`). */
  readonly othersInput: boolean;
  readonly othersInputFor?: string | undefined;
  /** The principal the daemon authenticated (for anyone else). */
  readonly principalId?: string | undefined;
}

/**
 * Whom a call reaches a shared kind as: undefined when it is the owner's own (in person, their program, their own turn);
 * otherwise the principal whose gift it needs (a turn on someone else's input: the caller it runs for; none recorded:
 * nobody, so it is refused).
 */
export function sharedKindAsker(caller: SharedKindCaller): { readonly principalId: string | undefined } | undefined {
  if (caller.ownersOwn) return undefined;
  if (caller.daemonTurn && !caller.othersInput) return undefined;
  if (caller.daemonTurn) return { principalId: caller.othersInputFor };
  return { principalId: caller.principalId };
}

/** The daemon's reader of its gifts (daemon/shared-kind-gifts.ts sets it where it is composed). */
let giftReader: ((principalId: string, kind: SharedKind) => boolean) | undefined;
export function setSharedKindGiftReader(reader: ((principalId: string, kind: SharedKind) => boolean) | undefined): void { giftReader = reader; }

/**
 * Whether this caller reaches the owner's shared kind now, without asking anything: the owner in person, their programs and
 * their own turns; anyone else only with the owner's gift of that kind (a turn on someone else's input: the gift of the caller it
 * runs for). No reader: only the owner's own. Read by a filter that keeps the owner's shared records out of what a
 * caller is given (knowledge/knowledge-reach.ts: the owner's shared knowledge beside a project's).
 */
export function sharedKindReached(caller: SharedKindCaller, kind: SharedKind): boolean {
  const asker = sharedKindAsker(caller);
  if (asker === undefined) return true;
  return asker.principalId !== undefined && giftReader?.(asker.principalId, kind) === true;
}

/**
 * Whether the owner gave `principalId` the shared kind `methodId` acts on (its own gift, read as the gift filters read it).
 * The gift is the gate of that kind's methods: a caller given the kind uses its reads and its acts, whatever its class
 * and scopes (daemon/http/gateway-binding-gate.ts `admittedAs`); the owner's own acts among them stay the owner's.
 */
export function sharedKindGiven(methodId: string, principalId: string | undefined): boolean {
  const kind = sharedKindOfMethod(methodId);
  return kind !== undefined && principalId !== undefined && giftReader?.(principalId, kind) === true;
}

/** The same gate for a capability of a shared kind (`sharedKindOfCapability`): the owner gave `principalId` its kind. */
export function sharedKindGivenForCapability(capabilityId: string, principalId: string | undefined): boolean {
  const kind = sharedKindOfCapability(capabilityId);
  return kind !== undefined && principalId !== undefined && giftReader?.(principalId, kind) === true;
}

/**
 * Knowledge has three kinds of record, each with its own rule: a PROJECT's knowledge (made from that project's files,
 * turns or calls: its sources keep the project) is reached like any other record of that project, by a caller given the
 * project, with no gift; the OWNER's shared knowledge (added outside any project) is the owner's shared kind, reached only by
 * the owner's gift; nothing else exists. So the knowledge calls below are not stopped by the gift before the project filter
 * runs: each is a read the knowledge reach filters record by record (knowledge/knowledge-reach.ts, through
 * `prepareKnowledgeScopeSelection` and `getItem`: a project's records by the project check, the owner's shared ones by
 * the gift, nodes and issues as the sources they are drawn from), or an addition that lands in the project its call
 * names (one naming no project is the owner's shared knowledge and stays behind the gift). Every other knowledge call
 * (the library at large: lint, tidying, reindex, schedules, jobs, connectors, browser history, bookmarks, maps,
 * projections, GraphQL, candidates, reports, extractions, usage, review of an issue) stays behind the gift.
 */
const KNOWLEDGE_PROJECT_READS: ReadonlySet<string> = new Set([
  'knowledge.status', 'knowledge.sources.list', 'knowledge.nodes.list', 'knowledge.issues.list', 'knowledge.item.get',
  'knowledge.search', 'knowledge.ask', 'knowledge.packet',
]);
const KNOWLEDGE_PROJECT_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  'knowledge.status', 'knowledge.ask', 'knowledge.search', 'knowledge.list', 'knowledge.get', 'knowledge.queue', 'knowledge.packet',
]);
const KNOWLEDGE_PROJECT_ADDITIONS: ReadonlySet<string> = new Set(['knowledge.ingest.artifact', 'knowledge.ingest.url', 'knowledge.ingest.urls']);
const KNOWLEDGE_PROJECT_ADDITION_CAPABILITIES: ReadonlySet<string> = new Set([
  'knowledge.ingest-artifact', 'knowledge.ingest-file', 'knowledge.ingest-url', 'knowledge.import-urls',
]);

/**
 * Whether a knowledge call is one of a project's (above): a read filtered record by record, or an addition whose call
 * names a project (`named`: the project its body, query or call context names; the folder check holds it).
 */
export function knowledgeCallOfProject(methodId: string, body: unknown, named: boolean): boolean {
  const capability = methodId === 'capabilities.run' && body !== null && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as Record<string, unknown>)['id'] === 'string' ? String((body as Record<string, unknown>)['id']).trim() : undefined;
  if (capability !== undefined) {
    return KNOWLEDGE_PROJECT_READ_CAPABILITIES.has(capability) || (named && KNOWLEDGE_PROJECT_ADDITION_CAPABILITIES.has(capability));
  }
  return KNOWLEDGE_PROJECT_READS.has(methodId) || (named && KNOWLEDGE_PROJECT_ADDITIONS.has(methodId));
}

/** The words of a refusal: what the caller was not given, and how the owner gives it. */
export function sharedKindRefusalWords(kind: SharedKind, asked: boolean): string {
  return `this caller was not given your ${kind} (to ${SHARED_KIND_WORDS[kind]}): it is yours, and only you, your own programs and your own turns reach it`
    + (asked ? '' : '; you give it in Devices and network, on the caller\'s row ("Let a device or member reach something of yours")');
}

/** The code of a call refused because its caller was not given the shared kind it acts on. */
export const SHARED_KIND_NOT_GIVEN = 'SHARED_KIND_NOT_GIVEN';
