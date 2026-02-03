// ============================================================================
// SESSION DETAIL MODAL UTILITIES
// ============================================================================

import type { RawEntry, ParsedEntry, EntryCounts, EntryConfig } from './types';
import { detectLanguageFromContent, getCopyLabel } from '../../preview/contentPrettify';

export function getEntryConfig(type: string): EntryConfig {
  const configs: Record<string, EntryConfig> = {
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
  };

  return configs[type] || {
    label: type || 'Unknown',
    borderColor: 'border-surface-600',
    bgColor: 'bg-surface-800/30',
    iconColor: 'text-surface-500',
    badgeBg: 'bg-surface-700',
    badgeText: 'text-surface-400',
  };
}

export function parseRawEntries(rawEntries: RawEntry[]): { entries: ParsedEntry[]; counts: EntryCounts } {
  const entries: ParsedEntry[] = [];
  const counts: EntryCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    tool_use: 0,
    tool_result: 0,
    thinking: 0,
    system: 0,
    summary: 0,
  };

  let id = 0;

  for (const raw of rawEntries) {
    const entryType = raw.type || '';

    // User messages
    if (entryType === 'user') {
      const content = extractContent(raw.message);
      if (content) {
        entries.push({ id: id++, type: 'user', content, timestamp: raw.timestamp });
        counts.user++;
        counts.total++;
      }
      continue;
    }

    // Assistant messages - may contain multiple blocks
    if (entryType === 'assistant') {
      const message = raw.message;
      if (message?.content && Array.isArray(message.content)) {
        let textContent = '';

        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            textContent += (textContent ? '\n' : '') + block.text;
          }
          if (block.type === 'thinking' && block.thinking) {
            entries.push({
              id: id++,
              type: 'thinking',
              content: block.thinking,
              timestamp: raw.timestamp,
            });
            counts.thinking++;
            counts.total++;
          }
          if (block.type === 'tool_use') {
            entries.push({
              id: id++,
              type: 'tool_use',
              content: JSON.stringify(block.input || {}, null, 2),
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
              timestamp: raw.timestamp,
              tokens: (raw.usage?.input_tokens || 0) + (raw.usage?.output_tokens || 0),
            });
            counts.tool_use++;
            counts.total++;
          }
        }

        if (textContent) {
          entries.push({
            id: id++,
            type: 'assistant',
            content: textContent,
            timestamp: raw.timestamp,
            tokens: (raw.usage?.input_tokens || 0) + (raw.usage?.output_tokens || 0),
          });
          counts.assistant++;
          counts.total++;
        }
      } else if (typeof message?.content === 'string') {
        entries.push({
          id: id++,
          type: 'assistant',
          content: message.content,
          timestamp: raw.timestamp,
          tokens: (raw.usage?.input_tokens || 0) + (raw.usage?.output_tokens || 0),
        });
        counts.assistant++;
        counts.total++;
      }
      continue;
    }

    // Tool result
    if (entryType === 'tool_result') {
      const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content, null, 2);
      entries.push({
        id: id++,
        type: 'tool_result',
        content: content || '',
        toolId: raw.tool_use_id,
        isError: raw.is_error,
        timestamp: raw.timestamp,
      });
      counts.tool_result++;
      counts.total++;
      continue;
    }

    // Summary
    if (entryType === 'summary') {
      entries.push({
        id: id++,
        type: 'summary',
        content: raw.summary || '',
        timestamp: raw.timestamp,
      });
      counts.summary++;
      counts.total++;
      continue;
    }

    // System
    if (entryType === 'system') {
      const content = extractContent(raw.message) || (typeof raw.content === 'string' ? raw.content : '');
      if (content) {
        entries.push({ id: id++, type: 'system', content, timestamp: raw.timestamp });
        counts.system++;
        counts.total++;
      }
      continue;
    }

    // Standalone thinking
    if (entryType === 'thinking') {
      const content = typeof raw.content === 'string' ? raw.content : '';
      if (content) {
        entries.push({ id: id++, type: 'thinking', content, timestamp: raw.timestamp });
        counts.thinking++;
        counts.total++;
      }
      continue;
    }
  }

  return { entries, counts };
}

function extractContent(message: RawEntry['message']): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// Language detection helper
export function detectLanguage(content: string): string | null {
  const trimmed = content.trim();

  // TypeScript/JavaScript
  if (/^(import|export|const|let|var|function|class|interface|type)\s/.test(trimmed) ||
      /^['"]use (strict|client)['"];?/.test(trimmed)) {
    return 'typescript';
  }

  // Python
  if (/^(import|from|def|class|if __name__)\s/.test(trimmed) ||
      /^#!.*python/.test(trimmed)) {
    return 'python';
  }

  // Rust
  if (/^(use|fn|struct|impl|pub|mod|enum)\s/.test(trimmed) ||
      trimmed.includes('fn main()')) {
    return 'rust';
  }

  // Go
  if (/^package\s+\w+/.test(trimmed) || /^func\s+/.test(trimmed)) {
    return 'go';
  }

  // Shell/Bash
  if (/^#!\/bin\/(bash|sh|zsh)/.test(trimmed)) {
    return 'bash';
  }

  // HTML
  if (/^<!DOCTYPE|^<html|^<div|^<span|^<p\s/.test(trimmed)) {
    return 'html';
  }

  // CSS
  if (/^[.#@][\w-]+\s*{/.test(trimmed) || /^:root\s*{/.test(trimmed)) {
    return 'css';
  }

  // SQL
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/i.test(trimmed)) {
    return 'sql';
  }

  // JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

/**
 * Get the copyable content and appropriate label for a modal entry
 */
export function getModalEntryCopyInfo(entry: ParsedEntry): { copyContent: string; copyLabel: string } {
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
