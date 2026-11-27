/**
 * record-owners.ts, each kind of record's owner lookup for the one check of what a caller may reach
 * (control-plane/caller-reach.ts): given the id a call names, the project the record belongs to (null: none) and who
 * made it where the kind keeps that. Registered with the method catalog once the daemon's stores exist.
 *
 * | kind | store | project | maker |
 * | --- | --- | --- | --- |
 * | chat | companion chat manager | the chat's project | its `createdBy` |
 * | session | session broker (a web chat's session read as the chat) | the record's `project` (`unknown`: none) | who registered it |
 * | approval | approval broker | the question's `workingDirectory` | |
 * | schedule | automation manager | the job's `execution.workingDirectory` | its `cause.madeFor` (someone else's) |
 * | schedule-run | automation manager | its schedule's | its schedule's |
 * | trigger | trigger manager | the definition's `workingDirectory` | its `cause.madeFor` (someone else's) |
 * | rule | user rule store | the rule's `project` (none: applies everywhere) | |
 * | memory-record | memory registry | a "this project" record's `project` (any other: none) | |
 * | checkpoint | the checkpoint verbs' surface (registered by products/daemon service-graph.ts, where it is built) | the workspace of the store that holds it (the daemon's own: none) | |
 * | memory-proposal | memory registry's proposals | the one project its records are of (several: the owner's only) | |
 * | task | agent manager | the agent's `workingDirectory` (a runtime task row: its agent's) | the caller it was started for (`madeByOf`) |
 * | batch-job | batch manager (facade-composition.ts) | none | its `createdBy` |
 * | route-binding, remote-work | route bindings, remote work (facade-composition.ts) | the first record they name | |
 * | artifact | artifact store | a daemon turn's file: its chat's (`metadata.project`); else none | its `metadata.createdBy` (a turn's file: the chat's maker) |
 */
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import type { RecordOwner } from '../control-plane/caller-reach.js';

/** Where each kind's records are kept (the daemon's stores; each optional, a kind with none holds nothing to reach). */
export interface RecordOwnerStores {
  readonly chats?: { getSession(id: string): { readonly project?: string | undefined; readonly createdBy?: string | undefined } | null } | undefined;
  readonly sessions?: { getSession(id: string): { readonly kind: string; readonly project: string } | null; registrantOf?(id: string): string | undefined } | undefined;
  /** A hosted session's owners: who started it and whoever it was shared with (hosted-sessions/manager.ts `ownersOf`). */
  readonly sessionSharedWith?: ((id: string) => readonly string[]) | undefined;
  readonly approvals?: { getApproval(id: string): { readonly request: { readonly workingDirectory?: string | undefined } } | null } | undefined;
  readonly schedules?: {
    getJob(id: string): { readonly execution?: { readonly workingDirectory?: string | undefined } | undefined; readonly cause?: { readonly madeFor?: string | undefined } | undefined } | undefined;
    getRun(id: string): { readonly jobId: string } | undefined;
  } | undefined;
  readonly triggers?: {
    get(id: string): { readonly definition: { readonly workingDirectory?: string | undefined; readonly cause?: { readonly madeFor?: string | undefined } | undefined } } | null;
    resolveName?(name: string, project?: string | undefined): string;
  } | undefined;
  readonly rules?: { list(): readonly { readonly rule: { readonly id: string }; readonly project?: string | undefined }[] } | undefined;
  readonly memory?: {
    get(id: string): { readonly scope: string; readonly project?: string | undefined; readonly author?: { readonly kind: string; readonly madeBy?: string | undefined } | undefined } | null;
    listConsolidationProposals?(): readonly { readonly id?: string | undefined; readonly ids: readonly string[] }[];
  } | undefined;
  readonly tasks?: { getStatus(id: string): { readonly id?: string | undefined; readonly workingDirectory?: string | undefined } | null; madeByOf?(id: string): string | undefined } | undefined;
  /** A runtime task row's owner (the agent it tracks, runtime/tasks/adapters/agent-adapter.ts): a task listed by `tasks.list`. */
  readonly runtimeTaskOwner?: ((taskId: string) => string | undefined) | undefined;
  readonly artifacts?: { get(id: string): { readonly metadata?: Record<string, unknown> | undefined } | null } | undefined;
}

const folder = (value: string | undefined | null): string | null => typeof value === 'string' && value.trim() && value !== 'unknown' ? value.trim() : null;

/** Register each kind's owner lookup with the catalog. */
export function registerRecordOwners(catalog: Pick<GatewayMethodCatalog, 'setRecordOwner'>, stores: RecordOwnerStores): void {
  const chat = (id: string): RecordOwner | undefined => {
    const meta = stores.chats?.getSession(id);
    return meta ? { project: folder(meta.project), ...(meta.createdBy ? { madeBy: meta.createdBy } : {}), as: 'chat' } : undefined;
  };
  catalog.setRecordOwner('chat', chat);
  catalog.setRecordOwner('session', (id) => {
    const record = stores.sessions?.getSession(id);
    if (!record) return chat(id);
    // A web chat's session is held as the chat: its project and its maker.
    if (record.kind === 'companion-chat') return chat(id) ?? { project: folder(record.project), as: 'chat' };
    const registrant = stores.sessions?.registrantOf?.(id);
    // A hosted session's owners besides who started it: those the owner shared it with reach it (that one session).
    let sharedWith: readonly string[] = [];
    try { sharedWith = stores.sessionSharedWith?.(id) ?? []; } catch { sharedWith = []; }
    return { project: folder(record.project), ...(registrant ? { madeBy: registrant } : {}), ...(sharedWith.length > 0 ? { sharedWith } : {}) };
  });
  catalog.setRecordOwner('approval', (id) => {
    const approval = stores.approvals?.getApproval(id);
    return approval ? { project: folder(approval.request.workingDirectory) } : undefined;
  });
  const schedule = (id: string): RecordOwner | undefined => {
    const job = stores.schedules?.getJob(id);
    // Whose it is when someone else caused it (automation/jobs.ts `cause.madeFor`); none kept is the owner's.
    return job ? { project: folder(job.execution?.workingDirectory), ...(job.cause?.madeFor ? { madeBy: job.cause.madeFor } : {}) } : undefined;
  };
  catalog.setRecordOwner('schedule', schedule);
  catalog.setRecordOwner('schedule-run', (id) => {
    const run = stores.schedules?.getRun(id);
    return run ? schedule(run.jobId) ?? { project: null } : undefined;
  });
  catalog.setRecordOwner('trigger', (id, where) => {
    // A name typed in a project is that project's trigger of the name its people chose (TriggerManager resolveName).
    const trigger = stores.triggers?.get(stores.triggers.resolveName?.(id, where?.project) ?? id);
    // Whose it is when someone else made it (triggers/types.ts `cause.madeFor`); none kept is the owner's.
    const madeBy = trigger?.definition.cause?.madeFor;
    return trigger ? { project: folder(trigger.definition.workingDirectory), ...(madeBy ? { madeBy } : {}) } : undefined;
  });
  catalog.setRecordOwner('rule', (id) => {
    const rule = stores.rules?.list().find((entry) => entry.rule.id === id);
    return rule ? { project: folder(rule.project) } : undefined;
  });
  catalog.setRecordOwner('memory-record', (id) => {
    const record = stores.memory?.get(id);
    // Whose it is when someone else wrote it (state/memory-author.ts `madeBy`, the authenticated principal); none kept is the owner's.
    const madeBy = record?.author?.kind === 'other' ? record.author.madeBy : undefined;
    return record ? { project: record.scope === 'project' ? folder(record.project) : null, ...(madeBy ? { madeBy } : {}) } : undefined;
  });
  // A consolidation proposal is of the records it names: one project's (or shared, every one shared); records of two
  // projects make it the owner's alone.
  catalog.setRecordOwner('memory-proposal', (id) => {
    const proposal = stores.memory?.listConsolidationProposals?.().find((entry) => entry.id === id);
    if (!proposal) return undefined;
    const projects = new Set(proposal.ids.map((recordId) => {
      const record = stores.memory?.get(recordId);
      return record && record.scope === 'project' ? folder(record.project) : null;
    }));
    const named = [...projects].filter((project): project is string => project !== null);
    if (named.length > 1) return { project: null, ownerOnly: true };
    return { project: named[0] ?? null };
  });
  catalog.setRecordOwner('task', (id) => {
    // An agent by its id, or the runtime task row that tracks one (its owner is the agent's id).
    const agent = stores.tasks?.getStatus(id) ?? (() => {
      const owner = stores.runtimeTaskOwner?.(id);
      return owner && owner !== id ? stores.tasks?.getStatus(owner) ?? null : null;
    })();
    if (!agent) return undefined;
    // Whose task it is when someone else's call started it (the agent manager's `madeByOf`).
    const agentId = stores.tasks?.getStatus(id) ? id : stores.runtimeTaskOwner?.(id);
    const madeBy = agentId ? stores.tasks?.madeByOf?.(agentId) : undefined;
    return { project: folder(agent.workingDirectory), ...(madeBy ? { madeBy } : {}) };
  });
  catalog.setRecordOwner('artifact', (id) => {
    const artifact = stores.artifacts?.get(id);
    if (!artifact) return undefined;
    const madeBy = artifact.metadata?.['createdBy'];
    // A file a daemon turn made keeps its chat's project (artifacts/turn-maker.ts); any other belongs to no project.
    const project = artifact.metadata?.['project'];
    return { project: typeof project === 'string' ? folder(project) : null, ...(typeof madeBy === 'string' && madeBy ? { madeBy } : {}) };
  });
}
