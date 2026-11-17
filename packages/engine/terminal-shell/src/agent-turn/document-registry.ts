import { defineLifecycle } from '@goodvibes-jev/engine/platform/platform/utils/lifecycle-machine';
import { openSqliteFile, type SqliteFile } from '@goodvibes-jev/engine/platform/platform/state';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { assertNoSecretLikeText } from './persona-registry.js';
import type {
  AgentDocumentAttachment,
  AgentDocumentAttachmentInput,
  AgentDocumentComment,
  AgentDocumentCommentInput,
  AgentDocumentCommentStatus,
  AgentDocumentCreateInput,
  AgentDocumentRecord,
  AgentDocumentSnapshot,
  AgentDocumentStatus,
  AgentDocumentSuggestion,
  AgentDocumentSuggestionInput,
  AgentDocumentSuggestionStatus,
  AgentDocumentUpdateInput,
  AgentDocumentVersion,
} from './document-registry-types.js';
export type {
  AgentDocumentAttachment,
  AgentDocumentAttachmentInput,
  AgentDocumentComment,
  AgentDocumentCommentInput,
  AgentDocumentCommentStatus,
  AgentDocumentCreateInput,
  AgentDocumentRecord,
  AgentDocumentSnapshot,
  AgentDocumentStatus,
  AgentDocumentSuggestion,
  AgentDocumentSuggestionInput,
  AgentDocumentSuggestionStatus,
  AgentDocumentUpdateInput,
  AgentDocumentVersion,
} from './document-registry-types.js';

type AgentDocumentStorePaths = Pick<ShellPathService, 'resolveProjectPath'>;

/** Document status is a label the owner may set freely (including un-archiving); no move is illegal. */
export const agentDocumentLifecycle = defineLifecycle<AgentDocumentStatus>('document', {
  draft: ['draft', 'reviewed', 'archived'],
  reviewed: ['draft', 'reviewed', 'archived'],
  archived: ['draft', 'reviewed', 'archived'],
});

/** A comment is resolved once; resolveComment re-stamping an already resolved comment is not a lifecycle move. */
export const agentDocumentCommentLifecycle = defineLifecycle<AgentDocumentCommentStatus>('document comment', {
  open: ['resolved'],
  resolved: [],
});

/** A suggestion is decided once: accepted and rejected are final. */
export const agentDocumentSuggestionLifecycle = defineLifecycle<AgentDocumentSuggestionStatus>('document suggestion', {
  proposed: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
});

const MAX_VERSIONS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'document';
}

function nowIso(): string {
  return new Date().toISOString();
}

function documentStatus(value: unknown): AgentDocumentStatus {
  if (value === 'reviewed' || value === 'archived') return value;
  return 'draft';
}

function commentStatus(value: unknown): AgentDocumentCommentStatus {
  return value === 'resolved' ? 'resolved' : 'open';
}

function suggestionStatus(value: unknown): AgentDocumentSuggestionStatus {
  if (value === 'accepted' || value === 'rejected') return value;
  return 'proposed';
}

function assertDocumentContentSafe(fields: readonly string[]): void {
  try {
    assertNoSecretLikeText(fields);
  } catch {
    throw new Error('Documents cannot store secret-looking values. Store a secret reference or remove the sensitive text.');
  }
}

function parseVersion(value: unknown): AgentDocumentVersion | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  const summary = readString(value.summary).trim();
  if (!id || !title || !body) return null;
  return {
    id,
    title,
    body,
    summary,
    createdAt: readString(value.createdAt, nowIso()),
  };
}

function parseComment(value: unknown): AgentDocumentComment | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const body = readString(value.body).trim();
  if (!id || !body) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const resolvedAt = readString(value.resolvedAt).trim();
  return {
    id,
    body,
    status: commentStatus(value.status),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    resolvedAt: resolvedAt || undefined,
  };
}

function parseSuggestion(value: unknown): AgentDocumentSuggestion | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  const summary = readString(value.summary).trim();
  if (!id || !title || !body || !summary) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const resolvedAt = readString(value.resolvedAt).trim();
  const baseVersionId = readString(value.baseVersionId).trim();
  return {
    id,
    title,
    body,
    tags: readStringArray(value.tags),
    ...(baseVersionId ? { baseVersionId } : {}),
    ...(value.documentStatus === undefined ? {} : { documentStatus: documentStatus(value.documentStatus) }),
    summary,
    rationale: readString(value.rationale).trim(),
    status: suggestionStatus(value.status),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    resolvedAt: resolvedAt || undefined,
  };
}

function parseAttachment(value: unknown): AgentDocumentAttachment | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const artifactId = readString(value.artifactId).trim();
  const label = readString(value.label).trim();
  if (!id || !artifactId || !label) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const sizeBytes = typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes)
    ? Math.max(0, Math.trunc(value.sizeBytes))
    : undefined;
  const note = readString(value.note).trim();
  const filename = readString(value.filename).trim();
  const mimeType = readString(value.mimeType).trim();
  const kind = readString(value.kind).trim();
  return {
    id,
    artifactId,
    label,
    ...(note ? { note } : {}),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(kind ? { kind } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
  };
}

function parseDocument(value: unknown): AgentDocumentRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  if (!id || !title || !body) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const versions = Array.isArray(value.versions)
    ? value.versions.map(parseVersion).filter((entry): entry is AgentDocumentVersion => entry !== null)
    : [];
  const comments = Array.isArray(value.comments)
    ? value.comments.map(parseComment).filter((entry): entry is AgentDocumentComment => entry !== null)
    : [];
  const suggestions = Array.isArray(value.suggestions)
    ? value.suggestions.map(parseSuggestion).filter((entry): entry is AgentDocumentSuggestion => entry !== null)
    : [];
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(parseAttachment).filter((entry): entry is AgentDocumentAttachment => entry !== null)
    : [];
  const lastArtifactId = readString(value.lastArtifactId).trim();
  const versionCount = typeof value.versionCount === 'number' && Number.isSafeInteger(value.versionCount) && value.versionCount >= versions.length
    ? value.versionCount
    : versions.length;
  return {
    id,
    title,
    body,
    tags: readStringArray(value.tags),
    status: documentStatus(value.status),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    versions,
    versionCount,
    comments,
    suggestions,
    attachments,
    lastArtifactId: lastArtifactId || undefined,
  };
}

/** The version a document is at now. */
function currentVersionId(document: AgentDocumentRecord): string {
  return document.versions.at(-1)?.id ?? 'v1';
}

/**
 * The next version id: one past the highest given, not one past the count.
 * Only the newest MAX_VERSIONS are kept, so the count stops growing at the cap
 * and a count-based id would repeat for every later revision. Ids only grow,
 * so the newest version's number and the retained count are enough.
 */
function nextVersionId(document: Pick<AgentDocumentRecord, 'versions' | 'versionCount'>): string {
  let highest = document.versionCount;
  for (const version of document.versions) {
    const number = /^v(\d+)$/.exec(version.id)?.[1];
    if (number !== undefined) highest = Math.max(highest, Number(number));
  }
  return `v${highest + 1}`;
}

function compactExportLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function renderCommentSummary(comment: AgentDocumentComment): string {
  const resolved = comment.resolvedAt ? ` resolved ${comment.resolvedAt}` : '';
  return `- ${comment.id} [${comment.status}] ${compactExportLine(comment.body)} (created ${comment.createdAt}${resolved})`;
}

function renderSuggestionSummary(suggestion: AgentDocumentSuggestion): string {
  const parts = [
    `- ${suggestion.id} [${suggestion.status}] ${compactExportLine(suggestion.summary)}`,
    suggestion.rationale ? `Rationale: ${compactExportLine(suggestion.rationale)}` : '',
    `Title: ${suggestion.title}`,
    suggestion.tags.length > 0 ? `Tags: ${suggestion.tags.join(', ')}` : '',
    suggestion.documentStatus ? `Status after accept: ${suggestion.documentStatus}` : '',
    suggestion.baseVersionId ? `Proposed against: ${suggestion.baseVersionId}` : '',
    suggestion.resolvedAt ? `Resolved: ${suggestion.resolvedAt}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

export function documentStorePath(shellPaths: AgentDocumentStorePaths): string {
  return shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'documents', 'documents.db');
}

/**
 * Documents are rows: one per document, holding its current text, comments,
 * suggestions, attachments and newest version, and one row per retained
 * version. A list or a lookup reads document rows only; the version history is
 * read only when it is asked for, so a document's edit history never slows a
 * list. A write is one transaction over the rows it changes.
 */
const DOCUMENT_MIGRATIONS = [
  { toVersion: 1, up(db: SqliteFile['db']) {
    db.run('CREATE TABLE documents (id TEXT PRIMARY KEY, id_key TEXT NOT NULL UNIQUE, title_key TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL)');
    db.run('CREATE INDEX documents_title ON documents (title_key)');
    db.run('CREATE TABLE versions (document_id TEXT NOT NULL, seq INTEGER NOT NULL, version TEXT NOT NULL, PRIMARY KEY (document_id, seq))');
  } },
];

/** The document row: everything but the version history, which keeps only the newest version. */
function parseRow(record: string): AgentDocumentRecord | null {
  try { return parseDocument(JSON.parse(record)); } catch { return null; }
}

function storedRecord(document: AgentDocumentRecord): Record<string, unknown> {
  return { ...document, versions: document.versions.slice(-1) };
}

const openStores = new Map<string, SqliteFile>();

/** One open handle per store file for the life of the process. */
function documentStore(path: string): SqliteFile {
  let store = openStores.get(path);
  if (!store) {
    store = openSqliteFile(path, { name: 'document store', migrations: DOCUMENT_MIGRATIONS });
    openStores.set(path, store);
  }
  return store;
}

export function renderAgentDocumentMarkdown(document: AgentDocumentRecord): string {
  const tags = document.tags.length > 0 ? `\nTags: ${document.tags.join(', ')}` : '';
  const openComments = document.comments.filter((comment) => comment.status === 'open').length;
  const comments = document.comments.length > 0 ? `\nComments: ${openComments} open / ${document.comments.length} total` : '';
  const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
  const suggestions = document.suggestions.length > 0 ? `\nSuggestions: ${proposedSuggestions} proposed / ${document.suggestions.length} total` : '';
  const attachments = document.attachments.length > 0 ? `\nAttachments: ${document.attachments.length}` : '';
  const lines = [
    `# ${document.title}`,
    '',
    `Document ID: ${document.id}`,
    `Version: ${document.versions.at(-1)?.id ?? 'v1'}`,
    `Status: ${document.status}`,
    `Updated: ${document.updatedAt}${tags}${comments}${suggestions}${attachments}`,
    '',
    document.body,
    '',
  ];
  if (document.attachments.length > 0) {
    lines.push(
      '## Attached Artifacts',
      '',
      ...document.attachments.map((attachment) => {
        const details = [
          attachment.filename ?? '',
          attachment.mimeType ?? '',
          attachment.kind ?? '',
        ].filter(Boolean).join(' / ');
        const note = attachment.note ? ` - ${attachment.note}` : '';
        return `- ${attachment.id}: ${attachment.label} (${attachment.artifactId}${details ? `, ${details}` : ''})${note}`;
      }),
      '',
    );
  }
  if (document.comments.length > 0) {
    lines.push(
      '## Review Comments',
      '',
      ...document.comments.map(renderCommentSummary),
      '',
    );
  }
  if (document.suggestions.length > 0) {
    lines.push(
      '## AI Suggestions',
      '',
      ...document.suggestions.map(renderSuggestionSummary),
      '',
    );
  }
  return lines.join('\n');
}

export interface AgentDocumentWriteOptions {
  /**
   * The document's revision when the caller read it. A write that would
   * replace text read before an await is refused when another write landed
   * in between, instead of undoing it.
   */
  readonly expectedRevision?: number | undefined;
}

export class AgentDocumentRegistry {
  public constructor(private readonly storePath: string, private readonly assertWriteCurrent?: () => void) {}

  public static fromShellPaths(shellPaths: AgentDocumentStorePaths, assertWriteCurrent?: () => void): AgentDocumentRegistry {
    return new AgentDocumentRegistry(documentStorePath(shellPaths), assertWriteCurrent);
  }

  private get store(): SqliteFile {
    return documentStore(this.storePath);
  }

  public snapshot(): AgentDocumentSnapshot {
    const rows = this.store.db.query('SELECT record FROM documents ORDER BY updated_at DESC').all() as { record: string }[];
    return {
      path: this.storePath,
      documents: rows.map((row) => parseRow(row.record)).filter((document): document is AgentDocumentRecord => document !== null),
    };
  }

  public list(): readonly AgentDocumentRecord[] {
    return this.snapshot().documents;
  }

  public search(query: string): readonly AgentDocumentRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((document) => [
      document.id,
      document.title,
      document.body,
      document.status,
      document.lastArtifactId ?? '',
      ...document.tags,
      ...document.attachments.map((attachment) => [
        attachment.id,
        attachment.artifactId,
        attachment.label,
        attachment.note ?? '',
        attachment.filename ?? '',
        attachment.mimeType ?? '',
        attachment.kind ?? '',
      ].join(' ')),
      ...document.comments.map((comment) => `${comment.id} ${comment.status} ${comment.body}`),
      ...document.suggestions.map((suggestion) => `${suggestion.id} ${suggestion.status} ${suggestion.summary} ${suggestion.rationale} ${suggestion.body}`),
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  /** One document by id or title. `versions` holds the newest version only; see {@link versions}. */
  public get(idOrTitle: string): AgentDocumentRecord | null {
    return this.find(idOrTitle)?.document ?? null;
  }

  /** The retained version history of one document, oldest first. */
  public versions(id: string): readonly AgentDocumentVersion[] {
    const rows = this.store.db.query('SELECT version FROM versions WHERE document_id = ? ORDER BY seq').all(id) as { version: string }[];
    return rows.map((row) => { try { return parseVersion(JSON.parse(row.version)); } catch { return null; } })
      .filter((version): version is AgentDocumentVersion => version !== null);
  }

  /** The document's write revision: it moves by one on every write to that document. */
  public revisionOf(id: string): number | undefined {
    const row = this.store.db.query('SELECT revision FROM documents WHERE id = ?').get(id) as { revision: number } | null;
    return row?.revision;
  }

  public create(input: AgentDocumentCreateInput): AgentDocumentRecord {
    return this.write(() => {
      const title = normalizeTitle(input.title);
      const body = input.body.trim();
      this.validateRequired(title, body);
      const tags = normalizeList(input.tags);
      const summary = input.summary?.trim() || 'Initial draft.';
      assertDocumentContentSafe([title, body, summary, ...tags]);
      const duplicate = this.find(title);
      if (duplicate) throw new Error(`Document already exists ${duplicate.document.id}`);
      const timestamp = nowIso();
      const version: AgentDocumentVersion = {
        id: 'v1',
        title,
        body,
        summary,
        createdAt: timestamp,
      };
      const document: AgentDocumentRecord = {
        id: this.nextId(title),
        title,
        body,
        tags,
        status: 'draft',
        createdAt: timestamp,
        updatedAt: timestamp,
        versions: [version],
        versionCount: 1,
        comments: [],
        suggestions: [],
        attachments: [],
      };
      this.save(document, 0, version);
      return document;
    });
  }

  public update(idOrTitle: string, input: AgentDocumentUpdateInput, options: AgentDocumentWriteOptions = {}): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle, options);
      const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
      const body = input.body === undefined ? existing.body : input.body.trim();
      this.validateRequired(title, body);
      const tags = input.tags === undefined ? existing.tags : normalizeList(input.tags);
      const summary = input.summary?.trim() || 'Updated draft.';
      assertDocumentContentSafe([title, body, summary, ...tags]);
      const duplicate = this.find(title);
      if (duplicate && duplicate.document.id !== existing.id) throw new Error(`Document already exists ${duplicate.document.id}`);
      const timestamp = nowIso();
      // A version records content; a change of status or artifact alone adds none,
      // so marking a document reviewed does not push its history out of the window.
      const contentChanged = title !== existing.title || body !== existing.body
        || tags.length !== existing.tags.length || tags.some((tag, index) => tag !== existing.tags[index]);
      const version: AgentDocumentVersion | undefined = contentChanged
        ? { id: nextVersionId(existing), title, body, summary, createdAt: timestamp }
        : undefined;
      const updated: AgentDocumentRecord = {
        ...existing,
        title,
        body,
        tags,
        status: input.status ?? existing.status,
        updatedAt: timestamp,
        ...(version ? { versions: [version], versionCount: Math.min(existing.versionCount + 1, MAX_VERSIONS) } : {}),
        lastArtifactId: input.lastArtifactId === undefined ? existing.lastArtifactId : input.lastArtifactId || undefined,
      };
      this.save(updated, revision, version);
      return updated;
    });
  }

  public updateArtifactId(idOrTitle: string, artifactId: string): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle);
      const updated: AgentDocumentRecord = {
        ...existing,
        lastArtifactId: artifactId,
        updatedAt: nowIso(),
      };
      this.save(updated, revision);
      return updated;
    });
  }

  public addComment(idOrTitle: string, input: AgentDocumentCommentInput): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle);
      const body = input.body.trim();
      if (!body) throw new Error('Comment body is required.');
      assertDocumentContentSafe([body]);
      const timestamp = nowIso();
      const comment: AgentDocumentComment = {
        id: this.nextCommentId(existing.comments),
        body,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const updated: AgentDocumentRecord = {
        ...existing,
        comments: [...existing.comments, comment],
        updatedAt: timestamp,
      };
      this.save(updated, revision);
      return updated;
    });
  }

  public resolveComment(idOrTitle: string, commentId: string): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle);
      const lookup = commentId.trim().toLowerCase();
      if (!lookup) throw new Error('commentId is required.');
      const target = existing.comments.find((comment) => comment.id.toLowerCase() === lookup);
      if (!target) throw new Error(`Unknown document comment ${commentId}`);
      const timestamp = nowIso();
      const updated: AgentDocumentRecord = {
        ...existing,
        updatedAt: timestamp,
        comments: existing.comments.map((comment) => comment.id === target.id
          ? { ...comment, status: 'resolved', updatedAt: timestamp, resolvedAt: timestamp }
          : comment),
      };
      this.save(updated, revision);
      return updated;
    });
  }

  public suggestUpdate(idOrTitle: string, input: AgentDocumentSuggestionInput): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle);
      const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
      const body = input.body.trim();
      this.validateRequired(title, body);
      const tags = input.tags === undefined ? existing.tags : normalizeList(input.tags);
      const summary = input.summary?.trim() || 'AI suggested revision.';
      const rationale = input.rationale?.trim() || 'No rationale provided.';
      assertDocumentContentSafe([title, body, summary, rationale, ...tags]);
      const timestamp = nowIso();
      const suggestion: AgentDocumentSuggestion = {
        id: this.nextSuggestionId(existing.suggestions),
        title,
        body,
        tags,
        baseVersionId: currentVersionId(existing),
        ...(input.status === undefined ? {} : { documentStatus: input.status }),
        summary,
        rationale,
        status: 'proposed',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const updated: AgentDocumentRecord = {
        ...existing,
        suggestions: [...existing.suggestions, suggestion],
        updatedAt: timestamp,
      };
      this.save(updated, revision);
      return updated;
    });
  }

  public acceptSuggestion(idOrTitle: string, suggestionId: string): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle);
      const target = this.findSuggestion(existing, suggestionId);
      if (!target) throw new Error(`Unknown document suggestion ${suggestionId}`);
      if (target.status === 'accepted') return existing;
      const move = agentDocumentSuggestionLifecycle.check(target.status, 'accepted');
      if (!move.ok) throw new Error(`Document suggestion ${target.id}: ${move.reason}.`);
      // A suggestion is a whole replacement written against one version; accepting it
      // over a later version would silently undo the edits made in between.
      const current = currentVersionId(existing);
      // A suggestion saved before it carried its base version is judged by time:
      // a version newer than the suggestion means the text moved on.
      const movedOn = target.baseVersionId
        ? target.baseVersionId !== current
        : Date.parse(existing.versions.at(-1)?.createdAt ?? '') > Date.parse(target.createdAt);
      if (movedOn) {
        throw new Error(`Document suggestion ${target.id} was proposed against ${target.baseVersionId ?? 'an earlier version'}, and ${existing.id} is now at ${current}; accepting it would undo the changes made since. Nothing changed. Propose the revision again against ${current} (mode:"suggest"), or reject ${target.id} (mode:"rejectSuggestion").`);
      }
      const timestamp = nowIso();
      const version: AgentDocumentVersion = {
        id: nextVersionId(existing),
        title: target.title,
        body: target.body,
        summary: target.summary,
        createdAt: timestamp,
      };
      const updated: AgentDocumentRecord = {
        ...existing,
        title: target.title,
        body: target.body,
        tags: [...target.tags],
        status: target.documentStatus ?? existing.status,
        updatedAt: timestamp,
        versions: [version],
        versionCount: Math.min(existing.versionCount + 1, MAX_VERSIONS),
        suggestions: existing.suggestions.map((suggestion) => suggestion.id === target.id
          ? { ...suggestion, status: 'accepted', updatedAt: timestamp, resolvedAt: timestamp }
          : suggestion),
      };
      this.save(updated, revision, version);
      return updated;
    });
  }

  public rejectSuggestion(idOrTitle: string, suggestionId: string): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle);
      const target = this.findSuggestion(existing, suggestionId);
      if (!target) throw new Error(`Unknown document suggestion ${suggestionId}`);
      if (target.status === 'rejected') return existing;
      const move = agentDocumentSuggestionLifecycle.check(target.status, 'rejected');
      if (!move.ok) throw new Error(`Document suggestion ${target.id}: ${move.reason}.`);
      const timestamp = nowIso();
      const updated: AgentDocumentRecord = {
        ...existing,
        updatedAt: timestamp,
        suggestions: existing.suggestions.map((suggestion) => suggestion.id === target.id
          ? { ...suggestion, status: 'rejected', updatedAt: timestamp, resolvedAt: timestamp }
          : suggestion),
      };
      this.save(updated, revision);
      return updated;
    });
  }

  public attachArtifact(idOrTitle: string, input: AgentDocumentAttachmentInput, options: AgentDocumentWriteOptions = {}): AgentDocumentRecord {
    return this.write(() => {
      const { document: existing, revision } = this.require(idOrTitle, options);
      const artifactId = input.artifactId.trim();
      if (!artifactId) throw new Error('artifactId is required.');
      const label = normalizeTitle(input.label?.trim() || input.filename?.trim() || artifactId);
      const note = input.note?.trim() || undefined;
      assertDocumentContentSafe([label, note ?? '']);
      const timestamp = nowIso();
      const duplicate = existing.attachments.find((attachment) => attachment.artifactId.toLowerCase() === artifactId.toLowerCase());
      const snapshot = {
        artifactId,
        label,
        ...(note ? { note } : {}),
        ...(input.filename?.trim() ? { filename: input.filename.trim() } : {}),
        ...(input.mimeType?.trim() ? { mimeType: input.mimeType.trim() } : {}),
        ...(input.kind?.trim() ? { kind: input.kind.trim() } : {}),
        ...(typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes)
          ? { sizeBytes: Math.max(0, Math.trunc(input.sizeBytes)) }
          : {}),
      };
      const attachment: AgentDocumentAttachment = duplicate
        ? { ...duplicate, ...snapshot, updatedAt: timestamp }
        : { id: this.nextAttachmentId(existing.attachments), ...snapshot, createdAt: timestamp, updatedAt: timestamp };
      const attachments = duplicate
        ? existing.attachments.map((entry) => entry.id === duplicate.id ? attachment : entry)
        : [...existing.attachments, attachment];
      const updated: AgentDocumentRecord = {
        ...existing,
        attachments,
        updatedAt: timestamp,
      };
      this.save(updated, revision);
      return updated;
    });
  }

  public markReviewed(idOrTitle: string): AgentDocumentRecord {
    return this.update(idOrTitle, { status: 'reviewed', summary: 'Marked reviewed.' });
  }

  public delete(idOrTitle: string): boolean {
    return this.write(() => {
      const found = this.find(idOrTitle);
      if (!found) return false;
      this.assertWriteCurrent?.();
      this.store.db.query('DELETE FROM versions WHERE document_id = ?').run(found.document.id);
      this.store.db.query('DELETE FROM documents WHERE id = ?').run(found.document.id);
      return true;
    });
  }

  /** One immediate transaction: a read-modify-write cannot interleave with another process's write. */
  private write<T>(update: () => T): T {
    return this.store.tx(update);
  }

  private find(idOrTitle: string): { readonly document: AgentDocumentRecord; readonly revision: number } | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    const row = this.store.db.query('SELECT record, revision FROM documents WHERE id_key = ?1 OR title_key = ?1 ORDER BY id_key = ?1 DESC LIMIT 1')
      .get(lookup) as { record: string; revision: number } | null;
    const document = row ? parseRow(row.record) : null;
    return row && document ? { document, revision: row.revision } : null;
  }

  private require(idOrTitle: string, options: AgentDocumentWriteOptions = {}): { readonly document: AgentDocumentRecord; readonly revision: number } {
    const found = this.find(idOrTitle);
    if (!found) throw new Error(`Unknown document ${idOrTitle}`);
    if (options.expectedRevision !== undefined && found.revision !== options.expectedRevision) {
      throw new Error(`Document ${found.document.id} changed while this call was working on it. Nothing changed. Read it again with mode:"show" and repeat the call.`);
    }
    return found;
  }

  /** Write one document row and, for a content change, its new version; older versions past the cap go. */
  private save(document: AgentDocumentRecord, revision: number, version?: AgentDocumentVersion): void {
    this.assertWriteCurrent?.();
    const db = this.store.db;
    db.query(`INSERT INTO documents (id, id_key, title_key, updated_at, revision, record) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (id) DO UPDATE SET title_key = excluded.title_key, updated_at = excluded.updated_at, revision = excluded.revision, record = excluded.record`)
      .run(document.id, document.id.toLowerCase(), document.title.toLowerCase(), document.updatedAt, revision + 1, JSON.stringify(storedRecord(document)));
    if (!version) return;
    const last = db.query('SELECT MAX(seq) AS seq FROM versions WHERE document_id = ?').get(document.id) as { seq: number | null };
    const seq = (last.seq ?? -1) + 1;
    db.query('INSERT INTO versions (document_id, seq, version) VALUES (?, ?, ?)').run(document.id, seq, JSON.stringify(version));
    db.query('DELETE FROM versions WHERE document_id = ? AND seq <= ?').run(document.id, seq - MAX_VERSIONS);
  }

  private validateRequired(title: string, body: string): void {
    if (!title) throw new Error('Document title is required.');
    if (!body) throw new Error('Document body is required.');
  }

  private nextId(title: string): string {
    const base = slugify(title);
    const taken = this.store.db.query('SELECT 1 FROM documents WHERE id = ?');
    if (!taken.get(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!taken.get(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document id.');
  }

  private nextCommentId(comments: readonly AgentDocumentComment[]): string {
    const existing = new Set(comments.map((comment) => comment.id));
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `c${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document comment id.');
  }

  private nextSuggestionId(suggestions: readonly AgentDocumentSuggestion[]): string {
    const existing = new Set(suggestions.map((suggestion) => suggestion.id));
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `s${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document suggestion id.');
  }

  private nextAttachmentId(attachments: readonly AgentDocumentAttachment[]): string {
    const existing = new Set(attachments.map((attachment) => attachment.id));
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `a${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document attachment id.');
  }

  private findSuggestion(document: AgentDocumentRecord, suggestionId: string): AgentDocumentSuggestion | null {
    const lookup = suggestionId.trim().toLowerCase();
    if (!lookup) throw new Error('suggestionId is required.');
    return document.suggestions.find((suggestion) => suggestion.id.toLowerCase() === lookup) ?? null;
  }

}
