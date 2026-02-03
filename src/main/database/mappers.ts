// ============================================================================
// DATABASE ROW MAPPERS - Shared utility functions for mapping database rows
// ============================================================================

import type { Session, SessionMessage, Tag, SessionTag, TagSuggestion, SuggestionFeedback, TagTemplate, TagEffect, TagSource, SuggestionStatus, SuggestionCategory, Collection, SmartCollection, ActivityLogEntry, Bookmark, Prompt, QuickNote, KnowledgeEntry, AppNotification, SavedSearch, SessionLink } from '../../shared/types/index.js';

// ============================================================================
// DATABASE ROW TYPES
// ============================================================================

/**
 * Raw database row type for sessions table
 */
export interface SessionRow {
  id: string;
  project_name: string | null;
  file_path: string | null;
  start_time: string | null;
  end_time: string | null;
  message_count: number | null;
  token_count: number | null;
  cost: number | null;
  status: string | null;
  tags: string | null;
  notes: string | null;
  favorite: number | null;
  archived: number | null;
  collection_id: number | null;
  summary: string | null;
  custom_title: string | null;
  rating: number | null;
  outcome: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  file_mtime: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Raw database row type for messages table
 */
export interface MessageRow {
  id: number;
  session_id: string;
  message_index: number;
  role: string;
  content: string;
  timestamp: string | null;
  token_count: number | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_result: string | null;
  created_at: string;
}

/**
 * Raw database row type for tags table
 */
export interface TagRow {
  id: number;
  name: string;
  color: string;
  parent_id: number | null;
  alias_of: number | null;
  effect: string | null;
  description: string | null;
  is_pinned: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
  // Optional joined field
  parent_name?: string;
}

/**
 * Raw database row type for session_tags table
 */
export interface SessionTagRow {
  id: number;
  session_id: string;
  tag_id: number;
  added_at: string;
  added_by: string;
}

/**
 * Raw database row type for tag_suggestions table
 */
export interface TagSuggestionRow {
  id: number;
  session_id: string;
  tag_name: string;
  confidence: number;
  category: string | null;
  reasoning: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

/**
 * Raw database row type for suggestion_feedback table
 */
export interface SuggestionFeedbackRow {
  id: number;
  tag_name: string;
  context_hash: string | null;
  accepted_count: number;
  rejected_count: number;
  last_feedback_at: string | null;
}

/**
 * Raw database row type for tag_templates table
 */
export interface TagTemplateRow {
  id: number;
  name: string;
  description: string | null;
  tag_ids: string; // JSON string of number[]
  is_system: number;
  created_at: string;
  updated_at: string;
}

/**
 * Raw database row type for recent_tags table
 */
export interface RecentTagRow {
  id: number;
  tag_id: number;
  used_at: string;
}

/**
 * Raw database row type for collections table
 */
export interface CollectionRow {
  id: number;
  name: string;
  color: string;
  icon: string;
  parent_id: number | null;
  sort_order: number;
  created_at: string;
}

/**
 * Raw database row type for smart_collections table
 */
export interface SmartCollectionRow {
  id: number;
  name: string;
  color: string;
  icon: string;
  rules: string;
  match_mode: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Raw database row type for activity_log table
 */
export interface ActivityLogRow {
  id: number;
  type: string;
  session_id: string | null;
  description: string;
  metadata: string | null;
  timestamp: string;
}

/**
 * Raw database row type for bookmarks table
 */
export interface BookmarkRow {
  id: number;
  session_id: string;
  message_index: number;
  label: string;
  color: string;
  created_at: string;
}

/**
 * Raw database row type for prompts table
 */
export interface PromptRow {
  id: number;
  title: string;
  content: string;
  category: string;
  use_count: number;
  last_used: string | null;
  created_at: string;
}

/**
 * Raw database row type for quick_notes table
 */
export interface QuickNoteRow {
  id: number;
  content: string;
  session_id: string | null;
  status: string;
  priority: string;
  project_name?: string;
  created_at: string;
}

/**
 * Raw database row type for knowledge_entries table
 */
export interface KnowledgeEntryRow {
  id: number;
  title: string;
  content: string;
  category: string | null;
  tags: string | null;
  source_session_id: string | null;
  view_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Raw database row type for notifications table
 */
export interface NotificationRow {
  id: number;
  type: string;
  title: string;
  message: string | null;
  priority: string;
  read: number;
  dismissed: number;
  session_id: string | null;
  created_at: string;
}

/**
 * Raw database row type for saved_searches table
 */
export interface SavedSearchRow {
  id: number;
  name: string;
  query: string;
  filters: string;
  created_at: string;
}

/**
 * Raw database row type for session_links table
 */
export interface SessionLinkRow {
  id: number;
  source_session_id: string;
  target_session_id: string;
  link_type: string;
  notes: string | null;
  source_project?: string;
  target_project?: string;
  created_at: string;
}

// ============================================================================
// MAPPER FUNCTIONS
// ============================================================================

/**
 * Maps a database row to a Session object
 * @param row - The raw database row from the sessions table
 * @returns A Session object with properly typed fields
 */
export function mapRowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectName: row.project_name,
    filePath: row.file_path,
    startTime: row.start_time,
    endTime: row.end_time,
    messageCount: row.message_count ?? 0,
    tokenCount: row.token_count ?? 0,
    cost: row.cost ?? 0,
    status: (row.status ?? 'unknown') as Session['status'],
    tags: row.tags,
    notes: row.notes,
    favorite: Boolean(row.favorite),
    archived: Boolean(row.archived),
    collectionId: row.collection_id,
    summary: row.summary,
    customTitle: row.custom_title,
    rating: row.rating,
    outcome: row.outcome as Session['outcome'],
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    fileMtime: row.file_mtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a database row to a SessionMessage object
 * @param row - The raw database row from the messages table
 * @returns A SessionMessage object with properly typed fields
 */
export function mapRowToMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageIndex: row.message_index,
    role: row.role as SessionMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    tokenCount: row.token_count ?? 0,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolResult: row.tool_result,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a Tag object
 * @param row - The raw database row from the tags table
 * @returns A Tag object with properly typed fields
 */
export function mapRowToTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    parentId: row.parent_id,
    aliasOf: row.alias_of,
    effect: row.effect as TagEffect | null,
    description: row.description,
    isPinned: Boolean(row.is_pinned),
    usageCount: row.usage_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a database row to a SessionTag object
 * @param row - The raw database row from the session_tags table
 * @returns A SessionTag object with properly typed fields
 */
export function mapRowToSessionTag(row: SessionTagRow): SessionTag {
  return {
    id: row.id,
    sessionId: row.session_id,
    tagId: row.tag_id,
    addedAt: row.added_at,
    addedBy: row.added_by as TagSource,
  };
}

/**
 * Maps a database row to a TagSuggestion object
 * @param row - The raw database row from the tag_suggestions table
 * @returns A TagSuggestion object with properly typed fields
 */
export function mapRowToTagSuggestion(row: TagSuggestionRow): TagSuggestion {
  return {
    id: row.id,
    sessionId: row.session_id,
    tagName: row.tag_name,
    confidence: row.confidence,
    category: row.category as SuggestionCategory | null,
    reasoning: row.reasoning,
    status: row.status as SuggestionStatus,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/**
 * Maps a database row to a SuggestionFeedback object
 * @param row - The raw database row from the suggestion_feedback table
 * @returns A SuggestionFeedback object with properly typed fields
 */
export function mapRowToSuggestionFeedback(row: SuggestionFeedbackRow): SuggestionFeedback {
  return {
    id: row.id,
    tagName: row.tag_name,
    contextHash: row.context_hash,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    lastFeedbackAt: row.last_feedback_at,
  };
}

/**
 * Maps a database row to a TagTemplate object
 * @param row - The raw database row from the tag_templates table
 * @returns A TagTemplate object with properly typed fields
 */
export function mapRowToTagTemplate(row: TagTemplateRow): TagTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tagIds: JSON.parse(row.tag_ids) as number[],
    isSystem: Boolean(row.is_system),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a database row to a Collection object
 * @param row - The raw database row from the collections table
 * @returns A Collection object with properly typed fields
 */
export function mapRowToCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a SmartCollection object
 * @param row - The raw database row from the smart_collections table
 * @returns A SmartCollection object with properly typed fields
 */
export function mapRowToSmartCollection(row: SmartCollectionRow): SmartCollection {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    rules: JSON.parse(row.rules ?? '[]'),
    matchMode: (row.match_mode ?? 'all') as SmartCollection['matchMode'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a database row to an ActivityLogEntry object
 * @param row - The raw database row from the activity_log table
 * @returns An ActivityLogEntry object with properly typed fields
 */
export function mapRowToActivity(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    type: row.type,
    sessionId: row.session_id,
    description: row.description,
    metadata: row.metadata,
    timestamp: row.timestamp,
  };
}

/**
 * Maps a database row to a Bookmark object
 * @param row - The raw database row from the bookmarks table
 * @returns A Bookmark object with properly typed fields
 */
export function mapRowToBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageIndex: row.message_index,
    label: row.label,
    color: row.color,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a Prompt object
 * @param row - The raw database row from the prompts table
 * @returns A Prompt object with properly typed fields
 */
export function mapRowToPrompt(row: PromptRow): Prompt {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    useCount: row.use_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a QuickNote object
 * @param row - The raw database row from the quick_notes table
 * @returns A QuickNote object with properly typed fields
 */
export function mapRowToQuickNote(row: QuickNoteRow): QuickNote {
  return {
    id: row.id,
    content: row.content,
    sessionId: row.session_id,
    status: row.status as QuickNote['status'],
    priority: row.priority as QuickNote['priority'],
    projectName: row.project_name,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a KnowledgeEntry object
 * @param row - The raw database row from the knowledge_entries table
 * @returns A KnowledgeEntry object with properly typed fields
 */
export function mapRowToKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags,
    sourceSessionId: row.source_session_id,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a database row to an AppNotification object
 * @param row - The raw database row from the notifications table
 * @returns An AppNotification object with properly typed fields
 */
export function mapRowToNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type as AppNotification['type'],
    title: row.title,
    message: row.message,
    priority: row.priority as AppNotification['priority'],
    read: Boolean(row.read),
    dismissed: Boolean(row.dismissed),
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a SavedSearch object
 * @param row - The raw database row from the saved_searches table
 * @returns A SavedSearch object with properly typed fields
 */
export function mapRowToSavedSearch(row: SavedSearchRow): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    filters: row.filters,
    createdAt: row.created_at,
  };
}

/**
 * Maps a database row to a SessionLink object
 * @param row - The raw database row from the session_links table
 * @returns A SessionLink object with properly typed fields
 */
export function mapRowToSessionLink(row: SessionLinkRow): SessionLink {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    linkType: row.link_type as SessionLink['linkType'],
    notes: row.notes,
    sourceProject: row.source_project,
    targetProject: row.target_project,
    createdAt: row.created_at,
  };
}
