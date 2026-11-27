/**
 * The memory capabilities only the program holding the conversation can run:
 * the memory its turns were given, what it holds that can be remembered (an
 * incident report, the last policy check, a tool server's or a plugin's
 * trust), and memory kept as files in
 * the project it works in (written and committed there, compared, and taken
 * back into memory). The records themselves stay the daemon's: the program
 * reads and writes them through its services, which reach the daemon.
 */
import { existsSync } from 'node:fs';
import {
  createMemoryProjectionGit, diffProjectionToProposals, findOrphanedProjectionFiles, projectMemoryToFiles, readProjectedMemoryFiles,
  type MemoryProjectionProposal,
} from '../../state/memory-file-projection.js';
import type { MemoryRecord, MemoryScope } from '../../state/memory-store.js';
import { heldPath } from '../held-paths.js';
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** The most records one read takes; a read that reaches it is not the whole store. */
export const MEMORY_PROJECTION_LIST_LIMIT = 5000;

export interface MemorySessionCapabilityServices {
  readonly memorySession?: {
    /** The memory each recent turn of this session (or of one agent it started) was given; undefined where the program records none. */
    readonly injections?: ((agent: string) => string) | undefined;
    /** Remember what the program holds (an incident, the last policy check, a tool server's or a plugin's trust); answers the sentence of what was kept. */
    readonly capture: (what: string, which: string) => Promise<string>;
    /** The records, up to `limit`, from the daemon's store. */
    readonly records: (limit: number) => Promise<readonly MemoryRecord[]>;
    readonly update: (id: string, patch: Readonly<Record<string, unknown>>) => Promise<MemoryRecord | null>;
    readonly delete: (id: string) => Promise<boolean>;
    /**
     * The memory files folder: the one given, else the setting `memory.projection.dir`, in this program's project. A
     * folder the person names himself may be anywhere; one a model names must be inside the project.
     */
    readonly filesFolder: (given: string, personAsked: boolean) => string;
  } | undefined;
}

type SessionDefinition = CapabilityDefinition<MemorySessionCapabilityServices>;
const session = (id: string, repeat: 'safe' | 'unsafe') => ({ id, group: 'memory' as const, home: 'session' as const, repeat });

function memoryOf(services: MemorySessionCapabilityServices): NonNullable<MemorySessionCapabilityServices['memorySession']> {
  if (!services.memorySession) throw new CapabilityRefusal('Memory is not available in this session; nothing was read or changed.', 'Restart the program; memory loads with it.');
  return services.memorySession;
}

const PROJECTION_DIR: InputDescription = {
  id: 'dir', label: 'Folder', help: 'Where the memory files are kept; any folder you name', kind: 'path', freeTextReason: 'a folder',
  required: { default: '', defaultMeans: 'the memory files folder of this project' }, typed: { flag: '--dir' },
};
const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

async function allRecords(services: NonNullable<MemorySessionCapabilityServices['memorySession']>): Promise<{ readonly records: readonly MemoryRecord[]; readonly complete: boolean }> {
  const records = await services.records(MEMORY_PROJECTION_LIST_LIMIT);
  return { records, complete: records.length < MEMORY_PROJECTION_LIST_LIMIT };
}

/** What your file edits would change in memory, the files whose record is gone, and the files that cannot be read. */
export async function memoryFileProposals(services: NonNullable<MemorySessionCapabilityServices['memorySession']>, dir: string) {
  const { records, complete } = await allRecords(services);
  // A folder the caller named is worked on in place, through its held handle (capabilities/held-paths.ts).
  const files = readProjectedMemoryFiles(dir, heldPath);
  return {
    proposals: diffProjectionToProposals(records, files),
    orphans: findOrphanedProjectionFiles(records, files, { complete }),
    unreadable: [...(files.unreadableIds ?? [])],
    complete,
  };
}

/** What an edited file's proposal would change, and which edited fields memory changed too (never taken). */
export function describeMemoryFileChange(proposal: MemoryProjectionProposal): string {
  const parts: string[] = [];
  if (proposal.changedFields?.length) parts.push(`changes ${proposal.changedFields.join(', ')}`);
  if (proposal.conflictFields?.length) parts.push(`${proposal.conflictFields.join(', ')} also changed in memory, so not taken (correct the record for the file's value)`);
  return parts.join('; ');
}

export const MEMORY_INJECTIONS: SessionDefinition = {
  capability: session('memory.injections', 'safe'),
  actionId: 'see-injections', label: 'See what memory a turn was given', word: 'injections',
  inputs: [{ id: 'agent', label: 'Agent', help: 'An agent this session started', kind: 'text', freeTextReason: 'an agent id from Your agents', required: { default: '', defaultMeans: 'this session\'s own turns' }, typed: { position: 1 } }],
  sentence: 'Shows the memory each recent turn of {agent} was given.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { agent: 'agent-1' },
  async run(values, services) {
    const memory = memoryOf(services);
    if (!memory.injections) throw new CapabilityRefusal('This program does not record the memory each turn was given.', '"See what memory a task would be given" in the Memory place shows what a task would be given.');
    return { text: memory.injections(values.agent ?? '') };
  },
};

export const MEMORY_CAPTURE: SessionDefinition = {
  capability: session('memory.capture', 'unsafe'),
  actionId: 'capture', label: 'Remember an incident or a setting\'s state', word: 'capture',
  inputs: [
    { id: 'what', label: 'What', help: 'What to remember', kind: 'choice', choices: [
      { value: 'incident', label: 'An incident report', help: 'The latest one, or one by id' },
      { value: 'policy', label: 'The last policy check', help: 'What the last policy preflight found' },
      { value: 'mcp', label: 'An MCP server\'s trust', help: 'Its trust level and held-back tools' },
      { value: 'plugin', label: 'A plugin\'s trust', help: 'Whether it is held back, and why' },
    ], required: true, typed: { position: 1 } },
    { id: 'which', label: 'Which', help: 'The incident id (or latest), the server or the plugin', kind: 'text', freeTextReason: 'its name or id', required: { default: '', defaultMeans: 'the latest incident' }, typed: { position: 2 } },
  ],
  sentence: '{what} {which} will be remembered as a record until you change it.',
  done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'forget',
  example: { what: 'incident', which: 'latest' },
  async run(values, services) {
    return { text: await memoryOf(services).capture(values.what!, values.which ?? '') };
  },
};

export const MEMORY_SYNC_FILES: SessionDefinition = {
  capability: session('memory.sync-files', 'safe'),
  actionId: 'sync-files', label: 'Write memory as files', word: 'sync-files', inputs: [{ ...PROJECTION_DIR, file: 'written' }],
  sentence: 'Each project and team record is written as a file in {dir} and committed in that folder\'s own repository, until you change it; a file you edited is kept as it is.',
  done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { dir: 'notes/memory' },
  async run(values, services, caller) {
    const memory = memoryOf(services);
    const dir = memory.filesFolder(values.dir ?? '', caller.personAsked === true);
    const { records, complete } = await allRecords(memory);
    let report;
    try {
      report = projectMemoryToFiles(records, dir, { git: createMemoryProjectionGit(), complete, place: heldPath });
    } catch (error) {
      throw new CapabilityRefusal(`Memory files were not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      text: [
        `Wrote ${plural(report.written.length, 'file')} in ${report.dir}.`,
        ...(complete ? [] : [`The store holds more than ${MEMORY_PROJECTION_LIST_LIMIT} records, the most one read takes; files of records past that were left as they are${report.unchecked ? ` (${report.unchecked})` : ''}.`]),
        ...(report.kept?.length ? [`Kept ${plural(report.kept.length, 'file')} you edited or deleted: ${report.kept.join(', ')}. "See what edited memory files would change" lists them; a changed kind, confidence or review line has no proposal, so change it back by hand.`] : []),
        ...(report.removed?.length ? [`Removed ${plural(report.removed.length, 'file')} whose record was deleted: ${report.removed.join(', ')}.`] : []),
        ...(report.orphaned?.length ? [`Kept ${plural(report.orphaned.length, 'edited file')} whose record was deleted: ${report.orphaned.join(', ')}. Their edits cannot reach memory; delete the files, or remember it again.`] : []),
        report.committed ? `Committed in ${report.dir}'s own repository.` : 'Nothing was committed (nothing changed, or git did not run).',
      ].join('\n'),
      data: { dir: report.dir, written: report.written.length, committed: report.committed === true },
    };
  },
};

export const MEMORY_REVIEW_FILES: SessionDefinition = {
  capability: session('memory.review-files', 'safe'),
  actionId: 'review-files', label: 'See what edited memory files would change', word: 'review-files', inputs: [PROJECTION_DIR],
  sentence: 'Compares the memory files in {dir} with memory and lists what your edits would change; nothing is changed.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { dir: 'notes/memory' },
  async run(values, services, caller) {
    const memory = memoryOf(services);
    const dir = memory.filesFolder(values.dir ?? '', caller.personAsked === true);
    if (!existsSync(dir)) throw new CapabilityRefusal(`There are no memory files in ${dir} yet.`, 'Write them first: "Write memory as files" in the Memory place.');
    const { proposals, orphans, unreadable, complete } = await memoryFileProposals(memory, dir);
    const lines = [
      ...(complete ? [] : [`The store holds more than ${MEMORY_PROJECTION_LIST_LIMIT} records; files of records past that were not compared.`]),
      ...(unreadable.length ? [`${plural(unreadable.length, 'file')} cannot be read as memory (the lines at the top were changed): ${unreadable.join(', ')}. Fix them by hand; they are not taken as deletions.`] : []),
      ...(orphans.length ? [`${plural(orphans.length, 'file')} whose record no longer exists: ${orphans.map((orphan) => orphan.id).join(', ')}. An edit to one cannot reach memory.`] : []),
      ...(proposals.length ? [`${plural(proposals.length, 'change')} from your edits:`, ...proposals.map((proposal) => `  ${proposal.id}  ${proposal.kind === 'delete' ? 'deletes the record (its file was deleted)' : describeMemoryFileChange(proposal)}`), 'Nothing has been applied: "Take edited memory files into memory" applies one, or all.'] : []),
    ];
    return { text: lines.length ? lines.join('\n') : `The files in ${dir} match memory.`, data: { proposals: proposals.map((proposal) => ({ id: proposal.id, kind: proposal.kind })) } };
  },
};

export const MEMORY_APPLY_FILES: SessionDefinition = {
  capability: session('memory.apply-files', 'safe'),
  actionId: 'apply-files', label: 'Take edited memory files into memory', word: 'apply-files',
  inputs: [
    PROJECTION_DIR,
    { id: 'proposal', label: 'Change', help: 'Changes your file edits would make', kind: 'choice', choices: { list: 'memory.file-proposals' as ListName, dependsOn: 'dir', allowOther: { reason: 'a record id from "See what edited memory files would change", or all' } }, required: true, typed: { position: 1 } },
  ],
  sentence: 'The change {proposal} from your memory files will be made in memory until you change it; a deleted file deletes its record.',
  done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  // A file a model could write would otherwise become memory without the owner reading it.
  ownerOnly: { reason: 'it turns file edits into memory', instead: 'Ask the owner to review the files and apply them; "See what edited memory files would change" lists the changes.' },
  example: { proposal: 'all' },
  async run(values, services, caller) {
    const memory = memoryOf(services);
    const dir = memory.filesFolder(values.dir ?? '', caller.personAsked === true);
    if (!existsSync(dir)) throw new CapabilityRefusal(`There are no memory files in ${dir} yet.`, 'Write them first: "Write memory as files" in the Memory place.');
    const { proposals } = await memoryFileProposals(memory, dir);
    const targeted = values.proposal === 'all' ? proposals : proposals.filter((proposal) => proposal.id === values.proposal);
    if (targeted.length === 0) throw new CapabilityRefusal(`No change ${values.proposal} is waiting; nothing was applied.`, '"See what edited memory files would change" lists the changes.');
    const applied: MemoryProjectionProposal[] = [];
    const failed: string[] = [];
    for (const proposal of targeted) {
      try {
        if (proposal.kind === 'delete') {
          if (await memory.delete(proposal.id)) applied.push(proposal);
          else failed.push(`${proposal.id}: the record was already gone`);
          continue;
        }
        if (!proposal.changedFields?.length) {
          failed.push(`${proposal.id}: memory also changed ${(proposal.conflictFields ?? []).join(', ')} since the files were written, so nothing was taken from the file; correct the record for the file's value`);
          continue;
        }
        const desired = proposal.desired ?? {};
        const result = await memory.update(proposal.id, {
          ...(desired.scope !== undefined ? { scope: desired.scope as MemoryScope } : {}),
          ...(desired.summary !== undefined ? { summary: desired.summary } : {}),
          ...(desired.detail !== undefined ? { detail: desired.detail } : {}),
          ...(desired.tags !== undefined ? { tags: [...desired.tags] } : {}),
          ...(desired.validFrom !== undefined ? { validFrom: desired.validFrom } : {}),
          ...(desired.validUntil !== undefined ? { validUntil: desired.validUntil } : {}),
        });
        if (result) applied.push(proposal);
        else failed.push(`${proposal.id}: the record was not found`);
      } catch (error) {
        failed.push(`${proposal.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const lines = [`Applied ${applied.length} of ${targeted.length}.`, ...applied.map((proposal) => `  ${proposal.id}  ${proposal.kind === 'delete' ? 'deleted' : 'changed'}`), ...failed.map((line) => `  not applied: ${line}`)];
    if (failed.length > 0 && applied.length === 0) throw new CapabilityRefusal(lines.join('\n'));
    return { text: lines.join('\n'), data: { applied: applied.map((proposal) => proposal.id), failed: failed.length } };
  },
};

/** Every memory capability that runs in the program holding the conversation. */
export const MEMORY_SESSION_CAPABILITIES: readonly SessionDefinition[] = [
  MEMORY_INJECTIONS, MEMORY_CAPTURE, MEMORY_SYNC_FILES, MEMORY_REVIEW_FILES, MEMORY_APPLY_FILES,
];
