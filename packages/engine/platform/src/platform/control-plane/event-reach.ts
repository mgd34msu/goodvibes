/**
 * event-reach.ts, the ONE rule of what a caller may reach (control-plane/caller-reach.ts) applied to what it follows:
 * every event the gateway fans out (the control-plane event stream, the runtime-domain feeds over SSE and WebSocket,
 * a session's or a web chat's own stream, their replay after a reconnect) goes to a caller that is not the owner himself
 * only when every record the event names is one that caller may reach, by the same `reaches` an answer is filtered by.
 *
 * What an event names (`eventSubjectsOf`): the project it says it is about (`project`, `workingDirectory`: a change
 * notice names its project, list-changes.ts), the questions, schedules, schedule runs, triggers and agent tasks it
 * names by id, the session or web chat it belongs to (the envelope's `sessionId`, a session record's `id`), a memory
 * record or trigger a change notice names, and what an event declares it is about (its `about`, events/about.ts: a
 * contract, a watcher, a work plan or its task, with the project it belongs to). An id no store holds (the daemon's own `control-plane`, `daemon` sessions)
 * names nothing. An event that names nothing the daemon can tell apart is delivered only to the owner himself (and his
 * programs on this machine): it may be about anything. So is one that names, beside what is told apart, anything this
 * rule does not recognise (another key naming a record by id, a list of records, a kind with no lookup, a lookup that
 * must wait): a frame naming the caller's project and another project's record under another key never goes out.
 *
 * Applied in the gateway (gateway.ts `mayReach`), once per client and frame, for live delivery and replay alike; what
 * an event names is read once per emission (kept per payload object), and the owner at large is never looked up for.
 */
import type { GatewayMethodInvocationContext } from './method-catalog-shared.js';
import { reacherOf, reaches, type CallerReachRules, type RecordOwner, type Reacher } from './caller-reach.js';
import type { RecordKind } from './record-addresses.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { realPathOf } from '../workspace/caller-project.js';
import type { SharedKind } from './shared-kinds.js';

/** Who opened a stream, as a call names its caller (the same fields the one check reads). */
export type EventReachContext = Pick<GatewayMethodInvocationContext, 'credentialKind' | 'principalId'>
  & Partial<Pick<GatewayMethodInvocationContext, 'actor' | 'call' | 'clientKind'>>;

/** One thing an event is about: a project it names, or a record it names by id. */
type EventSubject =
  | { readonly project: string }
  | { readonly shared: true }
  | { readonly kind: RecordKind; readonly id: string }
  /** A key naming something this rule cannot tell apart (an id of a kind it has no lookup for): the owner's alone. */
  | { readonly unrecognised: string };

/** A subject with its owner read: what `reaches` decides on. */
interface ResolvedSubject {
  readonly kind: RecordKind | 'project' | 'shared';
  readonly owner: RecordOwner;
}

/** Whether a caller may receive one event (its name and its payload as the gateway sends it). */
export type EventReach = (event: string, payload: unknown) => boolean;

/**
 * The reach rules a stream is filtered by: the one check's, and who was given which of the owner's shared things
 * (control-plane/shared-kinds.ts `CallerSharedStore`). Without the second, a frame about a shared thing goes to the owner
 * himself only.
 */
export type EventReachRules = CallerReachRules & {
  readonly sharedKindGiven?: ((principalId: string, kind: SharedKind) => boolean) | undefined;
};

/**
 * Change notices about the owner's shared things (list-changes.ts `ChangedList`), by the kind they are about. Such a
 * notice names no project (it is about none), so it is not "every project's": it goes to the owner and to a caller he gave
 * that kind, and to nobody else.
 */
const LIST_SHARED_KIND: Readonly<Record<string, SharedKind | undefined>> = {
  mail: 'mail', google: 'mail', calendar: 'calendar', dates: 'dates', 'telegram-intake': 'channels',
  payments: 'payments', spending: 'payments', profile: 'profile', notifications: 'notifications',
};

/** Runtime event domains (and control-plane events) that are about one of the owner's shared things. */
const DOMAIN_SHARED_KIND: Readonly<Record<string, SharedKind | undefined>> = {
  knowledge: 'knowledge', watchers: 'watchers',
};

/** The owner's shared thing a frame is about (its domain, or the list a change notice names), or undefined. */
export function sharedKindOfFrame(event: string, payload: unknown): SharedKind | undefined {
  const byDomain = DOMAIN_SHARED_KIND[event];
  if (byDomain) return byDomain;
  const top = record(payload);
  for (const notice of [top, record(top?.['payload'])]) {
    if (!notice || typeof notice['change'] !== 'string' || typeof notice['list'] !== 'string') continue;
    const kind = LIST_SHARED_KIND[notice['list']];
    if (kind) return kind;
  }
  // An event whose type names the thing it is about (a runtime envelope's `type`: `KNOWLEDGE_…`, `WATCHER_…`).
  const type = text(top?.['type']) ?? text(record(top?.['payload'])?.['type']);
  if (type?.startsWith('KNOWLEDGE_')) return 'knowledge';
  if (type?.startsWith('WATCHER_')) return 'watchers';
  return undefined;
}

/** Events that are the owner's alone whatever they name (his inbox: what waits for him). */
const OWNER_ONLY_EVENTS: ReadonlySet<string> = new Set(['owner-inbox-update']);

/** A change notice's list whose `id` names a record of a kind (list-changes.ts). */
const LIST_RECORD_KIND: Readonly<Record<string, RecordKind | undefined>> = {
  memory: 'memory-record',
  triggers: 'trigger',
  checkpoints: 'checkpoint',
};

/** A change notice's list whose `id` names no record of a project (a capability's id, the owner's mail, spending). */
const LIST_ID_NAMES_NO_RECORD: ReadonlySet<string> = new Set(['capabilities', 'mail', 'spending']);

/** The keys this rule reads as what an event is about (above): each is told apart by its kind's lookup. */
const NAMED_KEYS: ReadonlySet<string> = new Set(['project', 'workingDirectory', 'sessionId', 'approvalId', 'jobId', 'runId', 'triggerId', 'agentId', 'about']);

/**
 * Keys that name a part of what the event is already about (a turn, a message, a tool call of its session), or a kind
 * of thing rather than a record of anyone's (a provider, a model, a plugin, a tool server, a transport): they name no
 * record of their own. Every other key that names something by id (`...Id`, `...Ids`, `id` where no kind is known) is
 * one this rule cannot tell apart, and the event goes to the owner himself only (`unrecognised`).
 */
const PART_KEYS: ReadonlySet<string> = new Set([
  'turnId', 'callId', 'toolCallId', 'messageId', 'providerRequestId', 'streamId', 'requestId', 'eventId', 'entryId',
  'stepId', 'branchId', 'attachmentId', 'traceId', 'spanId', 'correlationId', 'deliveryId', 'checkId',
  'providerId', 'modelId', 'pluginId', 'serverId', 'transportId', 'clientId', 'surfaceId', 'toolId',
  // A question's channel route (the owner's channels, record-addresses.ts `automation.`) and its own history (each
  // entry a step of that question, with its own id).
  'routeId', 'audit',
]);

const NAMES_BY_ID = /(?:Id|Ids|_id|_ids)$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The records and the project an event names (see the file's comment), from its payload as the gateway sends it. */
export function eventSubjectsOf(event: string, payload: unknown): readonly EventSubject[] {
  const top = record(payload);
  if (!top) return [];
  const out: EventSubject[] = [];
  const add = (subject: EventSubject | undefined): void => { if (subject) out.push(subject); };
  const byId = (kind: RecordKind, value: unknown): EventSubject | undefined => { const id = text(value); return id ? { kind, id } : undefined; };
  const named = (holder: Record<string, unknown> | undefined): void => {
    if (!holder) return;
    for (const key of ['project', 'workingDirectory'] as const) { const project = text(holder[key]); if (project) add({ project }); }
    add(byId('session', holder['sessionId']));
    add(byId('approval', holder['approvalId']));
    add(byId('schedule', holder['jobId']));
    add(byId('schedule-run', holder['runId']));
    add(byId('trigger', holder['triggerId']));
    add(byId('task', holder['agentId']));
  };
  // The event itself, and the records it carries: a runtime envelope's payload, a session update's payload, a question,
  // a session record, a surface message's metadata.
  named(top);
  const inner = record(top['payload']);
  named(inner);
  for (const nested of [top['approval'], top['metadata'], top['session'], inner?.['approval'], inner?.['session']]) named(record(nested));
  add(byId('approval', record(top['approval'])?.['id']));
  add(byId('approval', record(inner?.['approval'])?.['id']));
  add(byId('session', record(top['session'])?.['id']));
  // A session update carries the session record itself as its payload.
  if (event === 'session-update' && inner) add(byId('session', inner['id']));
  // A change notice names the record that changed (list-changes.ts LIST_CHANGED): a memory record, a trigger; or says
  // it is about a thing every project shares (`shared`, set by noteListChanged only for a notice that names no project).
  for (const notice of [top, inner]) {
    if (!notice || typeof notice['change'] !== 'string' || typeof notice['list'] !== 'string') continue;
    const kind = LIST_RECORD_KIND[notice['list']];
    // A notice that declares the record it is about (below) is decided by that declaration, not looked up again.
    const declaresIt = record(notice['about'])?.['id'] === notice['id'];
    if (kind && !declaresIt) add(byId(kind, notice['id']));
    if (notice['shared'] === true && notice['project'] === undefined) add({ shared: true });
  }
  // What the event declares it is about (events/about.ts: a contract, a watcher, a work plan or one of its tasks, set by
  // the code that emits it, never by a caller): that record's project decides, and the ids it names beside it are that
  // record's own parts (a contract's units, groups, checks and nudges; a task's links). A record of no project is the
  // owner's alone.
  const declared = new Set<Record<string, unknown>>();
  for (const holder of [top, inner]) {
    const about = holder ? record(holder['about']) : undefined;
    if (!holder || !about || typeof about['kind'] !== 'string' || !text(about['id'])) continue;
    const project = about['project'];
    if (typeof project === 'string' && project.trim()) add({ project: project.trim() });
    else add({ unrecognised: 'about' });
    declared.add(holder);
  }
  // Anything else the event names by id, that no lookup here tells apart, makes it the owner's alone: a frame naming
  // this caller's project beside another project's record under another key never goes out on the project.
  const idKnown = (holder: Record<string, unknown>, nested: boolean): boolean => {
    if (nested) return true; // a question's or a session's own `id` (read above)
    if (event === 'session-update' && holder === inner) return true;
    const list = typeof holder['list'] === 'string' && typeof holder['change'] === 'string' ? holder['list'] : undefined;
    return list !== undefined && (LIST_RECORD_KIND[list] !== undefined || LIST_ID_NAMES_NO_RECORD.has(list));
  };
  const scan = (holder: Record<string, unknown> | undefined, nested: boolean): void => {
    if (!holder) return;
    // A holder that declared what it is about names that record's own parts by id: read above, nothing else to tell apart.
    if (declared.has(holder)) return;
    for (const [key, value] of Object.entries(holder)) {
      if (value === undefined || value === null || value === '' || NAMED_KEYS.has(key) || PART_KEYS.has(key)) continue;
      if (key === 'id' ? !idKnown(holder, nested) : NAMES_BY_ID.test(key)) { add({ unrecognised: key }); return; }
      // A list of records inside the event (`items`, `records`): each could be anyone's.
      if (Array.isArray(value) && value.some((item) => record(item) !== undefined && Object.keys(record(item)!).some((inside) => inside === 'id' || NAMES_BY_ID.test(inside)))) {
        add({ unrecognised: key });
        return;
      }
    }
  };
  scan(top, false);
  scan(inner, false);
  for (const nested of [top['approval'], top['session'], inner?.['approval'], inner?.['session']]) scan(record(nested), true);
  scan(record(top['metadata']), false);
  return out;
}

/**
 * Each subject's owner, read by the kinds' lookups; a record no store holds is left out (it names nothing). Undefined
 * when the event names something that cannot be told apart: a key no lookup reads (`unrecognised`), a kind with no
 * lookup here, or a lookup that must wait (a store read from disk cannot decide a frame being sent). Such a frame goes
 * to the owner himself only.
 */
function resolveSubjects(subjects: readonly EventSubject[], rules: CallerReachRules): readonly ResolvedSubject[] | undefined {
  const out: ResolvedSubject[] = [];
  for (const subject of subjects) {
    if ('unrecognised' in subject) return undefined;
    if ('project' in subject) { out.push({ kind: 'project', owner: { project: subject.project } }); continue; }
    if ('shared' in subject) { out.push({ kind: 'shared', owner: { project: null } }); continue; }
    const lookup = rules.recordOwner?.(subject.kind);
    if (lookup === undefined) return undefined;
    let owner: ReturnType<typeof lookup> | undefined;
    try { owner = lookup(subject.id); } catch { owner = undefined; }
    if (owner instanceof Promise) return undefined;
    if (owner === undefined) continue;
    out.push({ kind: subject.kind, owner });
  }
  return out;
}

/** Whether `who` reaches a project an event names (the rule of a record of that project with no maker). */
function reachesProject(who: Reacher, project: string, rules: CallerReachRules): boolean {
  if (who.everything) return true;
  if (who.turnProject !== undefined) return who.turnProject !== null && projectIdentityOf(realPathOf(project)) === who.turnProject;
  return rules.project(project, who.namer).ok;
}

/**
 * The reach of one stream's caller: null when it reaches everything (the owner himself, a program of his on this
 * machine), else whether it may receive an event. `rules` are read again per frame (the daemon may set them later).
 */
export function createEventReach(context: EventReachContext | undefined, rules: () => EventReachRules | undefined): EventReach | null {
  const who = reacherOf(context);
  if (who.everything) return null;
  return (event, payload) => {
    if (OWNER_ONLY_EVENTS.has(event)) return false;
    const current = rules();
    // No rules set (no daemon): nothing to tell apart, nothing named is reachable.
    if (!current) return false;
    // A frame about one of the owner's shared things (his mail, calendar, channels, knowledge, money, profile, dates,
    // home, notifications, Cloudflare, watchers): only a caller he gave that kind receives it (control-plane/shared-
    // kinds.ts), whatever else it names; a caller he did not give it never does, not even a "shared" notice.
    const kind = sharedKindOfFrame(event, payload);
    if (kind !== undefined) {
      const principal = who.principalId;
      return principal !== undefined && current.sharedKindGiven?.(principal, kind) === true;
    }
    const subjects = resolvedSubjectsOf(event, payload, current);
    // Nothing it names can be told apart (or it names something that cannot be): the owner's alone.
    if (subjects === undefined || subjects.length === 0) return false;
    // A notice about a shared thing (a list every project's screens show) reaches every follower its grant admits.
    return subjects.every((subject) => subject.kind === 'shared' ? true
      : subject.kind === 'project' ? subject.owner.project !== null && reachesProject(who, subject.owner.project, current)
        : reaches(who, subject.kind, subject.owner, current));
  };
}

/** What an emission names, read once per payload object (one event fans out to every stream with the same payload). */
const resolvedByPayload = new WeakMap<object, { readonly event: string; readonly subjects: readonly ResolvedSubject[] | undefined }>();

function resolvedSubjectsOf(event: string, payload: unknown, rules: CallerReachRules): readonly ResolvedSubject[] | undefined {
  if (payload === null || typeof payload !== 'object') return [];
  const kept = resolvedByPayload.get(payload);
  if (kept && kept.event === event) return kept.subjects;
  const subjects = resolveSubjects(eventSubjectsOf(event, payload), rules);
  resolvedByPayload.set(payload, { event, subjects });
  return subjects;
}
