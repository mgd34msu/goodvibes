// ============================================================================
// SESSION MANAGER - FILE PARSER
// ============================================================================

import fs from 'fs/promises';
import crypto from 'crypto';
import { Logger } from '../logger.js';
import type { SessionMessage } from '../../../shared/types/index.js';
import type { TokenStats, ParsedSessionData, DetailedToolUsage } from './types.js';
import { resolveToolNames } from '../../../shared/toolParser.js';

const logger = new Logger('SessionParser');

// ============================================================================
// TYPE GUARDS FOR PARSED JSON
// ============================================================================

/**
 * Type guard to check if a value is a non-null object
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely get a string property from an unknown object
 */
function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Safely get a number property from an unknown object
 */
function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Safely get an object property from an unknown object
 */
function getObject(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  return isObject(value) ? value : undefined;
}

// ============================================================================
// HELPER FUNCTIONS FOR DEDUPLICATION
// ============================================================================

/**
 * Compute a hash for deduplication based on messageId and requestId
 */
function computeEntryHash(messageId: string | null, requestId: string | null): string {
  const parts = [messageId || '', requestId || ''];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Extract message ID from a session entry
 */
function extractMessageId(entry: unknown): string | null {
  if (!isObject(entry)) return null;
  
  // Check entry.message?.id
  const message = getObject(entry, 'message');
  if (message) {
    const messageId = getString(message, 'id');
    if (messageId) return messageId;
  }
  
  // Check entry.id
  const entryId = getString(entry, 'id');
  if (entryId) return entryId;
  
  return null;
}

/**
 * Extract request ID from a session entry
 */
function extractRequestId(entry: unknown): string | null {
  if (!isObject(entry)) return null;
  
  // Check entry.requestId
  const requestId = getString(entry, 'requestId');
  if (requestId) return requestId;
  
  // Check entry.request_id
  const requestIdSnake = getString(entry, 'request_id');
  if (requestIdSnake) return requestIdSnake;
  
  return null;
}

// ============================================================================
// SESSION FILE PARSING
// ============================================================================

/**
 * Parse a session file and extract messages, token stats, cost, and tool usage
 */
export async function parseSessionFileWithStats(filePath: string): Promise<ParsedSessionData> {
  const messages: Partial<SessionMessage>[] = [];
  let tokenStats: TokenStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  let costUSD = 0;
  let model: string | null = null;
  const toolUsage = new Map<string, number>();
  const detailedToolUsage: Omit<DetailedToolUsage, 'sessionId'>[] = [];
  const seenHashes = new Set<string>();

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Parse messages line by line
    const lines = content.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const parsed = parseEntry(entry);
        if (parsed) {
          messages.push(parsed);
        }

        // Extract tool usage from tool_use entries
        extractToolUsage(entry, toolUsage);

        // Extract detailed tool usage with deduplication
        extractDetailedToolUsage(entry, detailedToolUsage, seenHashes);
      } catch (error) {
        logger.debug('Skipped malformed JSON line in session file', {
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Compute aggregated token stats from detailed tool usage (deduplicated)
    const uniqueEntries = detailedToolUsage.filter((entry, idx) => {
      // Only count entries with unique hashes for token totals
      const firstIdx = detailedToolUsage.findIndex(e => e.entryHash === entry.entryHash);
      return firstIdx === idx;
    });

    tokenStats = uniqueEntries.reduce(
      (acc, entry) => ({
        inputTokens: acc.inputTokens + entry.inputTokens,
        outputTokens: acc.outputTokens + entry.outputTokens,
        cacheWriteTokens: acc.cacheWriteTokens + entry.cacheWriteTokens,
        cacheReadTokens: acc.cacheReadTokens + entry.cacheReadTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
    );

    // Compute aggregated cost from unique entries
    costUSD = uniqueEntries.reduce((acc, entry) => acc + entry.costUsd, 0);

    // Extract model from first entry with model data
    const entryWithModel = detailedToolUsage.find(e => e.model);
    if (entryWithModel) {
      model = entryWithModel.model;
    }
  } catch (error) {
    logger.error(`Failed to parse session file: ${filePath}`, error);
  }

  return { messages, tokenStats, costUSD, model, toolUsage, detailedToolUsage };
}

/**
 * Parse a single entry from a session file
 */
export function parseEntry(entry: unknown): Partial<SessionMessage> | null {
  if (!isObject(entry)) return null;

  let role: SessionMessage['role'] = 'unknown';
  const entryRole = getString(entry, 'type') || getString(entry, 'role');
  if (entryRole === 'user' || entryRole === 'assistant' || entryRole === 'system' ||
      entryRole === 'tool' || entryRole === 'tool_result' || entryRole === 'thinking') {
    role = entryRole;
  }
  let content = '';
  let tokenCount = 0;

  // Extract token count from usage data
  const usage = getObject(entry, 'usage');
  if (usage) {
    tokenCount = (getNumber(usage, 'input_tokens') ?? 0) + (getNumber(usage, 'output_tokens') ?? 0);
  }

  const entryType = getString(entry, 'type');
  const thinking = entry['thinking'];
  const toolUse = getObject(entry, 'tool_use');
  const toolResult = getObject(entry, 'tool_result');
  const message = entry['message'];
  const entryContent = entry['content'];

  // Handle different entry types
  if (entryType === 'thinking' || thinking !== undefined) {
    role = 'thinking';
    content = typeof thinking === 'string' ? thinking : (typeof entryContent === 'string' ? entryContent : '');
  } else if (entryType === 'tool_use' || toolUse) {
    role = 'tool';
    const tool = toolUse || entry;
    const toolName = isObject(tool) ? getString(tool, 'name') : undefined;
    const toolInput = isObject(tool) ? tool['input'] : undefined;
    content = `[Tool: ${toolName || 'unknown'}]\n${JSON.stringify(toolInput || {}, null, 2)}`;
  } else if (entryType === 'tool_result' || toolResult) {
    role = 'tool_result';
    const result = toolResult || entry;
    const resultContent = isObject(result) ? result['content'] : undefined;
    content = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent || result, null, 2);
  } else if (message !== undefined) {
    content = extractContent(message);
  } else if (entryContent !== undefined) {
    content = typeof entryContent === 'string' ? entryContent : JSON.stringify(entryContent);
  }

  if (!content.trim()) return null;

  return {
    role,
    content,
    timestamp: getString(entry, 'timestamp'),
    tokenCount,
  };
}

/**
 * Extract content from a message
 */
export function extractContent(message: unknown): string {
  if (typeof message === 'string') return message;

  if (Array.isArray(message)) {
    return message
      .map((block: unknown) => {
        if (typeof block === 'string') return block;
        if (isObject(block) && getString(block, 'type') === 'text') {
          return getString(block, 'text') || '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (isObject(message)) {
    const content = message['content'];
    if (content !== undefined) return extractContent(content);
    const text = getString(message, 'text');
    if (text) return text;
  }

  return '';
}

/**
 * Extract detailed tool usage from a session entry
 */
function extractDetailedToolUsage(
  entry: unknown,
  detailedToolUsage: Omit<DetailedToolUsage, 'sessionId'>[],
  seenHashes: Set<string>
): void {
  if (!isObject(entry)) return;

  // Extract IDs for deduplication
  const messageId = extractMessageId(entry);
  const requestId = extractRequestId(entry);
  const entryHash = computeEntryHash(messageId, requestId);

  // Extract usage data
  const usage = getObject(entry, 'usage');
  if (!usage) return;

  const inputTokens = getNumber(usage, 'input_tokens') ?? 0;
  const outputTokens = getNumber(usage, 'output_tokens') ?? 0;
  const cacheWriteTokens = getNumber(usage, 'cache_creation_input_tokens') ?? 0;
  const cacheReadTokens = getNumber(usage, 'cache_read_input_tokens') ?? 0;
  const tokenCost = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
  const costUsd = getNumber(entry, 'costUSD') ?? 0;

  // Extract model and timestamp
  const model = getString(entry, 'model') ?? null;
  const timestamp = getString(entry, 'timestamp') ?? null;

  // Extract tool information from message content
  const message = getObject(entry, 'message');
  const messageContent = message ? message['content'] : undefined;

  if (messageContent && Array.isArray(messageContent)) {
    let toolIndex = 0;
    for (const block of messageContent) {
      if (isObject(block) && getString(block, 'type') === 'tool_use') {
        const toolName = getString(block, 'name');
        if (!toolName) continue;

        const toolInput = block['input'];
        const toolInputStr = toolInput ? JSON.stringify(toolInput) : null;

        // Try to find corresponding tool_result
        const toolId = getString(block, 'id');
        let success = true;
        let toolResultPreview: string | null = null;

        // Look for tool_result in subsequent lines (approximate)
        // For now, assume success unless we have error indicators
        if (messageContent) {
          for (const resultBlock of messageContent) {
            if (
              isObject(resultBlock) &&
              getString(resultBlock, 'type') === 'tool_result' &&
              getString(resultBlock, 'tool_use_id') === toolId
            ) {
              const resultContent = resultBlock['content'];
              if (typeof resultContent === 'string') {
                toolResultPreview = resultContent.substring(0, 500);
                success = !getString(resultBlock, 'is_error');
              }
            }
          }
        }

        detailedToolUsage.push({
          toolName,
          toolInput: toolInputStr,
          toolResultPreview,
          success,
          durationMs: null, // Not available in session data
          inputTokens,
          outputTokens,
          cacheWriteTokens,
          cacheReadTokens,
          tokenCost,
          costUsd,
          messageId,
          requestId,
          entryHash,
          toolIndex,
          model,
          timestamp,
        });

        toolIndex++;
      }
    }
  }
}

/**
 * Extract tool usage from a session entry and update the toolUsage map
 */
export function extractToolUsage(entry: unknown, toolUsage: Map<string, number>): void {
  if (!isObject(entry)) return;

  const entryType = getString(entry, 'type');
  const toolUse = getObject(entry, 'tool_use');

  // Check for direct tool_use entry
  if (entryType === 'tool_use' || toolUse) {
    const tool = toolUse || entry;
    const toolName = isObject(tool) ? getString(tool, 'name') : undefined;
    const toolInput = isObject(tool) ? tool['input'] : undefined;

    if (toolName) {
      const inputObj = isObject(toolInput) ? toolInput : null;
      const resolvedNames = resolveToolNames(toolName, inputObj);
      for (const name of resolvedNames) {
        toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
      }
    }
  }

  // Check for tool_use in message.content array
  const message = getObject(entry, 'message');
  const messageContent = message ? message['content'] : undefined;
  if (messageContent && Array.isArray(messageContent)) {
    for (const block of messageContent) {
      if (isObject(block)) {
        const blockType = getString(block, 'type');
        const blockName = getString(block, 'name');
        if (blockType === 'tool_use' && blockName) {
          const blockInput = block['input'];
          const inputObj = isObject(blockInput) ? blockInput : null;
          const resolvedNames = resolveToolNames(blockName, inputObj);
          for (const name of resolvedNames) {
            toolUsage.set(name, (toolUsage.get(name) || 0) + 1);
          }
        }
      }
    }
  }
}
