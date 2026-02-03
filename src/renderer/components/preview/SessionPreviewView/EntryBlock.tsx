// ============================================================================
// ENTRY BLOCK COMPONENT
// Renders individual session entries with expand/collapse
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import { clsx } from 'clsx';
import type { AppSettings, ParsedSessionEntry } from '../../../../shared/types';
import { CopyButton } from '../../common/CopyButton';
import { ErrorBoundary } from '../../common/ErrorBoundary';
import {
  prettifyToolUse,
  prettifyThinking,
  prettifySummary,
  SyntaxHighlightedCode,
  getCopyLabel,
  detectLanguageFromContent,
} from '../contentPrettify';
import { MarkdownRenderer } from '../../common/MarkdownRenderer';
import { getTypeConfig, formatTime, getEntryCopyInfo } from './utils';

interface EntryBlockProps {
  entry: ParsedSessionEntry;
  settings: AppSettings;
  globalExpanded: boolean | null;
}

// Memoized to prevent re-renders when props haven't changed
export const EntryBlock = React.memo(function EntryBlock({ entry, settings, globalExpanded }: EntryBlockProps): React.JSX.Element {
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
          <ErrorBoundary
            fallback={
              <div className="p-3 rounded-lg bg-error-500/10 border border-error-500/30">
                <p className="text-error-400 text-sm">Failed to render content</p>
                <p className="text-surface-500 text-xs mt-1">The content could not be displayed.</p>
              </div>
            }
            resetKeys={[entry.id]}
          >
            <EntryContent entry={entry} />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
});

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
