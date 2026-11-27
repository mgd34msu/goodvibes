/**
 * knowledge-reach.ts, whose knowledge is whose: the one reach rule (control-plane/caller-reach.ts) applied to the
 * knowledge library.
 *
 * - Knowledge made from a project's file or conversation (a file added in a call that names a project, or in a daemon
 *   turn's conversation there) records that project and who added it, in the source's metadata (`project`,
 *   `createdBy`), the same maker and project a file the daemon keeps records (artifacts/turn-maker.ts). Never from what
 *   a caller sends: those two keys of a body's metadata are dropped.
 * - The owner's own knowledge (added outside any project, and everything kept from before this record) belongs to no
 *   project: it is his shared thing, given per caller by kind (control-plane/shared-kinds.ts `knowledge`). Nothing
 *   else exists.
 * - A caller that is not the owner himself reads, lists, searches and is given (packets, answers) a project's
 *   knowledge only when that project is one given to it (`reach('project', ...)`, the request's record reach,
 *   daemon-api `currentRecordReach`), and the owner's shared knowledge only with his gift (`reach('shared',
 *   'knowledge')`); the gift's admission does not stop these reads before this filter runs (shared-kinds.ts
 *   `knowledgeCallOfProject`). An entry or an issue drawn from a source is that source's; one drawn from none is the
 *   owner's shared knowledge. An addition naming no project is the owner's shared knowledge: refused to a caller he did
 *   not give it.
 */
import { realpathSync } from 'node:fs';
import { currentRecordReach, type RecordReachFilter } from '@goodvibes/engine/daemon-api';
import { withTurnMaker } from '../artifacts/turn-maker.js';
import { sharedKindReached } from '../control-plane/shared-kinds.js';
import type { TurnInputParty } from '../security/turn-input-party.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import type { KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

/** The metadata key a source keeps its project in, and its maker in. */
export const KNOWLEDGE_PROJECT_KEY = 'project';
export const KNOWLEDGE_MAKER_KEY = 'createdBy';

/**
 * A new source's metadata with the project and maker of the call or turn adding it (none outside both: the owner's
 * shared knowledge). A project or maker the caller wrote into the metadata is never kept.
 */
export function knowledgeMakerMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const given: Record<string, unknown> = { ...(metadata ?? {}) };
  delete given[KNOWLEDGE_PROJECT_KEY];
  delete given[KNOWLEDGE_MAKER_KEY];
  const stamped = withTurnMaker({});
  const project = typeof stamped['project'] === 'string' && stamped['project'].trim() ? stamped['project'].trim() : undefined;
  const maker = typeof stamped['createdBy'] === 'string' && stamped['createdBy'].trim() ? stamped['createdBy'].trim() : undefined;
  // Naming no project adds to the owner's shared knowledge: a caller that is not the owner (a reach is in scope) only
  // with his gift of it; otherwise refused before anything is fetched or written.
  const reach = currentRecordReach();
  if (!project && reach && !reach('shared', 'knowledge')) throw new KnowledgeSharedAdditionRefused();
  if (!project && !maker) return metadata === undefined ? undefined : given;
  return { ...given, ...(project ? { [KNOWLEDGE_PROJECT_KEY]: project } : {}), ...(maker ? { [KNOWLEDGE_MAKER_KEY]: maker } : {}) };
}

/** The project a source was made in, or undefined (the owner's shared knowledge). */
export function knowledgeProjectOf(source: Pick<KnowledgeSourceRecord, 'metadata'>): string | undefined {
  const project = source.metadata?.[KNOWLEDGE_PROJECT_KEY];
  return typeof project === 'string' && project.trim() ? project.trim() : undefined;
}

/** Where a record's sources are read from. */
export interface KnowledgeReachLookup {
  getSource(id: string): KnowledgeSourceRecord | null;
  getNode(id: string): KnowledgeNodeRecord | null;
}

const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];

/** The sources an entry or an issue is drawn from (its own `sourceId`, and those its metadata names). */
function sourcesOf(lookup: KnowledgeReachLookup, kind: 'node' | 'issue', record: KnowledgeNodeRecord | KnowledgeIssueRecord, depth = 0): string[] {
  const metadata = record.metadata ?? {};
  const own = [...strings((record as { readonly sourceId?: unknown }).sourceId), ...strings(metadata['sourceId']), ...strings(metadata['sourceIds'])];
  if (kind === 'issue' && depth === 0) {
    const nodeIds = [...strings((record as KnowledgeIssueRecord).nodeId), ...strings(metadata['nodeId'])];
    for (const nodeId of nodeIds) {
      const node = lookup.getNode(nodeId);
      if (node) own.push(...sourcesOf(lookup, 'node', node, depth + 1));
    }
  }
  return [...new Set(own)];
}

/**
 * The asking caller's reach over the knowledge library: undefined for the owner at large (or outside any call); else
 * whether it may be given a record of `kind`.
 */
export function knowledgeReachNow(lookup: KnowledgeReachLookup): ((kind: 'source' | 'node' | 'issue', record: KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeIssueRecord) => boolean) | undefined {
  const reach = currentRecordReach();
  if (!reach) return undefined;
  // The owner's shared knowledge: only by his gift (his own turn reaches it; control-plane/shared-kinds.ts), asked once.
  const sharedGiven = reach('shared', 'knowledge');
  const sourceReachable = (source: KnowledgeSourceRecord | null): boolean => {
    if (!source) return sharedGiven;
    const project = knowledgeProjectOf(source);
    return project === undefined ? sharedGiven : reach('project', project);
  };
  return (kind, record) => {
    if (kind === 'source') return sourceReachable(record as KnowledgeSourceRecord);
    // An entry or issue drawn from no source belongs to no project: the owner's shared knowledge.
    const sources = sourcesOf(lookup, kind, record as KnowledgeNodeRecord | KnowledgeIssueRecord);
    return sources.length === 0 ? sharedGiven : sources.every((id) => sourceReachable(lookup.getSource(id)));
  };
}

/** One project's identity, by its real folder (one folder by two paths is one; a subfolder is its project). */
function projectOfFolder(folder: string): string {
  let real = folder;
  try { real = realpathSync(folder); } catch { real = folder; }
  return projectIdentityOf(real);
}

/**
 * The reach of a turn's own knowledge, for what is put in its prompt: ALWAYS by the turn's project and party, whether or
 * not a caller's reach is in scope where its prompt is assembled. A project's knowledge only of the turn's own project
 * (none: no project's); the owner's shared knowledge for his own turn, and for a turn on someone else's input only when
 * the owner gave it to the caller it runs for (`madeFor`: a member's web chat; none recorded, a guest: never).
 */
export function knowledgeTurnReach(project: string | undefined, party: TurnInputParty): RecordReachFilter {
  const own = project ? projectOfFolder(project) : undefined;
  const shared = party.party === 'owner'
    || sharedKindReached({ ownersOwn: false, daemonTurn: true, othersInput: true, ...(party.madeFor ? { othersInputFor: party.madeFor } : {}) }, 'knowledge');
  // Each source's project folder is read once per prompt (a library names few projects).
  const seen = new Map<string, boolean>();
  return (kind, id) => {
    if (kind === 'shared') return id === 'knowledge' && shared;
    if (kind !== 'project' || own === undefined) return false;
    let mine = seen.get(id);
    if (mine === undefined) { mine = projectOfFolder(id) === own; seen.set(id, mine); }
    return mine;
  };
}

/**
 * The method calls that read or add to the knowledge library (the `knowledge.` family, and a multimodal analysis
 * written back into it): each runs as its caller, in the project it names, so what it adds is that project's.
 */
export function callReachesKnowledge(methodId: string): boolean {
  return methodId.startsWith('knowledge.') || methodId === 'multimodal.writeback' || methodId === 'multimodal.analyze';
}

/** The words of an addition to the owner's shared knowledge by a caller he did not give it. */
export const KNOWLEDGE_SHARED_ADDITION_REFUSED = 'This adds to the owner\'s own knowledge library (it names no project), which this caller was not given; nothing was added. Send it with the project it belongs to (workingDirectory), or ask the owner to give this device or member his knowledge in Devices and network, on its row';

/** The refusal of an addition to the owner's shared knowledge by a caller without his gift (status 403). */
export class KnowledgeSharedAdditionRefused extends Error {
  override readonly name = 'KnowledgeSharedAdditionRefused';
  readonly status = 403;
  readonly code = 'SHARED_KIND_NOT_GIVEN';
  constructor() { super(KNOWLEDGE_SHARED_ADDITION_REFUSED); }
}

/** Whether the asking caller may be given this record (always, for the owner at large). */
export function knowledgeRecordReachable(lookup: KnowledgeReachLookup, kind: 'source' | 'node' | 'issue', record: KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeIssueRecord): boolean {
  return knowledgeReachNow(lookup)?.(kind, record) ?? true;
}
