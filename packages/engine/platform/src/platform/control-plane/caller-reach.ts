/**
 * caller-reach.ts, the ONE rule of what a caller may reach among the things the daemon holds, applied where every call
 * reaches its handler (beside the folder check, control-plane/caller-paths.ts): the method catalog's `invoke` (the
 * daemon's dispatch of a method with a handler, and the daemon's own turns calling a method in process), the dispatch
 * of a method served only by its route, and the REST routes (daemon/http/router.ts).
 *
 * Everything the daemon holds belongs to a project, or to no project (the owner's shared things). A caller that is not
 * the owner in person lists, reads, searches, follows or acts on only what belongs to a project the owner gave it
 * (workspace/caller-project.ts `checkCallerProject`, the same check a project it NAMES passes), whether it reaches the
 * thing by naming a project, by naming none, or by its id:
 *
 * - every method input that names a record by id is declared with its kind (control-plane/record-addresses.ts; an
 *   undeclared one stops the catalog at load), and so is every capability input that does;
 * - a kind's owner lookup (registered by the daemon that holds its store, `GatewayMethodCatalog.setRecordOwner`) gives
 *   the record's project, and who made it where the kind keeps that;
 * - a call naming a record the caller may not reach is refused before the handler runs, 403 RECORD_NOT_YOURS, in words
 *   that are the same whether the record is another project's or no record at all (they never say it exists elsewhere);
 * - a list or a search a method declares is filtered to what the caller may reach, by the same rule, after the handler.
 *
 * The owner in person (their sign-in, a device they paired in person, their registered program, a program of theirs on this machine:
 * `projectNamerOf`) reaches everything. A daemon-run turn (`clientKind: daemon-turn`, the web chat, a schedule's run, a
 * trigger's) is confined to its own project the same way: it is not the owner at large.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayMethodInvocationContext } from './method-catalog-shared.js';
import { workFolderValues } from './method-catalog-shared.js';
import { pathNamerOf, type CallerPathRules } from './caller-paths.js';
import type { ProjectNamer } from '../workspace/caller-project.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { realPathOf } from '../workspace/caller-project.js';
import { methodAddressesOf, methodListsOf, type RecordKind } from './record-addresses.js';
import { isSharedKind, sharedKindReached } from './shared-kinds.js';

export type { RecordKind } from './record-addresses.js';

/** What a kind's owner lookup answers for one record: the project it belongs to (null: none), and who made it. */
export interface RecordOwner {
  readonly project: string | null;
  /** The principal that made it, where the kind keeps that (a web chat). */
  readonly madeBy?: string | undefined;
  /** The kind it is held to when it is more than the kind named (a session that is a web chat is held as a chat). */
  readonly as?: RecordKind | undefined;
  /**
   * The callers the owner shared this one record with (a hosted session: `sessions.hosted.share`, the owner's own act
   * or put to the owner): each reaches THIS record whatever project it is in, nothing else of its project; unsharing ends it.
   */
  readonly sharedWith?: readonly string[] | undefined;
  /** The record is of several projects at once (a proposal naming records of two): the owner's alone. */
  readonly ownerOnly?: true | undefined;
}

/** A kind's owner lookup: the record's owner, or undefined when this daemon holds no record with that id. */
export type RecordOwnerLookup = (id: string, where?: RecordLookupWhere) => RecordOwner | undefined | Promise<RecordOwner | undefined>;

/** Where a call names a record from: its project, for a kind whose names are a project's own (a trigger's chosen name). */
export interface RecordLookupWhere {
  readonly project?: string | undefined;
}

/**
 * How each kind treats a record of no project, and whether the caller that made it is part of who it belongs to:
 * `shared`, a record of no project is the person's shared thing every caller may read (a memory record of no project, a
 * rule that applies everywhere: the rules every caller's work is held to); `owner`, it is the owner's only. `madeBy`:
 * `required`, besides belonging to a project given to the caller, it is the caller's own only when that caller made it
 * (a web chat, a file); `reaches`, the caller that made it reaches it as well (a session it registered).
 */
export const RECORD_KIND_FACTS: Readonly<Record<RecordKind, { readonly words: string; readonly withoutProject: 'shared' | 'owner'; readonly madeBy?: 'required' | 'reaches' }>> = {
  chat: { words: 'web chat', withoutProject: 'owner', madeBy: 'required' },
  session: { words: 'session', withoutProject: 'owner', madeBy: 'reaches' },
  approval: { words: 'question waiting for the owner', withoutProject: 'owner' },
  schedule: { words: 'schedule', withoutProject: 'owner' },
  'schedule-run': { words: 'schedule run', withoutProject: 'owner' },
  trigger: { words: 'trigger', withoutProject: 'owner' },
  rule: { words: 'permission rule', withoutProject: 'shared' },
  'memory-record': { words: 'memory record', withoutProject: 'shared' },
  checkpoint: { words: 'checkpoint', withoutProject: 'owner' },
  task: { words: 'agent task', withoutProject: 'owner' },
  artifact: { words: 'file', withoutProject: 'owner', madeBy: 'required' },
  // A provider batch job: the model requests one caller queued, its own (no project's).
  'batch-job': { words: 'batch job', withoutProject: 'owner', madeBy: 'required' },
  // A channel route binding: held as the session (else the schedule, else the run) it binds a chat thread to.
  'route-binding': { words: 'channel route binding', withoutProject: 'owner' },
  // Work queued for a remote peer: held as the session (else the schedule, run or question) it was queued for.
  'remote-work': { words: 'remote work item', withoutProject: 'owner' },
  // A memory consolidation proposal: of the records it names (one project's, or shared when every one is shared; of
  // several projects, the owner's alone).
  'memory-proposal': { words: 'memory consolidation proposal', withoutProject: 'shared' },
  // A CI watch: its project's (the repair session works there); one with no project is the owner's.
  'ci-watch': { words: 'CI watch', withoutProject: 'owner' },
  // A remote runner's contract, and what a runner handed back: the project of the work that made them (the contract's
  // `workspaceRoot`); one with none (or the daemon's own folder) is the owner's.
  'remote-runner': { words: 'remote runner', withoutProject: 'owner' },
  'remote-artifact': { words: 'remote runner result', withoutProject: 'owner' },
};

/** Who reaches: the owner at large, or a caller held to some projects (the ones given it, or one daemon turn's own). */
export interface Reacher {
  /** The owner in person, or one of their programs on this machine: reaches everything. */
  readonly everything: boolean;
  readonly namer: ProjectNamer;
  readonly principalId?: string | undefined;
  /** A daemon-run turn: held to this one project (none when the turn has no project), whoever it acts for. */
  readonly turnProject?: string | null | undefined;
  /**
   * A daemon-run turn on someone else's input (its call's `othersInput`): besides its project, a chat, a session, a file
   * or a batch job is reached only when the caller the turn runs for made it (its own conversation and what it caused),
   * never the owner's or another caller's in the same project.
   */
  readonly turnOnOthersInput?: boolean | undefined;
  /**
   * Whom that turn runs for: the maker of its own conversation, as the daemon recorded it (a member's web chat: that member;
   * call context `othersInputFor`). Undefined when nobody is recorded (a guest, a channel message, Home Assistant's
   * room): the turn then reaches nobody's chat or session.
   */
  readonly turnFor?: string | undefined;
  /**
   * The owner's own device (daemon-api actor.ts `ownerDevice`; never the owner in person): it reaches the questions waiting
   * for the owner, to show and answer them (the approval viewer refuses one it, or a credential made from it, raised), and
   * otherwise only what a project given to it holds.
   */
  readonly ownersDevice?: boolean | undefined;
}

/** The rules the one check reads: the one project check, and each kind's owner lookup. */
export interface CallerReachRules extends CallerPathRules {
  readonly recordOwner?: ((kind: RecordKind) => RecordOwnerLookup | undefined) | undefined;
  /** A capability's inputs that name a record, by kind (record-addresses.ts `capabilityAddressesOf`). */
  readonly capabilityAddresses?: ((capabilityId: string) => Readonly<Record<string, RecordKind>>) | undefined;
}

type ReachContext = (Pick<GatewayMethodInvocationContext, 'credentialKind' | 'principalId' | 'call' | 'clientKind'> & Partial<Pick<GatewayMethodInvocationContext, 'actor'>>) | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Who the call reaches as (see the file's comment). */
export function reacherOf(context: ReachContext, body?: unknown): Reacher {
  const namer = pathNamerOf(context);
  if (context?.clientKind === 'daemon-turn') {
    // The turn's own project: the one its call names (its call context, else the folder its body names).
    const named = context.call?.project ?? record(body)?.['workingDirectory'];
    const project = typeof named === 'string' && named.trim() ? projectIdentityOf(realPathOf(named.trim())) : null;
    return { everything: false, namer, principalId: context.principalId, turnProject: project,
      ...(context.call?.othersInput === true ? { turnOnOthersInput: true, ...(context.call.othersInputFor ? { turnFor: context.call.othersInputFor } : {}) } : {}) };
  }
  const device = context?.credentialKind === 'device-token' && context.actor?.class === 'admin' && context.actor.agentFor === undefined
    && context.actor.ownerDevice !== undefined;
  return { everything: namer.ownersProgram, namer, principalId: context?.principalId, ...(device ? { ownersDevice: true } : {}) };
}

/** Whether `who` reaches a record whose owner is `owner` of `kind` (the one rule). */
export function reaches(who: Reacher, kind: RecordKind, owner: RecordOwner | undefined, rules: Pick<CallerReachRules, 'project'>): boolean {
  if (who.everything) return true;
  // The owner's own device reads and answers the questions waiting for the owner (no other record of theirs).
  if (kind === 'approval' && who.ownersDevice === true) return true;
  if (owner === undefined || owner.ownerOnly === true) return false;
  const facts = RECORD_KIND_FACTS[owner.as ?? kind];
  const madeByIt = owner.madeBy !== undefined && owner.madeBy === who.principalId;
  // A record the owner shared with this caller: that record only (never for a daemon turn, held to its own project).
  if (who.turnProject === undefined && who.principalId !== undefined && owner.sharedWith?.includes(who.principalId) === true) return true;
  if (facts.madeBy === 'required' && !madeByIt && who.turnProject === undefined) return false;
  // A daemon turn on someone else's input reads only the conversations and files its own caller made (a member's chat
  // turn: that member's chats; a guest's: none of anyone's), never the owner's in the same project. The owner's own turn reaches
  // its project's (below).
  if (who.turnOnOthersInput === true && facts.madeBy !== undefined && (who.turnFor === undefined || owner.madeBy !== who.turnFor)) return false;
  // A record of no project: the person's shared thing, the owner's only, or (a kind that keeps its maker) its maker's.
  if (owner.project === null) return facts.withoutProject === 'shared' || (facts.madeBy !== undefined && madeByIt && who.turnProject === undefined);
  if (who.turnProject !== undefined) {
    // A daemon turn: its own project only, and still nothing its own caller could not reach (the project check).
    return who.turnProject !== null && projectIdentityOf(realPathOf(owner.project)) === who.turnProject;
  }
  return rules.project(owner.project, who.namer).ok || (facts.madeBy === 'reaches' && madeByIt);
}

/**
 * The caller's reach as a filter a paged list applies BEFORE it cuts its page (daemon-api `keepReachable`, served with
 * `withRecordReach`): null for the owner at large (nothing is filtered). A kind's lookup that must wait (a store read
 * from disk) cannot be asked inside a list's filter: such a record is left out, as one of no lookup is.
 * Without the rules (a list route wired without them) nothing can be told apart: the owner in person still reads the whole
 * list (null), and anyone else is given nothing (a filter that keeps no row). It never fails open.
 */
export function reachFilterOf(context: ReachContext, rules: CallerReachRules | undefined, body?: unknown): ((kind: string, id: string, known?: RecordOwner) => boolean) | null {
  const who = reacherOf(context, body);
  if (who.everything) return null;
  if (!rules) return () => false;
  return (kind, id, known) => {
    // `shared`: whether the caller reaches the owner's shared kind `id` (the owner's gift; the owner's own turn's), for a store that keeps
    // the owner's shared records beside a project's (the knowledge library: knowledge/knowledge-reach.ts).
    if (kind === 'shared') {
      return isSharedKind(id) && sharedKindReached({ ownersOwn: false, daemonTurn: who.turnProject !== undefined,
        othersInput: who.turnOnOthersInput === true, ...(who.turnFor ? { othersInputFor: who.turnFor } : {}),
        ...(who.principalId ? { principalId: who.principalId } : {}) }, id);
    }
    // A list that holds the record already knows its owner: the same facts, not looked up again.
    if (known !== undefined && kind in RECORD_KIND_FACTS) return reaches(who, kind as RecordKind, known, rules);
    // `project`: a row a list keeps by the project it belongs to (a hook run): the rule of a record of that project.
    if (kind === 'project') return reaches(who, 'schedule', { project: id }, rules);
    if (!(kind in RECORD_KIND_FACTS)) return false;
    const lookup = rules.recordOwner?.(kind as RecordKind);
    let owner: ReturnType<RecordOwnerLookup> | undefined;
    try { owner = lookup?.(id); } catch { owner = undefined; }
    if (owner instanceof Promise) return false;
    return reaches(who, kind as RecordKind, owner, rules);
  };
}

/** The folder the project check is run on for a record that is not there (see `callerReachRefusal`): no project's. */
const REACH_PAD_FOLDER = join(tmpdir(), 'goodvibes-no-record', 'project');

/** The words a refusal says, the same for a record of another project and for none: they never say which. */
export function notReachableWords(kind: RecordKind, path: string, id: string): string {
  return `${path}: no ${RECORD_KIND_FACTS[kind].words} "${id}" is among what this caller may reach (only what belongs to a project the owner gave it)`;
}

/**
 * The calls that only READ a record of a kind whose records of no project every caller reads (`withoutProject:
 * 'shared'`): a rule that applies everywhere, a memory record of no project, a proposal over such records. Every other
 * call naming one changes it (an update, a review, a link, a delete, a decision), and a change of the owner's shared
 * record is made only by the owner in person or their own turn ({@link sharedRecordChangeRefusal}).
 */
const SHARED_RECORD_READS: ReadonlySet<string> = new Set(['memory.records.get', 'memory.records.links.list', 'memory.show']);

/**
 * The calls that MAKE a record of no project of such a kind, and whether this call does (its inputs as given): a rule
 * for every project, a memory record for every project or the team, a bundle of records loaded at once.
 */
const SHARED_RECORD_MAKERS: Readonly<Record<string, (body: Record<string, unknown> | undefined, inputs: Record<string, unknown> | undefined, project: unknown) => boolean>> = {
  // capabilities (their inputs)
  'permissions.never': () => true,
  'memory.add': (_body, inputs) => typeof inputs?.['scope'] === 'string' && inputs['scope'].trim() !== '' && inputs['scope'] !== 'project',
  // methods (their body)
  'memory.records.add': (body, _inputs, project) => body?.['scope'] !== 'project' || !(typeof project === 'string' && project.trim()),
  'memory.records.import': () => true,
};

/**
 * The project acts opened below an admin by scope (security/effect-authority.ts, the project-act rows) that CHANGE a
 * record they name by id (or send something into it): a caller below an admin (a paired device, the outside agent, a
 * member) makes one only on a record it made itself (the kind's owner lookup gives its maker: a session it made or
 * registered, a schedule or trigger it caused, an agent task started for it), as it acts only on work it asked for
 * (routes/work.ts `ownWork`). The owner's records and anyone else's in the same project it reads, never changes. Remote work
 * is held as the session or schedule it was queued for. A memory record keeps no principal as its maker (only words), so
 * such a caller changes none: it adds its own. An admin, the
 * owner and a daemon turn are held by the project rule alone.
 */
export const OWN_RECORD_CHANGES: ReadonlySet<string> = new Set([
  'sessions.close', 'sessions.reopen', 'sessions.detach', 'sessions.delete', 'sessions.messages.create', 'sessions.steer',
  'sessions.followUp', 'sessions.inputs.cancel', 'sessions.inputs.deliver', 'sessions.checkpoints.changed', 'sessions.register',
  'tasks.create', 'tasks.cancel', 'tasks.retry', 'fleet.stop', 'fleet.interrupt', 'fleet.resume',
  'automation.jobs.create', 'automation.jobs.update', 'automation.jobs.delete', 'automation.jobs.enable', 'automation.jobs.disable',
  'automation.jobs.run', 'automation.runs.cancel', 'automation.runs.retry', 'automation.schedules.create', 'automation.schedules.delete',
  'automation.schedules.resume', 'automation.schedules.pause', 'automation.schedules.run',
  'watchers.triggers.cancel', 'watchers.triggers.reset',
  'memory.records.update', 'memory.records.update-review', 'memory.records.delete', 'memory.records.links.add',
  'remote.work.cancel',
]);

/** Whether the caller is below an admin: a paired device, the outside agent or a member (its acting class). */
function belowAdmin(context: ReachContext): boolean {
  const acting = context?.actor?.agentFor ?? context?.actor;
  return acting?.class === 'device' || acting?.class === 'member';
}

/** Whether a record's kept maker is this caller (a session's registrant may carry `#<program>`; a sign-in is `user:<name>`). */
function madeByCaller(madeBy: string | undefined, principalId: string | undefined): boolean {
  if (madeBy === undefined || principalId === undefined) return false;
  const mark = madeBy.indexOf('#');
  const maker = mark < 0 ? madeBy : madeBy.slice(0, mark);
  return maker === principalId || maker === `user:${principalId}`;
}

/** The words of a refused change of a record this caller did not make (no question is put to anyone). */
function notOwnRecordWords(kind: RecordKind, path: string, id: string): string {
  return `${path}: the ${RECORD_KIND_FACTS[kind].words} "${id}" is not one this caller made; a paired device, a member or an outside agent changes only what it made itself, and reads the rest of the project`;
}

/** Whether `who` is the owner in person, their program, or their own daemon turn: the only callers that change the owner's shared records. */
function ownersOwnReach(who: Reacher): boolean {
  return who.everything || (who.turnProject !== undefined && who.turnOnOthersInput !== true);
}

/** The words of a refused change of one of the owner's shared records (no question is put to anyone). */
function sharedRecordChangeWords(kind: RecordKind, at: string): string {
  return `${at}: ${kind === 'rule' ? 'the owner\'s rules that apply in every project' : `the owner's ${RECORD_KIND_FACTS[kind].words}s that apply in every project`} `
    + 'are changed only by the owner in person or the owner\'s own turn; this caller may read them, not change, add or remove them';
}

/**
 * Why this call may not change or make one of the owner's shared records of no project, or undefined (the owner's own,
 * a read, a record of a project). Read before the handler with the reach check (callerReachRefusal).
 */
function sharedRecordMakeRefusal(methodId: string, capabilityId: string, body: unknown, context: ReachContext): string | undefined {
  const acting = capabilityId || methodId;
  const makes = SHARED_RECORD_MAKERS[acting];
  if (!makes) return undefined;
  const fields = record(body);
  const inputs = capabilityId ? record(fields?.['inputs']) : undefined;
  const project = context?.call?.project ?? fields?.['workingDirectory'];
  if (!makes(capabilityId ? undefined : fields, inputs, project)) return undefined;
  return sharedRecordChangeWords(acting.startsWith('permissions.') ? 'rule' : 'memory-record', acting);
}

/** The record ids a call names at each declared input, with their kinds (a list input gives each entry). */
function namedRecords(addresses: Readonly<Record<string, RecordKind>>, prefix: string, body: unknown, query: unknown): { readonly path: string; readonly id: string; readonly kind: RecordKind }[] {
  const out: { path: string; id: string; kind: RecordKind }[] = [];
  for (const [path, kind] of Object.entries(addresses)) {
    for (const source of [body, query]) {
      for (const { path: at, value } of workFolderValues(source, [`${prefix}${path}`])) {
        // A capability's input of several ids separated by commas (artifacts.package `artifacts`): each id is one record
        // (no record id holds a comma).
        const ids = prefix === 'inputs.' ? value.split(',') : [value];
        for (const id of ids) if (id.trim()) out.push({ path: at, id: id.trim(), kind });
      }
    }
  }
  return out;
}

/**
 * Why the call may not reach one of the records it names, `<input>: <why>`, or undefined when it may reach every one
 * (or names none). Lookups run only for a caller that is not the owner at large.
 */
export async function callerReachRefusal(methodId: string | undefined, body: unknown, query: unknown, context: ReachContext, rules: CallerReachRules): Promise<string | undefined> {
  if (!methodId) return undefined;
  const who = reacherOf(context, body);
  if (who.everything) return undefined;
  const named = namedRecords(methodAddressesOf(methodId), '', body, query);
  const capabilityId = methodId === 'capabilities.run' && typeof record(body)?.['id'] === 'string' ? String(record(body)!['id']).trim() : '';
  if (capabilityId && rules.capabilityAddresses) named.push(...namedRecords(rules.capabilityAddresses(capabilityId), 'inputs.', body, undefined));
  // The owner's shared records of no project (the owner's rules for every project, the owner's memory for every project or the team):
  // made, changed or removed only by the owner in person or their own turn; anyone else's call is refused outright.
  const ownersOwn = ownersOwnReach(who);
  if (!ownersOwn) {
    const making = sharedRecordMakeRefusal(methodId, capabilityId, body, context);
    if (making) return making;
  }
  // A session registered below an admin: its id names no session someone else made (registering one is joining it), and
  // the project it says it is in is one given to the caller (the record keeps it, and who else reaches it follows).
  if (methodId === 'sessions.register' && who.turnProject === undefined && belowAdmin(context)) {
    const sessionId = record(body)?.['sessionId'];
    const existing = typeof sessionId === 'string' && sessionId.trim() ? await rules.recordOwner?.('session')?.(sessionId.trim()) : undefined;
    if (existing !== undefined && !madeByCaller(existing.madeBy, who.principalId)) return notReachableWords('session', 'sessionId', String(sessionId));
    const said = record(body)?.['project'];
    if (typeof said === 'string' && said.trim()) {
      const verdict = rules.project(said.trim(), who.namer);
      if (!verdict.ok) return `project: ${verdict.reason}`;
    }
  }
  const reads = SHARED_RECORD_READS.has(capabilityId || methodId);
  // The project the call is made in: a name a project's people chose is looked up as theirs (a trigger's).
  const projectNamed = context?.call?.project ?? record(body)?.['workingDirectory'];
  const where: RecordLookupWhere = typeof projectNamed === 'string' && projectNamed.trim() ? { project: projectNamed.trim() } : {};
  for (const { path, id, kind } of named) {
    if (!id) continue;
    const lookup = rules.recordOwner?.(kind);
    // A kind this daemon keeps no lookup for holds nothing it could tell apart: refused for anyone but the owner.
    const owner = lookup ? await lookup(id, where) : undefined;
    // A record that is not there is refused by the same path, at about the same cost, as one of another project: the
    // project check runs for it too, on a folder no record names, so the answer's time does not say which it was.
    if (owner === undefined) void rules.project(REACH_PAD_FOLDER, who.namer);
    if (!reaches(who, kind, owner, rules)) return notReachableWords(kind, path, id);
    if (!ownersOwn && !reads && owner?.project === null && RECORD_KIND_FACTS[owner.as ?? kind].withoutProject === 'shared') {
      return sharedRecordChangeWords(owner.as ?? kind, path);
    }
    // A project act's change of a record below an admin: only a record this caller made (`OWN_RECORD_CHANGES`).
    if (OWN_RECORD_CHANGES.has(methodId) && who.turnProject === undefined && belowAdmin(context) && !madeByCaller(owner?.madeBy, who.principalId)) {
      return notOwnRecordWords(owner?.as ?? kind, path, id);
    }
  }
  return undefined;
}

/**
 * A list or a search the method declares, filtered to what the caller may reach (the same rule), or the answer as it
 * came. The owner at large reads it whole. A declared count beside the list (`total`) is set to what is left.
 */
export async function reachableAnswer(methodId: string | undefined, answer: unknown, context: ReachContext, rules: CallerReachRules, body?: unknown): Promise<unknown> {
  if (!methodId) return answer;
  const lists = methodListsOf(methodId);
  if (lists.length === 0) return answer;
  const who = reacherOf(context, body);
  if (who.everything) return answer;
  let next = answer;
  for (const list of lists) {
    const holder = record(next);
    const items = holder?.[list.at];
    if (!holder || !Array.isArray(items)) continue;
    // A report of the daemon's own run over every project's records: the owner's alone.
    if (list.ownerOnly) { next = { ...holder, [list.at]: [] }; continue; }
    const lookup = rules.recordOwner?.(list.kind);
    const kept: unknown[] = [];
    for (const item of items) {
      const entry = record(item);
      const id = list.idFields ? list.idFields.map((field) => entry?.[field]).find((value) => typeof value === 'string') : entry?.[list.id ?? 'id'];
      const owner = typeof id === 'string' && lookup ? await lookup(id) : undefined;
      if (reaches(who, list.kind, owner, rules)) kept.push(item);
    }
    const removed = items.length - kept.length;
    if (removed === 0) continue;
    // Counts beside the list say no more than the list does: a `total` less what was left out, a chat list's `totals`
    // counted again from what is left (it would otherwise say how many of other people's there are).
    const totals = record(holder['totals']);
    const counted = totals && typeof totals['sessions'] === 'number' ? { totals: { ...totals,
      sessions: kept.length,
      active: kept.filter((item) => record(item)?.['status'] === 'active').length,
      closed: kept.filter((item) => record(item)?.['status'] === 'closed').length } } : {};
    next = { ...holder, [list.at]: kept, ...(typeof holder['total'] === 'number' ? { total: Math.max(0, (holder['total'] as number) - removed) } : {}), ...counted };
  }
  return next;
}
