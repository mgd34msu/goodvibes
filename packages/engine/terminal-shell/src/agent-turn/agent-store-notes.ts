/**
 * The acts on your notes (capabilities/builtin/notes.ts), done by the daemon
 * on the one note store: `~/.goodvibes/agent/notes/notes.json`.
 */
import { CapabilityRefusal, type ActionValues } from '@goodvibes/engine/platform/platform/capabilities';
import type { MemoryAuthor, MemoryClass, MemoryScope } from '@goodvibes/engine/platform/platform/state';
import { memoryAwaitsOwner, memoryProjectIdentity } from '@goodvibes/engine/platform/platform/state';
import { AgentNoteRegistry, type AgentNoteRecord } from './note-registry.js';
import { AgentPersonaRegistry } from './persona-registry.js';
import { AgentSkillRegistry } from './skill-registry.js';
import { AgentRoutineRegistry } from './routine-registry.js';
import { formatAgentRecordReviewState } from './record-labels.js';
import { ownersOwnReview, provenanceBy, splitWords, storeStep, storeStepAsync, writtenBy, type StoreAct, type StoreActContext } from './agent-store-common.js';

const notesOf = (context: StoreActContext): AgentNoteRegistry => AgentNoteRegistry.fromShellPaths(context.shellPaths);

function noteOrRefuse(context: StoreActContext, idOrTitle: string): AgentNoteRecord {
  const note = storeStep(() => notesOf(context).get(idOrTitle));
  if (!note) throw new CapabilityRefusal(`No note ${idOrTitle}.`, 'Your notes are listed in Memory and knowledge.', 'NOT_FOUND');
  return note;
}

/** A title from the first words of a note's text, for a note written without one. */
export function noteTitleFromText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const words = compact.split(' ').slice(0, 8).join(' ');
  return (words.length > 60 ? `${words.slice(0, 57)}...` : words) || 'Note';
}

/** The first sentence of the note, as a one-line summary of it. */
export function noteSummary(note: Pick<AgentNoteRecord, 'body' | 'title'>): string {
  const compact = note.body.replace(/\s+/g, ' ').trim();
  const first = compact.split(/(?<=[.!?])\s+/)[0]?.trim() ?? compact;
  return (first.length > 160 ? `${first.slice(0, 157)}...` : first) || note.title;
}

/** A note as a screen or a script reads it. */
function noteFacts(note: AgentNoteRecord) {
  return {
    id: note.id, title: note.title, state: note.reviewState, review: formatAgentRecordReviewState(note.reviewState), summary: noteSummary(note),
    body: note.body, tags: [...note.tags], ...(note.sourceUrl ? { url: note.sourceUrl } : {}), ...(note.staleReason ? { staleReason: note.staleReason } : {}),
    made: (note.promoted ?? []).map((entry) => ({ kind: entry.domain, id: entry.id })), createdAt: note.createdAt, updatedAt: note.updatedAt,
  };
}

function summarize(note: AgentNoteRecord): string {
  const source = note.sourceUrl ? `  ${note.sourceUrl}` : '';
  const tags = note.tags.length > 0 ? `  tags ${note.tags.join(', ')}` : '';
  return `  ${note.id}  ${formatAgentRecordReviewState(note.reviewState)}  ${note.title}${source}${tags}`;
}

function listed(title: string, notes: readonly AgentNoteRecord[]) {
  return {
    text: notes.length === 0 ? `${title}\n  No notes yet.` : [`${title} (${notes.length})`, ...notes.map(summarize)].join('\n'),
    data: { notes: notes.map(noteFacts) },
  };
}

function renderNote(note: AgentNoteRecord): string {
  const made = (note.promoted ?? []).map((entry) => `${entry.domain} ${entry.id}`).join(', ');
  return [
    `Note ${note.title}`,
    `  id ${note.id}`,
    `  review: ${formatAgentRecordReviewState(note.reviewState)}`,
    note.staleReason ? `  out of date because: ${note.staleReason}` : '',
    `  web page: ${note.sourceUrl ?? '(none)'}`,
    `  tags: ${note.tags.join(', ') || '(none)'}`,
    made ? `  made from it: ${made}` : '',
    `  updated: ${note.updatedAt}`,
  ].filter(Boolean).concat('', note.body).join('\n');
}

function noteTags(note: AgentNoteRecord): string[] {
  return [...new Set([...note.tags, 'from-note'])];
}

type Made = 'memory' | 'persona' | 'skill' | 'routine';

/** A record of that kind already made from this note: making another is refused. */
function refuseIfMade(note: AgentNoteRecord, domain: Made): void {
  const made = (note.promoted ?? []).find((entry) => entry.domain === domain);
  if (made) throw new CapabilityRefusal(`Note ${note.id} already made ${domain} ${made.id}; nothing new was made.`, `Change ${domain} ${made.id} instead.`);
}

/**
 * Record on the note what was made from it. The record is already written and
 * is what the person asked for, so it is kept when the note cannot record it;
 * the refusal says it exists, so a retry does not make a second.
 */
function recordMade(context: StoreActContext, note: AgentNoteRecord, domain: Made, id: string): void {
  try {
    notesOf(context).recordPromotion(note.id, { domain, id });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CapabilityRefusal(`Made ${domain} ${id} from note ${note.id}, but the note could not record it: ${reason}.`,
      `It is kept; change ${domain} ${id} itself, and do not make it from the note again.`);
  }
}

const change = (note: AgentNoteRecord, text: string) => ({ text, data: { note: noteFacts(note) } });

/**
 * The author of a record made from a note: someone else's note the owner has not accepted stays someone else's in what
 * is made from it; otherwise who makes it (state/memory-author.ts).
 */
function madeFromNoteBy(note: AgentNoteRecord, context: StoreActContext): MemoryAuthor {
  return memoryAwaitsOwner(note) && note.author ? note.author : writtenBy(context);
}

export const NOTE_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'notes.list'(_values, context) { return listed('Notes', storeStep(() => notesOf(context).list())); },
  async 'notes.show'(values, context) { const note = noteOrRefuse(context, values.note!); return { text: renderNote(note), data: { note: noteFacts(note) } }; },
  async 'notes.search'(values, context) { return listed(`Notes matching "${values.words}"`, storeStep(() => notesOf(context).search(values.words!))); },
  async 'notes.create'(values, context) {
    const note = storeStep(() => notesOf(context).create({
      title: values.title || noteTitleFromText(values.body!), body: values.body!, tags: splitWords(values.tags), sourceUrl: values.url || undefined, source: 'user', provenance: provenanceBy(context, 'Command'), author: writtenBy(context),
    }));
    return change(note, `Wrote note ${note.title}.`);
  },
  async 'notes.edit'(values, context) {
    const note = storeStep(() => notesOf(context).update(values.note!, {
      title: values.title || undefined, body: values.body || undefined, sourceUrl: values.url || undefined,
      tags: values.tags ? splitWords(values.tags) : undefined, provenance: provenanceBy(context, 'Command'), by: writtenBy(context),
    }));
    return change(note, `Changed note ${note.title}.`);
  },
  async 'notes.review'(values, context) { ownersOwnReview(context, 'Marking a note reviewed'); const note = storeStep(() => notesOf(context).markReviewed(values.note!, { accept: true })); return change(note, `Marked note ${note.id} reviewed.`); },
  async 'notes.stale'(values, context) { const note = storeStep(() => notesOf(context).markStale(values.note!, values.reason!)); return change(note, `Marked note ${note.id} out of date.`); },
  async 'notes.delete'(values, context) { const note = storeStep(() => notesOf(context).deleteNote(values.note!)); return change(note, `Deleted note ${note.title}.`); },
  async 'notes.to-memory'(values, context) {
    const note = noteOrRefuse(context, values.note!);
    refuseIfMade(note, 'memory');
    const memory = context.memory;
    if (!memory) throw new CapabilityRefusal('Memory is not available in this daemon; nothing was kept.');
    const scope = (values.scope || 'project') as MemoryScope;
    // "This project" is the asking project's (the folder the request came with), never the daemon's own.
    if (scope === 'project' && !context.projectGiven) {
      throw new CapabilityRefusal('"This project" needs the project, and no project folder came with the request; nothing was kept.',
        'Ask from the project\'s folder, or keep it "Shared with the team" so every project is given it.');
    }
    const record = await storeStepAsync(async () => memory.add({
      scope, ...(scope === 'project' ? { project: memoryProjectIdentity(context.shellPaths.workingDirectory) } : {}),
      cls: (values.class || 'fact') as MemoryClass, summary: note.title,
      detail: note.sourceUrl ? `${note.body}\n\nOrigin URL: ${note.sourceUrl}` : note.body, tags: noteTags(note), provenance: [],
      // Who keeps it as a memory writes it: someone else's waits for the owner's review before any turn is given it.
      author: madeFromNoteBy(note, context),
    }));
    recordMade(context, note, 'memory', record.id);
    return { text: `Kept note ${note.id} as memory record ${record.id}.`, data: { note: note.id, memory: record.id } };
  },
  async 'notes.to-persona'(values, context) {
    const note = noteOrRefuse(context, values.note!);
    refuseIfMade(note, 'persona');
    const persona = storeStep(() => AgentPersonaRegistry.fromShellPaths(context.shellPaths).create({
      name: note.title, description: noteSummary(note), body: note.body, tags: noteTags(note), triggers: [], source: 'user', provenance: provenanceBy(context, `Note ${note.id}`), author: madeFromNoteBy(note, context),
    }));
    recordMade(context, note, 'persona', persona.id);
    return { text: `Made persona ${persona.id} from note ${note.id}; it is not in use yet.`, data: { note: note.id, persona: persona.id } };
  },
  async 'notes.to-skill'(values, context) {
    const note = noteOrRefuse(context, values.note!);
    refuseIfMade(note, 'skill');
    const skill = storeStep(() => AgentSkillRegistry.fromShellPaths(context.shellPaths).create({
      name: note.title, description: noteSummary(note), procedure: note.body, tags: noteTags(note), triggers: [],
      enabled: values.enabled === 'yes', source: 'user', provenance: provenanceBy(context, `Note ${note.id}`), author: madeFromNoteBy(note, context),
    }));
    recordMade(context, note, 'skill', skill.id);
    return { text: `Made skill ${skill.id} from note ${note.id}${values.enabled === 'yes' ? ', switched on' : '; it is off until you switch it on'}.`, data: { note: note.id, skill: skill.id } };
  },
  async 'notes.to-routine'(values, context) {
    const note = noteOrRefuse(context, values.note!);
    refuseIfMade(note, 'routine');
    const routine = storeStep(() => AgentRoutineRegistry.fromShellPaths(context.shellPaths).create({
      name: note.title, description: noteSummary(note), steps: note.body, tags: noteTags(note), triggers: [],
      enabled: values.enabled === 'yes', source: 'user', provenance: provenanceBy(context, `Note ${note.id}`), author: madeFromNoteBy(note, context),
    }));
    recordMade(context, note, 'routine', routine.id);
    return { text: `Made routine ${routine.id} from note ${note.id}${values.enabled === 'yes' ? ', switched on' : '; it is off until you switch it on'}.`, data: { note: note.id, routine: routine.id } };
  },
  async 'notes.to-knowledge'(values: ActionValues, context) {
    const note = noteOrRefuse(context, values.note!);
    const url = note.sourceUrl?.trim();
    if (!url) throw new CapabilityRefusal(`Note ${note.id} names no web page; nothing was added.`, 'Give the note a web page first, then add it.');
    const ingest = context.ingestUrl;
    if (!ingest) throw new CapabilityRefusal('This daemon was started without its knowledge store; nothing was added.', undefined, 'UNAVAILABLE');
    // The same act as adding a web page to your knowledge, with the note's page, its tags and the folder "notes".
    const { source } = await storeStepAsync(() => ingest({ url, tags: noteTags(note), folderPath: 'notes' }));
    return { text: `Added ${url} to Agent Knowledge${source.title ? ` as "${source.title}"` : ''}.`, data: { note: note.id, url, source: source.id } };
  },
};
