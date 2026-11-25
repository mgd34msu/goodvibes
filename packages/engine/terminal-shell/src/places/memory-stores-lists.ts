/**
 * memory-stores-lists.ts, the terminal side of the Memory and knowledge
 * place's notes, personas, routines, drafts and artifacts
 * (memory-stores-entries.ts holds their lists and actions): the live lists a
 * form's inputs choose from (a note, a persona, a routine, a draft, its
 * comments and suggestions, an artifact, a file found to import), read through
 * the program's daemon binding. Moved here from memory-stores-entries.ts,
 * unchanged, so the declaration holds no terminal code and the web UI draws it
 * too (places/browser.ts).
 */
import {
  ARTIFACTS_LIST, DOCUMENTS_LIST, DOCUMENT_COMMENTS_LIST, DOCUMENT_SUGGESTIONS_LIST, NOTES_LIST, PERSONAS_LIST, PERSONA_FILES_LIST,
  ROUTINES_LIST, ROUTINE_FILES_LIST, ROUTINE_RECEIPTS_LIST,
} from '@goodvibes/engine/platform/platform/capabilities';
import { defineList, type ListRow } from '../command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { CommandActionContext, ListName } from '../command-actions/types.js';
import {
  DRAFT_WORDS, REVIEW_WORDS, RUNNING_WORDS, artifactItems, draftItems, noteItems, personaItems, reviewOf, routineItems,
} from './memory-stores-entries.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value) ? value.map(record) : [];
/** Text written by a person, a model or a file, on one line: control characters out. */
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
const dataOf = (output: unknown): Readonly<Record<string, unknown>> => record(record(output)['data']);

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** Each program gives the binding its places use (capability-binding.ts), so a form's lists read the daemon. */
export function bindMemoryStoreLists(next: DaemonCapabilityBinding<never>): void {
  binding = next as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

async function read(id: string, ctx: CommandActionContext, inputs: Readonly<Record<string, string>> = {}): Promise<unknown> {
  if (!binding) return {};
  return runDaemonCapability(id, inputs, ctx, binding);
}

const operator = (id: string, from: string, value: string, label: string, extra: { readonly detail?: string; readonly state?: string; readonly where?: { readonly field: string; readonly equals: string }; readonly each?: string } = {}) => ({
  method: 'capabilities.run', input: { id }, rows: { from: `data.${from}`, value, label, ...extra },
});

function storeList(name: ListName, id: string, inputs: Readonly<Record<string, string>>, rows: (output: unknown, earlier: Readonly<Record<string, string>>) => readonly ListRow[], spec: ReturnType<typeof operator>): void {
  defineList<CommandActionContext>({ name, async read(ctx, earlier) { return rows(await read(id, ctx, inputs), earlier); }, operator: spec });
}

const ORIGIN_WORDS: Readonly<Record<string, string>> = { 'project-local': 'this project', global: 'your own folders', custom: 'another folder' };
const filesOf = (output: unknown): readonly ListRow[] => list(dataOf(output)['files']).filter((file) => text(file['name']))
  .map((file): ListRow => ({ value: text(file['name']), label: plain(file['name']), ...(text(file['path']) ? { detail: plain(file['path']) } : {}), state: ORIGIN_WORDS[text(file['origin'])] ?? plain(file['origin']) }));
/** The draft a comment or suggestion blank is for, from the drafts as listed. */
const draftOf = (output: unknown, earlier: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> =>
  list(dataOf(output)['documents']).find((document) => document['id'] === earlier.document || document['title'] === earlier.document) ?? {};

storeList(NOTES_LIST, 'notes.list', {}, (output) => noteItems(output).map((note): ListRow => ({ value: note.id, label: note.title, ...(note.summary ? { detail: note.summary } : {}), state: REVIEW_WORDS[note.state] })),
  operator('notes.list', 'notes', 'id', 'title', { detail: 'summary', state: 'review' }));
storeList(PERSONAS_LIST, 'personas.list', {}, (output) => personaItems(output).map((persona): ListRow => ({ value: persona.id, label: persona.name, ...(persona.description ? { detail: persona.description } : {}), state: persona.state.startsWith('in-use') ? 'in use' : REVIEW_WORDS[reviewOf(persona.state)] })),
  operator('personas.list', 'personas', 'id', 'name', { detail: 'description', state: 'review' }));
storeList(PERSONA_FILES_LIST, 'personas.discover', {}, filesOf, operator('personas.discover', 'files', 'name', 'name', { detail: 'path', state: 'origin' }));
storeList(ROUTINES_LIST, 'routines.list', {}, (output) => routineItems(output).map((routine): ListRow => ({ value: routine.id, label: routine.name, ...(routine.description ? { detail: routine.description } : {}), state: RUNNING_WORDS[routine.state.slice(0, routine.state.lastIndexOf('-'))] ?? '' })),
  operator('routines.list', 'routines', 'id', 'name', { detail: 'description', state: 'state' }));
storeList(ROUTINE_RECEIPTS_LIST, 'routines.receipts', {}, (output) => list(dataOf(output)['receipts']).filter((receipt) => text(receipt['id']))
  .map((receipt): ListRow => ({ value: text(receipt['id']), label: plain(receipt['schedule']) || text(receipt['id']), detail: text(receipt['createdAt']), state: plain(receipt['state']) })),
  operator('routines.receipts', 'receipts', 'id', 'schedule', { detail: 'createdAt', state: 'state' }));
storeList(ROUTINE_FILES_LIST, 'routines.discover', {}, filesOf, operator('routines.discover', 'files', 'name', 'name', { detail: 'path', state: 'origin' }));
storeList(DOCUMENTS_LIST, 'documents.list', { limit: '1000' }, (output) => draftItems(output).map((draft): ListRow => ({ value: draft.id, label: draft.title, detail: `${draft.versions} version${draft.versions === 1 ? '' : 's'}`, state: DRAFT_WORDS[draft.state] })),
  operator('documents.list', 'documents', 'id', 'title', { state: 'status' }));
storeList(DOCUMENT_COMMENTS_LIST, 'documents.list', { limit: '1000' }, (output, earlier) => list(draftOf(output, earlier)['comments']).filter((comment) => comment['state'] !== 'resolved' && text(comment['id']))
  .map((comment): ListRow => ({ value: text(comment['id']), label: plain(comment['body']).slice(0, 80) || text(comment['id']), state: plain(comment['state']) })),
  operator('documents.list', 'documents', 'id', 'body', { where: { field: 'id', equals: '{document}' }, each: 'comments', state: 'state' }));
storeList(DOCUMENT_SUGGESTIONS_LIST, 'documents.list', { limit: '1000' }, (output, earlier) => list(draftOf(output, earlier)['suggestions']).filter((suggestion) => suggestion['state'] === 'proposed' && text(suggestion['id']))
  .map((suggestion): ListRow => ({ value: text(suggestion['id']), label: plain(suggestion['summary']) || text(suggestion['id']), state: plain(suggestion['state']) })),
  operator('documents.list', 'documents', 'id', 'summary', { where: { field: 'id', equals: '{document}' }, each: 'suggestions', state: 'state' }));
storeList(ARTIFACTS_LIST, 'artifacts.list', { limit: '1000' }, (output) => artifactItems(output).map((artifact): ListRow => ({ value: artifact.id, label: artifact.name, detail: [artifact.state, artifact.mimeType].filter(Boolean).join(', '), state: artifact.createdAt.slice(0, 10) })),
  operator('artifacts.list', 'artifacts', 'id', 'name', { detail: 'mimeType', state: 'kind' }));
