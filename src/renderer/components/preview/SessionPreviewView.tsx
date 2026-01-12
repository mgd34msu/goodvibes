// ============================================================================
// SESSION PREVIEW VIEW - Read-only formatted session viewer
// Shows ALL entry types from Claude JSONL with expand/collapse functionality
// ============================================================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { clsx } from 'clsx';
import { useSettingsStore } from '../../stores/settingsStore';
import { CopyButton } from '../common/CopyButton';
import type { SessionEntryType, ParsedSessionEntry, SessionEntryCounts, AppSettings } from '../../../shared/types';
import {
  prettifyToolUse,
  prettifyThinking,
  prettifySummary,
  SyntaxHighlightedCode,
  getCopyLabel,
  detectLanguageFromContent,
} from './contentPrettify';

interface SessionPreviewViewProps {
  sessionId: string;
  sessionName: string;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SessionPreviewView({ sessionId, sessionName }: SessionPreviewViewProps) {
  const { settings } = useSettingsStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [globalExpanded, setGlobalExpanded] = useState<boolean | null>(null);

  // Query for raw session entries
  const { data: rawEntries = [], isLoading, error, refetch } = useQuery({
    queryKey: ['session-raw-entries', sessionId],
    queryFn: () => window.goodvibes.getSessionRawEntries(sessionId),
    refetchInterval: 2000,
  });

  // Query for live status
  const { data: isLive = false } = useQuery({
    queryKey: ['session-live', sessionId],
    queryFn: () => window.goodvibes.isSessionLive(sessionId),
    refetchInterval: 5000,
  });

  // Parse entries into structured messages
  const { entries, counts } = useMemo(() => {
    return parseAllEntries(rawEntries as RawEntry[]);
  }, [rawEntries]);

  // Filter entries based on visibility settings
  const visibleEntries = useMemo(() => {
    return entries.filter((entry) => {
      switch (entry.type) {
        case 'thinking':
          return settings.showThinkingBlocks;
        case 'tool_use':
          return settings.showToolUseBlocks;
        case 'tool_result':
          return settings.showToolResultBlocks;
        case 'system':
          return settings.showSystemBlocks;
        case 'summary':
          return settings.showSummaryBlocks;
        default:
          return true;
      }
    });
  }, [entries, settings]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visibleEntries, autoScroll]);

  // Handle scroll to detect if user scrolled up
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
      setAutoScroll(isAtBottom);
    }
  }, []);

  const handleExpandAll = () => setGlobalExpanded(true);
  const handleCollapseAll = () => setGlobalExpanded(false);
  const handleResetExpand = () => setGlobalExpanded(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-900">
        <div className="text-surface-400">Loading session...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-surface-900">
        <div className="text-error-400">Failed to load session</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface-900 relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-700 bg-surface-850">
        <div className="flex items-center gap-2">
          <span className="text-surface-200 font-medium">{sessionName}</span>
          {isLive && (
            <span className="px-2 py-0.5 text-xs bg-success-500/20 text-success-400 rounded-full flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-success-400 rounded-full animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExpandAll}
            className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            title="Expand All"
          >
            Expand All
          </button>
          <button
            onClick={handleCollapseAll}
            className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            title="Collapse All"
          >
            Collapse All
          </button>
          {globalExpanded !== null && (
            <button
              onClick={handleResetExpand}
              className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
              title="Reset to Defaults"
            >
              Reset
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Entry Count Summary */}
      <div className="px-4 py-2 border-b border-surface-700 bg-surface-850/50 text-xs text-surface-400 flex flex-wrap gap-2">
        <span className="font-medium text-surface-300">{counts.total} entries:</span>
        {counts.user > 0 && <CountBadge type="user" count={counts.user} />}
        {counts.assistant > 0 && <CountBadge type="assistant" count={counts.assistant} />}
        {counts.tool_use > 0 && <CountBadge type="tool_use" count={counts.tool_use} />}
        {counts.tool_result > 0 && <CountBadge type="tool_result" count={counts.tool_result} />}
        {counts.thinking > 0 && <CountBadge type="thinking" count={counts.thinking} />}
        {counts.system > 0 && <CountBadge type="system" count={counts.system} />}
        {counts.summary > 0 && <CountBadge type="summary" count={counts.summary} />}
      </div>

      {/* Entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-4 space-y-3"
        onScroll={handleScroll}
      >
        {visibleEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-surface-400">
            No entries to display
          </div>
        ) : (
          visibleEntries.map((entry) => (
            <EntryBlock
              key={entry.id}
              entry={entry}
              settings={settings}
              globalExpanded={globalExpanded}
            />
          ))
        )}
      </div>

      {/* Scroll to bottom button */}
      {!autoScroll && (
        <button
          onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
            setAutoScroll(true);
          }}
          className="absolute bottom-4 right-4 p-2 bg-primary-500 text-white rounded-full shadow-lg hover:bg-primary-600 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ============================================================================
// COUNT BADGE
// ============================================================================

function CountBadge({ type, count }: { type: SessionEntryType; count: number }) {
  const config = getTypeConfig(type);
  return (
    <span className={clsx('px-1.5 py-0.5 rounded text-xs', config.badgeBg, config.badgeText)}>
      {count} {config.label.toLowerCase()}
    </span>
  );
}

// ============================================================================
// ENTRY BLOCK
// ============================================================================

interface EntryBlockProps {
  entry: ParsedSessionEntry;
  settings: AppSettings;
  globalExpanded: boolean | null;
}

function EntryBlock({ entry, settings, globalExpanded }: EntryBlockProps) {
  const config = getTypeConfig(entry.type);

  // Determine default expand state from settings
  const getDefaultExpand = (): boolean => {
    switch (entry.type) {
      case 'user': return settings.expandUserByDefault;
      case 'assistant': return settings.expandAssistantByDefault;
      case 'thinking': return settings.expandThinkingByDefault;
      case 'tool_use': return settings.expandToolUseByDefault;
      case 'tool_result': return settings.expandToolResultByDefault;
      case 'system': return settings.expandSystemByDefault;
      case 'summary': return settings.expandSummaryByDefault;
      case 'unknown': return false; // Unknown blocks collapsed by default
      default: return false;
    }
  };

  const effectiveExpanded = globalExpanded !== null ? globalExpanded : getDefaultExpand();
  const [isExpanded, setIsExpanded] = useState(effectiveExpanded);

  // Update when global expand changes
  useEffect(() => {
    if (globalExpanded !== null) {
      setIsExpanded(globalExpanded);
    }
  }, [globalExpanded]);

  // Generate preview (first ~100 chars)
  const preview = useMemo(() => {
    const text = entry.content || '';
    if (text.length <= 100) return text;
    return text.slice(0, 100).trim() + '...';
  }, [entry.content]);

  // Get copyable content and label for this entry
  const { copyContent, copyLabel } = useMemo(() => {
    return getEntryCopyInfo(entry);
  }, [entry]);

  const handleToggle = () => setIsExpanded(!isExpanded);

  // Handle keyboard interaction
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggle();
    }
  };

  return (
    <div
      className={clsx(
        'rounded-lg border overflow-hidden transition-all',
        config.borderColor,
        config.bgColor
      )}
    >
      {/* Header - Always visible, clickable */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        className={clsx(
          'w-full px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-white/5 transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-inset'
        )}
      >
        {/* Expand/collapse icon */}
        <svg
          className={clsx('w-4 h-4 flex-shrink-0 transition-transform', config.iconColor, isExpanded && 'rotate-90')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        {/* Type badge */}
        <span className={clsx('px-2 py-0.5 text-xs font-medium rounded', config.badgeBg, config.badgeText)}>
          {config.label}
        </span>

        {/* Tool name for tool_use */}
        {entry.type === 'tool_use' && entry.toolName && (
          <span className="text-xs font-mono text-warning-400 bg-warning-500/10 px-2 py-0.5 rounded">
            {entry.toolName}
          </span>
        )}

        {/* Error indicator for tool_result */}
        {entry.type === 'tool_result' && entry.isError && (
          <span className="text-xs font-medium text-error-400 bg-error-500/10 px-2 py-0.5 rounded">
            Error
          </span>
        )}

        {/* Preview when collapsed */}
        {!isExpanded && (
          <span className="flex-1 text-sm text-surface-400 truncate">
            {preview}
          </span>
        )}

        {/* Spacer when expanded to push items to the right */}
        {isExpanded && <span className="flex-1" />}

        {/* Timestamp */}
        {entry.timestamp && (
          <span className="text-xs text-surface-500 flex-shrink-0">
            {formatTime(entry.timestamp)}
          </span>
        )}

        {/* Token count */}
        {entry.usage && (entry.usage.input_tokens || entry.usage.output_tokens) && (
          <span className="text-xs text-surface-500 flex-shrink-0">
            {(entry.usage.input_tokens || 0) + (entry.usage.output_tokens || 0)} tokens
          </span>
        )}

        {/* Copy button in header */}
        {copyContent && (
          <CopyButton
            content={copyContent}
            label={copyLabel}
            iconOnly
            size="sm"
          />
        )}
      </div>

      {/* Content - Shown when expanded */}
      {isExpanded && (
        <div className="px-4 py-3 border-t border-inherit">
          <EntryContent entry={entry} />
        </div>
      )}
    </div>
  );
}

/**
 * Get the copyable content and appropriate label for an entry
 */
function getEntryCopyInfo(entry: ParsedSessionEntry): { copyContent: string; copyLabel: string } {
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

    case 'tool_result':
      // Copy the raw result content with appropriate label
      const language = detectLanguageFromContent(entry.content);
      return {
        copyContent: entry.content,
        copyLabel: getCopyLabel(entry.content, language),
      };

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

// ============================================================================
// ENTRY CONTENT - Uses prettification utilities for beautiful formatting
// ============================================================================

function EntryContent({ entry }: { entry: ParsedSessionEntry }) {
  switch (entry.type) {
    case 'user':
      return (
        <div className="text-surface-100">
          <MarkdownRenderer content={entry.content} />
        </div>
      );

    case 'assistant':
      return (
        <div className="text-surface-100">
          <MarkdownRenderer content={entry.content} />
        </div>
      );

    case 'thinking':
      return prettifyThinking(entry.content);

    case 'tool_use':
      return prettifyToolUse(entry.toolName, entry.toolInput, entry.toolId);

    case 'tool_result':
      return (
        <ToolResultContent content={entry.content} isError={entry.isError} />
      );

    case 'system':
      return (
        <div className="text-surface-300 text-sm">
          <MarkdownRenderer content={entry.content} />
        </div>
      );

    case 'summary':
      return prettifySummary(entry.content);

    default:
      return (
        <div className="text-surface-400 text-sm whitespace-pre-wrap">
          {entry.content}
        </div>
      );
  }
}

// Tool result with truncation and syntax highlighting
function ToolResultContent({ content, isError }: { content: string; isError?: boolean }) {
  const MAX_LINES = 50;
  const [showFull, setShowFull] = useState(false);
  const lines = content.split('\n');
  const isTruncated = lines.length > MAX_LINES && !showFull;

  const displayContent = showFull ? content : lines.slice(0, MAX_LINES).join('\n');

  // Detect language from content
  const language = detectLanguageFromContent(displayContent);
  const copyLabel = getCopyLabel(content, language);

  if (isError) {
    return (
      <div className="space-y-2 relative">
        <CopyButton
          content={content}
          label={copyLabel}
          position="top-right"
          iconOnly
        />
        <pre className="text-error-300 text-sm font-mono whitespace-pre-wrap bg-error-500/10 border border-error-500/30 rounded-lg p-3 overflow-x-auto">
          {displayContent}
        </pre>
        {isTruncated && (
          <button
            onClick={() => setShowFull(true)}
            className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            Show {lines.length - MAX_LINES} more lines
          </button>
        )}
      </div>
    );
  }

  // If we detect a language, use syntax highlighting
  if (language) {
    return (
      <div className="space-y-2">
        <SyntaxHighlightedCode code={displayContent} language={language} copyLabel={copyLabel} />
        {isTruncated && (
          <button
            onClick={() => setShowFull(true)}
            className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            Show {lines.length - MAX_LINES} more lines
          </button>
        )}
      </div>
    );
  }

  // Default: formatted monospace text
  return (
    <div className="space-y-2 relative">
      <CopyButton
        content={content}
        label="Copy"
        position="top-right"
        iconOnly
      />
      <pre className="text-surface-300 text-sm font-mono whitespace-pre-wrap bg-surface-800/50 border border-surface-700 rounded-lg p-3 overflow-x-auto">
        {displayContent}
      </pre>
      {isTruncated && (
        <button
          onClick={() => setShowFull(true)}
          className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          Show {lines.length - MAX_LINES} more lines
        </button>
      )}
    </div>
  );
}

// ============================================================================
// TYPE CONFIGURATION
// ============================================================================

interface TypeConfig {
  label: string;
  borderColor: string;
  bgColor: string;
  iconColor: string;
  badgeBg: string;
  badgeText: string;
}

function getTypeConfig(type: SessionEntryType): TypeConfig {
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

// ============================================================================
// MARKDOWN RENDERER - With syntax highlighting via rehype-highlight
// ============================================================================

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        code: ({ inline, className, children, ...props }: any) => {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';

          if (inline) {
            return (
              <code
                className="px-1.5 py-0.5 bg-surface-700 rounded text-sm font-mono text-primary-300"
                {...props}
              >
                {children}
              </code>
            );
          }

          // For code blocks, wrap in a styled container with copy button
          return (
            <CodeBlockWrapper language={language || ''}>
              <code className={clsx('hljs', className)} {...props}>
                {children}
              </code>
            </CodeBlockWrapper>
          );
        },
        pre: ({ children }) => <>{children}</>,
        p: ({ children, node }) => {
          // Check if paragraph contains block-level elements (like code blocks)
          // If so, render as div to avoid invalid HTML nesting (<pre> cannot be inside <p>)
          const hasBlockChild = node?.children?.some(
            (child: any) =>
              child.tagName === 'pre' ||
              child.tagName === 'div' ||
              child.tagName === 'table' ||
              child.tagName === 'blockquote' ||
              child.tagName === 'ul' ||
              child.tagName === 'ol'
          );
          if (hasBlockChild) {
            return <div className="mb-2 last:mb-0">{children}</div>;
          }
          return <p className="mb-2 last:mb-0">{children}</p>;
        },
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="text-surface-200">{children}</li>,
        h1: ({ children }) => <h1 className="text-xl font-bold mb-2 text-surface-100">{children}</h1>,
        h2: ({ children }) => <h2 className="text-lg font-bold mb-2 text-surface-100">{children}</h2>,
        h3: ({ children }) => <h3 className="text-base font-bold mb-2 text-surface-100">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-surface-600 pl-4 my-2 text-surface-300 italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-400 hover:text-primary-300 underline"
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full border-collapse border border-surface-600">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-surface-600 px-3 py-2 bg-surface-700 text-left text-surface-200">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-surface-600 px-3 py-2 text-surface-300">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// Wrapper for code blocks with copy functionality
function CodeBlockWrapper({ language, children }: { language: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);

  const handleCopy = async () => {
    if (codeRef.current) {
      const text = codeRef.current.textContent || '';
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden bg-surface-950 border border-surface-700">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800 border-b border-surface-700">
        <span className="text-xs text-surface-400 font-mono">{language || 'text'}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-surface-400 hover:text-surface-200 transition-colors flex items-center gap-1"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre ref={codeRef} className="p-3 overflow-x-auto text-sm">
        {children}
      </pre>
    </div>
  );
}

// ============================================================================
// RAW ENTRY TYPE (from JSONL)
// ============================================================================

interface RawEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  costUSD?: number;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
  summary?: string;
  timestamp?: string;
  // Special entry types to filter out
  operation?: string; // queue-operation
  snapshot?: unknown; // file-history-snapshot
  messageId?: string; // file-history-snapshot
}

// ============================================================================
// PARSING HELPERS
// ============================================================================

function parseAllEntries(rawEntries: RawEntry[]): { entries: ParsedSessionEntry[]; counts: SessionEntryCounts } {
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

function formatTime(timestamp: string): string {
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
