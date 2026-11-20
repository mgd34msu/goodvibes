/**
 * What the knowledge base knows, by subject (ux A7.6): the store's records read
 * as facts filed under subjects, each with where it came from.
 *
 * - A subject is a topic node: the store makes one per tag a source, a memory
 *   or a fact carries, and per section heading that names a fact.
 * - A fact is every other node a person would read as something known: a fact
 *   the decision model read from a source, a memory mirrored into the store,
 *   an entity compiled from a structured source, a Home Assistant record. The
 *   graph's own scaffolding (topics, domains, bookmark folders, source groups),
 *   its gaps and its wiki pages are not facts; they stay under Details.
 * - Where a fact came from is the reference the store keeps on the record
 *   itself: `sourceId` (a fact or a gap), `metadata.sourceId` (a section
 *   topic), `metadata.compiledFrom` (a compiled entity), `metadata.memoryId`
 *   (a mirrored memory). Nothing is guessed: a record without one shows only
 *   when it was learned.
 * - A fact is filed under a subject when it names it: its aliases (a memory's
 *   tags, a fact's labels), `metadata.tags` (a compiled entity's source tags)
 *   or `metadata.subject`. A fact that names none is listed under
 *   {@link UNFILED_SUBJECT}.
 *
 * Pure: no request. KnowledgeView feeds it the nodes and sources it has read.
 */
import { whenLabel } from '../../lib/when-label';

/** The kinds that are the graph's structure, its gaps or its pages, never facts. */
const NOT_FACTS: ReadonlySet<string> = new Set(['topic', 'domain', 'bookmark_folder', 'source_group', 'knowledge_gap', 'wiki_page']);

/** The group for facts that name no subject. */
export const UNFILED_SUBJECT = 'Everything else';

export interface KnowledgeFact {
  readonly id: string;
  /** What it knows, in the record's own words. */
  readonly text: string;
  /** `From <source title> · <when>`, or `<when>` alone when the record keeps no reference. */
  readonly origin: string;
  readonly updatedAt: number;
}

export interface KnowledgeSubject {
  /** The subject's name (the topic's title). */
  readonly name: string;
  readonly facts: readonly KnowledgeFact[];
}

type RecordLike = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordLike : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(text).filter((item) => item.length > 0) : [];
}

function time(record: RecordLike): number {
  const updated = record.updatedAt, created = record.createdAt;
  return typeof updated === 'number' ? updated : typeof created === 'number' ? created : 0;
}

/** A source's name as a person knows it: its title, else its address. */
export function sourceTitle(source: unknown): string {
  const record = asRecord(source);
  return text(record.title) || text(record.canonicalUri) || text(record.sourceUri) || text(record.url);
}

/** Where a record came from, as the store keeps it on the record; '' when it keeps none. */
function originOf(node: RecordLike, sourceTitles: ReadonlyMap<string, string>): string {
  const metadata = asRecord(node.metadata);
  const sourceId = text(node.sourceId) || text(metadata.sourceId) || text(metadata.compiledFrom);
  if (sourceId) return sourceTitles.get(sourceId) || 'a source no longer listed';
  if (node.kind === 'memory' || text(metadata.memoryId)) return 'memory';
  return '';
}

function subjectNamesOf(node: RecordLike): readonly string[] {
  const metadata = asRecord(node.metadata);
  return [...strings(node.aliases), ...strings(metadata.tags), ...strings(metadata.labels), text(metadata.subject)]
    .filter((name) => name.length > 0);
}

/** Facts grouped by subject, subjects with the most facts first; {@link UNFILED_SUBJECT} last. */
export function knowledgeSubjects(nodes: readonly unknown[], sources: readonly unknown[], now: number = Date.now()): readonly KnowledgeSubject[] {
  const sourceTitles = new Map<string, string>();
  for (const source of sources) {
    const record = asRecord(source);
    const id = text(record.id);
    if (id) sourceTitles.set(id, sourceTitle(record) || 'a source');
  }
  // Subject names by their lowercase form, spelled as the topic spells them.
  const topics = new Map<string, string>();
  for (const node of nodes) {
    const record = asRecord(node);
    if (record.kind !== 'topic') continue;
    const name = text(record.title);
    if (name && !topics.has(name.toLowerCase())) topics.set(name.toLowerCase(), name);
  }
  const grouped = new Map<string, KnowledgeFact[]>();
  const seen = new Set<string>();
  for (const node of nodes) {
    const record = asRecord(node);
    const id = text(record.id);
    const kind = text(record.kind);
    if (!id || !kind || NOT_FACTS.has(kind) || seen.has(id)) continue;
    seen.add(id);
    const factText = text(record.title) || text(record.summary);
    if (!factText) continue;
    const updatedAt = time(record);
    const from = originOf(record, sourceTitles);
    const when = whenLabel(updatedAt, now);
    const fact: KnowledgeFact = { id, text: factText, origin: [from && `From ${from}`, when].filter(Boolean).join(' · '), updatedAt };
    const subjects = new Set<string>();
    for (const name of subjectNamesOf(record)) {
      const subject = topics.get(name.toLowerCase());
      if (subject) subjects.add(subject);
    }
    if (subjects.size === 0) subjects.add(UNFILED_SUBJECT);
    for (const subject of subjects) {
      const bucket = grouped.get(subject);
      if (bucket) bucket.push(fact); else grouped.set(subject, [fact]);
    }
  }
  return [...grouped.entries()]
    .map(([name, facts]) => ({ name, facts: [...facts].sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => {
      if (a.name === UNFILED_SUBJECT) return 1;
      if (b.name === UNFILED_SUBJECT) return -1;
      return b.facts.length - a.facts.length || a.name.localeCompare(b.name);
    });
}
