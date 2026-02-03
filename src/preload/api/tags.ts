// ============================================================================
// TAGS PRELOAD API - Exposed tag operations for renderer process
// ============================================================================

import { ipcRenderer } from 'electron';
import type { 
  Tag, 
  TagSuggestion, 
  TagTemplate,
  CreateTagInput, 
  UpdateTagInput,
  TagFilterExpression,
  ScanProgress,
  ScanStatusInfo,
  ScanCostEstimate,
} from '../../shared/types/index.js';
import type { IPCResult } from '../../shared/types/index.js';

export const tagsApi = {
  // ============================================================================
  // TAG CRUD
  // ============================================================================
  
  getAllTags: (): Promise<IPCResult<Tag[]>> => 
    ipcRenderer.invoke('get-all-tags'),
  
  getTag: (id: number): Promise<IPCResult<Tag | null>> => 
    ipcRenderer.invoke('get-tag', id),
  
  getTagByName: (name: string): Promise<IPCResult<Tag | null>> => 
    ipcRenderer.invoke('get-tag-by-name', name),
  
  createTag: (input: CreateTagInput): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('create-tag', input),
  
  updateTag: (id: number, input: UpdateTagInput): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('update-tag', id, input),
  
  deleteTag: (id: number, reassignTo?: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('delete-tag', id, reassignTo),
  
  mergeTags: (sourceId: number, targetId: number): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('merge-tags', { sourceId, targetId }),

  // ============================================================================
  // TAG PROPERTIES
  // ============================================================================
  
  toggleTagPinned: (id: number): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('toggle-tag-pinned', id),
  
  setTagColor: (id: number, color: string): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('set-tag-color', id, color),
  
  setTagEffect: (id: number, effect: string | null): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('set-tag-effect', id, effect),
  
  createTagAlias: (aliasName: string, canonicalId: number): Promise<IPCResult<Tag>> => 
    ipcRenderer.invoke('create-tag-alias', aliasName, canonicalId),
  
  getTagChildren: (parentId: number): Promise<IPCResult<Tag[]>> => 
    ipcRenderer.invoke('get-tag-children', parentId),
  
  getTagAliases: (tagId: number): Promise<IPCResult<Tag[]>> => 
    ipcRenderer.invoke('get-tag-aliases', tagId),

  // ============================================================================
  // SESSION-TAG ASSOCIATIONS
  // ============================================================================
  
  addTagToSession: (sessionId: string, tagId: number, source?: string): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('add-tag-to-session', { sessionId, tagId, source }),
  
  removeTagFromSession: (sessionId: string, tagId: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('remove-tag-from-session', sessionId, tagId),
  
  getSessionTags: (sessionId: string): Promise<IPCResult<Tag[]>> => 
    ipcRenderer.invoke('get-session-tags', sessionId),
  
  clearSessionTags: (sessionId: string): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('clear-session-tags', sessionId),

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================
  
  addTagToSessions: (sessionIds: string[], tagId: number, source?: string): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('add-tag-to-sessions', { sessionIds, tagId, source }),
  
  removeTagFromSessions: (sessionIds: string[], tagId: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('remove-tag-from-sessions', sessionIds, tagId),

  // ============================================================================
  // RECENT/PINNED
  // ============================================================================
  
  getRecentTags: (limit?: number): Promise<IPCResult<Tag[]>> => 
    ipcRenderer.invoke('get-recent-tags', limit),
  
  getPinnedTags: (): Promise<IPCResult<Tag[]>> => 
    ipcRenderer.invoke('get-pinned-tags'),
  
  recordTagUsage: (tagId: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('record-tag-usage', tagId),

  // ============================================================================
  // TAG TEMPLATES
  // ============================================================================
  
  getAllTagTemplates: (): Promise<IPCResult<TagTemplate[]>> => 
    ipcRenderer.invoke('get-all-tag-templates'),
  
  getTagTemplate: (id: number): Promise<IPCResult<TagTemplate | null>> => 
    ipcRenderer.invoke('get-tag-template', id),
  
  createTagTemplate: (input: { name: string; description?: string; tagIds: number[] }): Promise<IPCResult<TagTemplate>> => 
    ipcRenderer.invoke('create-tag-template', input),
  
  updateTagTemplate: (id: number, input: { name?: string; description?: string | null; tagIds?: number[] }): Promise<IPCResult<TagTemplate>> => 
    ipcRenderer.invoke('update-tag-template', id, input),
  
  deleteTagTemplate: (id: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('delete-tag-template', id),
  
  applyTagTemplate: (sessionId: string, templateId: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('apply-tag-template', sessionId, templateId),

  // ============================================================================
  // AI SUGGESTIONS - SUGGESTION MANAGEMENT
  // ============================================================================
  
  getSessionSuggestions: (sessionId: string): Promise<IPCResult<TagSuggestion[]>> => 
    ipcRenderer.invoke('get-session-suggestions', sessionId),
  
  getSuggestion: (id: number): Promise<IPCResult<TagSuggestion | null>> => 
    ipcRenderer.invoke('get-suggestion', id),
  
  acceptSuggestion: (id: number): Promise<IPCResult<{ suggestion: TagSuggestion; tag: Tag }>> => 
    ipcRenderer.invoke('accept-suggestion', id),
  
  rejectSuggestion: (id: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('reject-suggestion', id),
  
  dismissSuggestion: (id: number): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('dismiss-suggestion', id),
  
  acceptAllSuggestions: (sessionId: string): Promise<IPCResult<number>> => 
    ipcRenderer.invoke('accept-all-suggestions', sessionId),
  
  dismissAllSuggestions: (sessionId: string): Promise<IPCResult<number>> => 
    ipcRenderer.invoke('dismiss-all-suggestions', sessionId),

  // ============================================================================
  // AI SUGGESTIONS - SCAN MANAGEMENT
  // ============================================================================
  
  getScanCounts: (): Promise<IPCResult<{ pending: number; completed: number; failed: number }>> => 
    ipcRenderer.invoke('get-scan-counts'),
  
  getSessionScanStatus: (sessionId: string): Promise<IPCResult<ScanStatusInfo | null>> => 
    ipcRenderer.invoke('get-session-scan-status', sessionId),
  
  getPendingSessions: (limit?: number): Promise<IPCResult<string[]>> => 
    ipcRenderer.invoke('get-pending-sessions', limit),

  // ============================================================================
  // AI SUGGESTIONS - SCAN CONTROL (Phase 5)
  // ============================================================================
  
  startBackgroundScan: (): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('start-background-scan'),
  
  stopBackgroundScan: (): Promise<IPCResult<void>> => 
    ipcRenderer.invoke('stop-background-scan'),
  
  getScanProgress: (): Promise<IPCResult<ScanProgress>> => 
    ipcRenderer.invoke('get-scan-progress'),
  
  estimateScanCost: (): Promise<IPCResult<ScanCostEstimate>> => 
    ipcRenderer.invoke('estimate-scan-cost'),
};
