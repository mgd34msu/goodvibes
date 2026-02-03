// ==================================================================================
// TAG SUGGESTION CONTEXT GATHERER - Extract session context for AI analysis
// ==================================================================================
/**
 * Collects and formats session context for AI tag suggestion analysis.
 * Provides both quick scan (minimal context) and full scan (comprehensive).
 */

import { getSession } from '../database/sessions';
import { getSessionMessages } from '../database/messages';
import { getSessionTags } from '../database/tags';
import type { Session, SessionMessage } from '../../shared/types/session-types';
import type { Tag } from '../../shared/types/tag-types.js';

// ==================================================================================
// TYPES
// ==================================================================================

/**
 * Session context for tag suggestion analysis
 */
export interface SessionContext {
  /** Session ID */
  sessionId: string;
  
  /** Project name (extracted from path) */
  projectName: string | null;
  
  /** Session summary (if available) */
  summary: string | null;
  
  /** User messages (truncated) */
  userMessages: string[];
  
  /** Assistant messages (truncated) */
  assistantMessages: string[];
  
  /** Tools used in session */
  toolsUsed: string[];
  
  /** Total token count */
  totalTokens: number;
  
  /** Session duration in minutes */
  duration: number;
  
  /** Session outcome */
  outcome: string | null;
  
  /** Existing tags */
  existingTags: string[];
}

// ==================================================================================
// CONSTANTS
// ==================================================================================

/** Max characters per message (quick scan) */
const QUICK_MESSAGE_MAX_LENGTH = 300;

/** Max characters per message (full scan) */
const FULL_MESSAGE_MAX_LENGTH = 500;

/** Max user messages to include (quick scan) */
const QUICK_MAX_USER_MESSAGES = 6; // First 3 + last 3

/** Max user messages to include (full scan) */
const FULL_MAX_USER_MESSAGES = 20;

/** Max assistant messages to include (full scan) */
const FULL_MAX_ASSISTANT_MESSAGES = 10;

/** Approximate tokens per character */
const TOKENS_PER_CHAR = 0.25;

// ==================================================================================
// HELPER FUNCTIONS
// ==================================================================================

/**
 * Truncate text to max length with ellipsis
 * @param text Text to truncate
 * @param maxLength Maximum length
 * @returns Truncated text
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Extract project name from file path
 * @param filePath Full file path
 * @returns Project name or null
 */
function extractProjectName(filePath: string | null): string | null {
  if (!filePath) {
    return null;
  }
  
  // Extract last directory name before filename
  // Example: /home/user/Projects/my-project/.goodvibes/sessions/xxx.jsonl
  // Should extract: "my-project"
  const parts = filePath.split('/');
  
  // Find .goodvibes index
  const goodvibesIndex = parts.findIndex(p => p === '.goodvibes');
  
  if (goodvibesIndex > 0) {
    // Project name is the directory before .goodvibes
    return parts[goodvibesIndex - 1] || null;
  }
  
  // Fallback: return the last non-empty directory name
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] && parts[i] !== '.' && parts[i] !== '..') {
      return parts[i];
    }
  }
  
  return null;
}

/**
 * Estimate token count (~4.2 characters per token)
 * @param text Text to estimate
 * @returns Estimated token count
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Calculate session duration in minutes
 * @param session Session object
 * @returns Duration in minutes
 */
function calculateDuration(session: Session): number {
  if (!session.startTime || !session.endTime) {
    return 0;
  }
  
  const start = new Date(session.startTime).getTime();
  const end = new Date(session.endTime).getTime();
  
  return Math.round((end - start) / 1000 / 60);
}

/**
 * Extract unique tools from messages
 * @param messages Session messages
 * @returns Array of unique tool names
 */
function extractTools(messages: SessionMessage[]): string[] {
  const tools = new Set<string>();
  
  for (const message of messages) {
    if (message.toolName) {
      tools.add(message.toolName);
    }
  }
  
  return Array.from(tools).sort();
}

/**
 * Filter and truncate messages by role
 * @param messages All session messages
 * @param role Message role to filter
 * @param maxCount Maximum number of messages
 * @param maxLength Maximum length per message
 * @param includeFirstLast Include first and last messages
 * @returns Filtered and truncated messages
 */
function filterMessages(
  messages: SessionMessage[],
  role: string,
  maxCount: number,
  maxLength: number,
  includeFirstLast: boolean = false
): string[] {
  const filtered = messages.filter(m => m.role === role);
  
  if (filtered.length === 0) {
    return [];
  }
  
  let selected: SessionMessage[];
  
  if (includeFirstLast && filtered.length > maxCount) {
    // Include first half and last half
    const half = Math.floor(maxCount / 2);
    const first = filtered.slice(0, half);
    const last = filtered.slice(-half);
    selected = [...first, ...last];
  } else {
    // Take first n messages
    selected = filtered.slice(0, maxCount);
  }
  
  return selected.map(m => truncateText(m.content, maxLength));
}

/**
 * Filter key assistant messages (decisions, conclusions)
 * @param messages All session messages
 * @param maxCount Maximum number of messages
 * @param maxLength Maximum length per message
 * @returns Key assistant messages
 */
function filterKeyAssistantMessages(
  messages: SessionMessage[],
  maxCount: number,
  maxLength: number
): string[] {
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  
  if (assistantMessages.length === 0) {
    return [];
  }
  
  // Keywords that indicate important messages
  const keyKeywords = [
    'complete', 'finish', 'success', 'done',
    'error', 'fail', 'issue', 'problem',
    'decide', 'choose', 'select',
    'create', 'build', 'implement',
    'important', 'note', 'critical'
  ];
  
  // Score messages based on keywords
  const scored = assistantMessages.map(m => {
    const contentLower = m.content.toLowerCase();
    const score = keyKeywords.filter(k => contentLower.includes(k)).length;
    return { message: m, score };
  });
  
  // Sort by score (descending) and take top messages
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, maxCount).map(s => s.message);
  
  return selected.map(m => truncateText(m.content, maxLength));
}

// ==================================================================================
// MAIN FUNCTIONS
// ==================================================================================

/**
 * Gather quick context for fast tag suggestion
 * Includes: first/last messages, summary, basic metadata
 * 
 * @param sessionId Session ID
 * @returns Quick context object
 */
export function gatherQuickContext(sessionId: string): SessionContext | null {
  try {
    // Get session metadata
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    
    // Get messages
    const messages = getSessionMessages(sessionId);
    
    // Get existing tags
    const tags = getSessionTags(sessionId);
    
    // Extract context
    const userMessages = filterMessages(
      messages,
      'user',
      QUICK_MAX_USER_MESSAGES,
      QUICK_MESSAGE_MAX_LENGTH,
      true // Include first and last
    );
    
    return {
      sessionId,
      projectName: extractProjectName(session.filePath),
      summary: session.summary,
      userMessages,
      assistantMessages: [], // Not included in quick scan
      toolsUsed: extractTools(messages),
      totalTokens: session.tokenCount,
      duration: calculateDuration(session),
      outcome: session.outcome,
      existingTags: tags.map(t => t.name),
    };
  } catch (error) {
    console.error(`Failed to gather quick context for session ${sessionId}:`, error);
    return null;
  }
}

/**
 * Gather full context for comprehensive tag suggestion
 * Includes: all messages, tools, key assistant responses
 * 
 * @param sessionId Session ID
 * @returns Full context object
 */
export function gatherFullContext(sessionId: string): SessionContext | null {
  try {
    // Get session metadata
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    
    // Get messages
    const messages = getSessionMessages(sessionId);
    
    // Get existing tags
    const tags = getSessionTags(sessionId);
    
    // Extract context
    const userMessages = filterMessages(
      messages,
      'user',
      FULL_MAX_USER_MESSAGES,
      FULL_MESSAGE_MAX_LENGTH,
      false
    );
    
    const assistantMessages = filterKeyAssistantMessages(
      messages,
      FULL_MAX_ASSISTANT_MESSAGES,
      FULL_MESSAGE_MAX_LENGTH
    );
    
    return {
      sessionId,
      projectName: extractProjectName(session.filePath),
      summary: session.summary,
      userMessages,
      assistantMessages,
      toolsUsed: extractTools(messages),
      totalTokens: session.tokenCount,
      duration: calculateDuration(session),
      outcome: session.outcome,
      existingTags: tags.map(t => t.name),
    };
  } catch (error) {
    console.error(`Failed to gather full context for session ${sessionId}:`, error);
    return null;
  }
}

/**
 * Format session context for AI prompt
 * 
 * @param context Session context
 * @returns Formatted prompt text
 */
export function formatContextForPrompt(context: SessionContext): string {
  const sections: string[] = [];
  
  // Project info
  if (context.projectName) {
    sections.push(`Project: ${context.projectName}`);
  }
  
  // Summary
  if (context.summary) {
    sections.push(`Summary: ${context.summary}`);
  }
  
  // Metadata
  const metadataParts: string[] = [];
  if (context.duration > 0) {
    metadataParts.push(`${context.duration} minutes`);
  }
  if (context.totalTokens > 0) {
    metadataParts.push(`${context.totalTokens} tokens`);
  }
  if (context.outcome) {
    metadataParts.push(`outcome: ${context.outcome}`);
  }
  if (metadataParts.length > 0) {
    sections.push(`Metadata: ${metadataParts.join(', ')}`);
  }
  
  // Tools used
  if (context.toolsUsed.length > 0) {
    sections.push(`Tools: ${context.toolsUsed.join(', ')}`);
  }
  
  // User messages
  if (context.userMessages.length > 0) {
    sections.push(`\nUser Messages:`);
    for (const [index, msg] of context.userMessages.entries()) {
      sections.push(`${index + 1}. ${msg}`);
    }
  }
  
  // Assistant messages
  if (context.assistantMessages.length > 0) {
    sections.push(`\nKey Assistant Responses:`);
    for (const [index, msg] of context.assistantMessages.entries()) {
      sections.push(`${index + 1}. ${msg}`);
    }
  }
  
  // Existing tags
  if (context.existingTags.length > 0) {
    sections.push(`\nExisting Tags: ${context.existingTags.join(', ')}`);
  }
  
  return sections.join('\n');
}
