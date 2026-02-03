// ============================================================================
// TAG SYSTEM TYPES - Comprehensive type definitions for the tag system
// ============================================================================

// ============================================================================
// Enums and Union Types
// ============================================================================

/**
 * Visual effects that can be applied to tags
 */
export type TagEffect = 'shimmer' | 'glow' | 'pulse';

/**
 * Source of tag application (how the tag was added to a session)
 */
export type TagSource = 'user' | 'ai' | 'bulk' | 'template';

/**
 * Categories for AI-suggested tags
 */
export type SuggestionCategory =
  | 'task_type'
  | 'technology'
  | 'domain'
  | 'complexity'
  | 'outcome'
  | 'pattern';

/**
 * Status of an AI tag suggestion
 */
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'dismissed';

/**
 * Status of AI scan process
 */
export type ScanStatus = 'pending' | 'queued' | 'scanning' | 'completed' | 'skipped' | 'failed';

// ============================================================================
// Core Tag Entities
// ============================================================================

/**
 * Main Tag entity representing a tag in the system
 */
export interface Tag {
  id: number;
  name: string;
  color: string;
  effect: TagEffect | null;
  parentId: number | null;
  aliasOf: number | null;
  description: string | null;
  isPinned: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Association between a session and a tag
 */
export interface SessionTag {
  id: number;
  sessionId: string;
  tagId: number;
  addedAt: string;
  addedBy: TagSource;
}

/**
 * AI-generated tag suggestion for a session
 */
export interface TagSuggestion {
  id: number;
  sessionId: string;
  tagName: string;
  confidence: number;
  category: SuggestionCategory | null;
  reasoning: string | null;
  status: SuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
}

/**
 * Feedback data for AI learning (tracks acceptance/rejection patterns)
 */
export interface SuggestionFeedback {
  id: number;
  tagName: string;
  contextHash: string | null;
  acceptedCount: number;
  rejectedCount: number;
  lastFeedbackAt: string | null;
}

/**
 * Tag template/preset for applying multiple tags at once
 */
export interface TagTemplate {
  id: number;
  name: string;
  description: string | null;
  tagIds: number[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Input/Output Types for CRUD Operations
// ============================================================================

/**
 * Input for creating a new tag
 */
export interface CreateTagInput {
  name: string;
  color?: string;
  effect?: TagEffect;
  parentId?: number;
  description?: string;
}

/**
 * Input for updating an existing tag
 */
export interface UpdateTagInput {
  name?: string;
  color?: string | null;
  effect?: TagEffect | null;
  parentId?: number | null;
  description?: string | null;
}

// ============================================================================
// Advanced Filtering
// ============================================================================

/**
 * Filter expression for advanced tag-based filtering
 * Supports boolean logic (AND, OR, NOT) for complex queries
 */
export interface TagFilterExpression {
  type: 'tag' | 'and' | 'or' | 'not';
  tagId?: number;
  children?: TagFilterExpression[];
}

// ============================================================================
// AI Scanning and Progress
// ============================================================================

/**
 * Real-time progress information for AI scan operations
 */
export interface ScanProgress {
  current: number;
  total: number;
  percentage: number;
  estimatedTimeMs: number;
  currentSessionId?: string;
}

/**
 * Detailed status information for the AI scan system
 */
export interface ScanStatusInfo {
  isRunning: boolean;
  isPaused: boolean;
  totalSessions: number;
  scannedSessions: number;
  pendingSessions: number;
  currentSessionId: string | null;
  estimatedTimeRemaining: number | null;
  lastError: string | null;
}

/**
 * Cost and time estimate for scanning all sessions
 */
export interface ScanCostEstimate {
  totalSessions: number;
  estimatedTokens: number;
  estimatedCost: number;
  estimatedTimeMinutes: number;
}

// ============================================================================
// Analytics and Statistics
// ============================================================================

/**
 * Comprehensive tag usage statistics for analytics
 */
export interface TagStatistics {
  totalTags: number;
  totalApplications: number;
  tagsCreatedThisWeek: number;
  tagsCreatedThisMonth: number;
  mostUsedTags: Array<{ tag: Tag; count: number }>;
  leastUsedTags: Array<{ tag: Tag; count: number }>;
  orphanedTags: Tag[];
  sessionsWithTags: number;
  sessionsWithoutTags: number;
  averageTagsPerSession: number;
}
