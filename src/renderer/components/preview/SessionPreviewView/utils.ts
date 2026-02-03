// ============================================================================
// SESSION PREVIEW VIEW UTILITIES
// ============================================================================

import type { RawEntry, TypeConfig, SessionEntryType, ParsedSessionEntry, SessionEntryCounts } from './types';
import { detectLanguageFromContent, getCopyLabel } from '../contentPrettify';

export function getTypeConfig(type: SessionEntryType): TypeConfig {
  const configs: Record<SessionEntryType, TypeConfig> = {
    user: {
      label: 'User',
      borderColor: 'border-primary-500/30',
      bgColor: 'bg-primary-500/5',
      iconColor: 'text-primary-400',
      badgeBg: 'bg-primary-500/20',
      badgeText: 'text-primary-400',
    },
    assistant: {
      label: 'Assistant',
      borderColor: 'border-surface-600',
      bgColor: 'bg-surface-800/50',
      iconColor: 'text-surface-400',
      badgeBg: 'bg-surface-700',
      badgeText: 'text-surface-200',
    },
    tool_use: {
      label: 'Tool Call',
      borderColor: 'border-warning-500/30',
      bgColor: 'bg-warning-500/5',
      iconColor: 'text-warning-400',
      badgeBg: 'bg-warning-500/20',
      badgeText: 'text-warning-400',
    },
    tool_result: {
      label: 'Tool Result',
      borderColor: 'border-success-500/30',
      bgColor: 'bg-success-500/5',
      iconColor: 'text-success-400',
      badgeBg: 'bg-success-500/20',
      badgeText: 'text-success-400',
    },
    thinking: {
      label: 'Thinking',
      borderColor: 'border-accent-500/30',
      bgColor: 'bg-accent-500/5',
      iconColor: 'text-accent-400',
      badgeBg: 'bg-accent-500/20',
      badgeText: 'text-accent-400',
    },
    system: {
      label: 'System',
      borderColor: 'border-error-500/30',
      bgColor: 'bg-error-500/5',
      iconColor: 'text-error-400',
      badgeBg: 'bg-error-500/20',
      badgeText: 'text-error-400',
    },
    summary: {
      label: 'Summary',
      borderColor: 'border-info-500/30',
      bgColor: 'bg-info-500/5',
      iconColor: 'text-info-400',
      badgeBg: 'bg-info-500/20',
      badgeText: 'text-info-400',
    },
    unknown: {
      label: 'Unknown',
      borderColor: 'border-surface-600',
      bgColor: 'bg-surface-800/30',
      iconColor: 'text-surface-500',
      badgeBg: 'bg-surface-700',
      badgeText: 'text-surface-400',
    },
  };

  return configs[type] || configs.unknown;
}

export function parseAllEntries(rawEntries: RawEntry[]): { entries: ParsedSessionEntry[]; counts: SessionEntryCounts } {
  const entries: ParsedSessionEntry[] = [];
  const counts: SessionEntryCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    tool_use: 0,
    tool_result: 0,
    thinking: 0,
    system: 0,
    summary: 0,
    unknown: 0,
  };

  let id = 0;

  for (const raw of rawEntries) {
    const parsed = parseEntry(raw, id);

    for (const entry of parsed) {
      entries.push(entry);
      counts.total++;
      counts[entry.type as keyof Omit<SessionEntryCounts, 'total'>]++;
      id++;
    }
  }

  return { entries, counts };
}

function parseEntry(raw: RawEntry, startId: number): ParsedSessionEntry[] {
  const results: ParsedSessionEntry[] = [];
  let id = startId;

  const entryType = raw.type || '';

  // Filter out internal/metadata entry types that shouldn't be displayed
  const ignoredTypes = [
    'queue-operation',
    'file-history-snapshot',
    'lock',
    'unlock',
  ];
  if (ignoredTypes.includes(entryType)) {
    return results;
  }

  // Handle user messages - may contain tool_result content blocks
  if (entryType === 'user') {
    const message = raw.message;

    // Check if content is an array with tool_result blocks
    if (message?.content && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          // This is a tool result embedded in a user message
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2);

          results.push({
            id: id++,
            type: 'tool_result',
            content: content || '',
            toolId: block.tool_use_id,
            timestamp: raw.timestamp,
          });
        } else if (block.type === 'text' && block.text) {
          // Regular text content from user
          results.push({
            id: id++,
            type: 'user',
            content: block.text,
            timestamp: raw.timestamp,
          });
        }
      }
      return results;
    }

    // Simple string content
    const content = extractTextContent(raw.message);
    if (content) {
      results.push({
        id: id++,
        type: 'user',
        content,
        timestamp: raw.timestamp,
      });
    }
    return results;
  }

  // Handle assistant messages - these can contain multiple content blocks
  if (entryType === 'assistant') {
    const message = raw.message;

    if (message?.content) {
      // If content is an array, process each block
      if (Array.isArray(message.content)) {
        let textContent = '';

        for (const block of message.content) {
          // Text blocks
          if (block.type === 'text' && block.text) {
            textContent += (textContent ? '\n' : '') + block.text;
          }

          // Thinking blocks embedded in assistant message
          if (block.type === 'thinking' && block.thinking) {
            results.push({
              id: id++,
              type: 'thinking',
              content: block.thinking,
              timestamp: raw.timestamp,
            });
          }

          // Tool use blocks embedded in assistant message
          if (block.type === 'tool_use') {
            results.push({
              id: id++,
              type: 'tool_use',
              content: JSON.stringify(block.input || {}, null, 2),
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input as Record<string, unknown>,
              timestamp: raw.timestamp,
              usage: raw.usage,
              costUSD: raw.costUSD,
            });
          }
        }

        // Add accumulated text content as assistant message
        if (textContent) {
          results.push({
            id: id++,
            type: 'assistant',
            content: textContent,
            timestamp: raw.timestamp,
            usage: raw.usage,
            costUSD: raw.costUSD,
          });
        }
      } else if (typeof message.content === 'string') {
        results.push({
          id: id++,
          type: 'assistant',
          content: message.content,
          timestamp: raw.timestamp,
          usage: raw.usage,
          costUSD: raw.costUSD,
        });
      }
    }

    return results;
  }

  // Handle standalone tool_result entries
  if (entryType === 'tool_result') {
    const content = typeof raw.content === 'string'
      ? raw.content
      : JSON.stringify(raw.content, null, 2);

    results.push({
      id: id++,
      type: 'tool_result',
      content: content || '',
      toolId: raw.tool_use_id,
      isError: raw.is_error,
      timestamp: raw.timestamp,
    });
    return results;
  }

  // Handle summary entries
  if (entryType === 'summary') {
    results.push({
      id: id++,
      type: 'summary',
      content: raw.summary || '',
      timestamp: raw.timestamp,
    });
    return results;
  }

  // Handle system entries
  if (entryType === 'system') {
    const content = extractTextContent(raw.message) || (typeof raw.content === 'string' ? raw.content : '');
    if (content) {
      results.push({
        id: id++,
        type: 'system',
        content,
        timestamp: raw.timestamp,
      });
    }
    return results;
  }

  // Handle standalone thinking entries (rare, usually embedded in assistant)
  if (entryType === 'thinking') {
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (content) {
      results.push({
        id: id++,
        type: 'thinking',
        content,
        timestamp: raw.timestamp,
      });
    }
    return results;
  }

  // Handle any other entry type as unknown
  // Only show if there's actual user-facing content (not metadata)
  if (raw.message || raw.summary) {
    const content = extractTextContent(raw.message) || raw.summary || '';

    // Skip if content is empty or just whitespace
    if (content.trim()) {
      results.push({
        id: id++,
        type: 'unknown',
        content,
        timestamp: raw.timestamp,
      });
    }
  }

  return results;
}

function extractTextContent(message: RawEntry['message']): string {
  if (!message) return '';

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n');
  }

  return '';
}

export function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * Get the copyable content and appropriate label for an entry
 */
export function getEntryCopyInfo(entry: ParsedSessionEntry): { copyContent: string; copyLabel: string } {
  switch (entry.type) {
    case 'tool_use':
      // Copy the full tool input as JSON
      if (entry.toolInput) {
        return {
          copyContent: JSON.stringify(entry.toolInput, null, 2),
          copyLabel: 'Copy as JSON',
        };
      }
      return { copyContent: entry.content, copyLabel: 'Copy' };

    case 'tool_result': {
      // Copy the raw result content with appropriate label
      const language = detectLanguageFromContent(entry.content);
      return {
        copyContent: entry.content,
        copyLabel: getCopyLabel(entry.content, language),
      };
    }

    case 'thinking':
      // Copy the raw thinking text
      return { copyContent: entry.content, copyLabel: 'Copy' };

    case 'user':
    case 'assistant':
      // Copy the message content (markdown source)
      return { copyContent: entry.content, copyLabel: 'Copy' };

    case 'system':
    case 'summary':
      return { copyContent: entry.content, copyLabel: 'Copy' };

    default:
      return { copyContent: entry.content, copyLabel: 'Copy' };
  }
}
