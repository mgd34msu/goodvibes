// ============================================================================
// SESSION DETAIL MODAL COMPONENT
// ============================================================================

import React, { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Session, SessionMessage, AppSettings } from '../../../shared/types';
import { formatCost, formatNumber, formatDateTime, formatDuration, decodeProjectName, decodeProjectPath } from '../../../shared/utils';
import { useAppStore } from '../../stores/appStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { CopyButton } from '../common/CopyButton';
import {
  prettifyToolUse,
  prettifyThinking,
  prettifySummary,
  SyntaxHighlightedCode,
  getCopyLabel,
  detectLanguageFromContent,
} from '../preview/contentPrettify';

interface SessionDetailModalProps {
  session: Session;
  onClose: () => void;
}

export function SessionDetailModal({ session, onClose }: SessionDetailModalProps) {
  const { setCurrentView } = useAppStore();
  const { settings } = useSettingsStore();
  const { createPreviewTerminal, createTerminal } = useTerminalStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'messages' | 'tokens'>('overview');

  const { data: messages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ['session-messages', session.id],
    queryFn: () => window.goodvibes.getSessionMessages(session.id),
    enabled: activeTab === 'messages',
  });

  // Fetch fresh session data with token stats immediately on modal open
  const { data: refreshedSession } = useQuery({
    queryKey: ['session-refresh', session.id],
    queryFn: () => window.goodvibes.refreshSession(session.id),
    staleTime: 0, // Always refetch on mount
  });

  // Use refreshed session data when available, fallback to prop session
  const currentSession = refreshedSession ?? session;

  const handleOpenPreview = () => {
    const cwd = decodeProjectPath(session.projectName) || undefined;
    createPreviewTerminal(session.id, displayName, cwd);
    setCurrentView('terminal');
    onClose();
  };

  const displayName = currentSession.customTitle || decodeProjectName(currentSession.projectName, settings.projectsRoot);

  // Calculate session duration
  const duration = currentSession.startTime && currentSession.endTime
    ? Math.floor((new Date(currentSession.endTime).getTime() - new Date(currentSession.startTime).getTime()) / 1000)
    : null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-surface-100 truncate">
                {displayName}
              </h2>
              {currentSession.favorite && (
                <span className="text-warning-400">&#9733;</span>
              )}
              {currentSession.archived && (
                <span className="badge text-surface-500 bg-surface-700 text-xs">Archived</span>
              )}
            </div>
            <p className="text-sm text-surface-400 mt-0.5">
              Session ID: <span className="font-mono text-surface-500">{session.id}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-surface-800 text-surface-400"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2 px-6 py-2 border-b border-surface-700 bg-surface-850">
          {(['overview', 'messages', 'tokens'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-4 py-1.5 text-sm rounded-lg transition-colors',
                activeTab === tab
                  ? 'bg-primary-500/20 text-primary-400'
                  : 'text-surface-400 hover:bg-surface-800 hover:text-surface-200'
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'overview' && (
            <OverviewTab session={currentSession} duration={duration} displayName={displayName} />
          )}
          {activeTab === 'messages' && (
            <MessagesTab messages={messages} loading={messagesLoading} />
          )}
          {activeTab === 'tokens' && (
            <TokensTab session={currentSession} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-700">
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenPreview}
              className="btn btn-secondary text-sm"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Open Preview
            </button>
            <button
              onClick={async () => {
                // Resume session in a new terminal using the store action
                // This ensures the terminal is properly added to the store and displayed
                const cwd = decodeProjectPath(session.projectName) || undefined;
                await createTerminal(cwd, displayName, session.id);
                setCurrentView('terminal');
                onClose();
              }}
              className="btn btn-primary text-sm"
            >
              <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Resume Session
            </button>
            <button
              onClick={() => window.goodvibes.exportSession(session.id, 'markdown')}
              className="btn btn-secondary text-sm"
            >
              Export Markdown
            </button>
            <button
              onClick={() => window.goodvibes.exportSession(session.id, 'json')}
              className="btn btn-secondary text-sm"
            >
              Export JSON
            </button>
          </div>
          <button onClick={onClose} className="btn btn-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// OVERVIEW TAB
// ============================================================================

function OverviewTab({ session, duration, displayName }: { session: Session; duration: number | null; displayName: string }) {
  return (
    <div className="space-y-6">
      {/* Summary */}
      {session.summary && (
        <div>
          <h3 className="text-sm font-medium text-surface-300 mb-2">Summary</h3>
          <p className="text-surface-200 bg-surface-800 rounded-lg p-4">
            {session.summary}
          </p>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Messages" value={session.messageCount.toString()} />
        <StatCard label="Total Tokens" value={formatNumber(session.tokenCount)} />
        <StatCard label="Cost" value={formatCost(session.cost)} highlight />
        <StatCard label="Duration" value={formatDuration(duration ?? 0)} />
      </div>

      {/* Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DetailRow label="Project" value={displayName} />
        <DetailRow label="Status" value={session.status} />
        <DetailRow label="Started" value={formatDateTime(session.startTime)} />
        <DetailRow label="Ended" value={formatDateTime(session.endTime)} />
        {session.outcome && (
          <DetailRow label="Outcome" value={<OutcomeBadge outcome={session.outcome} />} />
        )}
        {session.rating && (
          <DetailRow label="Rating" value={'★'.repeat(session.rating)} />
        )}
      </div>

      {/* Notes */}
      {session.notes && (
        <div>
          <h3 className="text-sm font-medium text-surface-300 mb-2">Notes</h3>
          <p className="text-surface-300 bg-surface-800 rounded-lg p-4 whitespace-pre-wrap">
            {session.notes}
          </p>
        </div>
      )}

      {/* File Path */}
      {session.filePath && (
        <div>
          <h3 className="text-sm font-medium text-surface-300 mb-2">File Path</h3>
          <p className="text-surface-400 font-mono text-sm bg-surface-800 rounded-lg p-4 break-all">
            {session.filePath}
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MESSAGES TAB - Shows ALL entry types from raw JSONL
// ============================================================================

interface RawEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
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
}

interface ParsedEntry {
  id: number;
  type: string;
  content: string;
  timestamp?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: unknown;
  isError?: boolean;
  tokens?: number;
}

function MessagesTab({ messages, loading }: { messages: SessionMessage[]; loading: boolean }) {
  const { settings } = useSettingsStore();
  const [globalExpanded, setGlobalExpanded] = useState<boolean | null>(null);

  // Get raw entries for this session
  const sessionId = messages.length > 0 ? messages[0]?.sessionId : null;
  const { data: rawEntries = [] } = useQuery({
    queryKey: ['session-raw-entries-modal', sessionId],
    queryFn: () => sessionId ? window.goodvibes.getSessionRawEntries(sessionId) : Promise.resolve([]),
    enabled: !!sessionId && !loading,
  });

  // Parse all raw entries into structured data
  const { entries, counts } = React.useMemo(() => {
    return parseRawEntries(rawEntries as RawEntry[]);
  }, [rawEntries]);

  // Filter based on settings
  const visibleEntries = React.useMemo(() => {
    return entries.filter((entry) => {
      switch (entry.type) {
        case 'thinking': return settings.showThinkingBlocks;
        case 'tool_use': return settings.showToolUseBlocks;
        case 'tool_result': return settings.showToolResultBlocks;
        case 'system': return settings.showSystemBlocks;
        case 'summary': return settings.showSummaryBlocks;
        default: return true;
      }
    });
  }, [entries, settings]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-surface-400">Loading messages...</div>
      </div>
    );
  }

  if (visibleEntries.length === 0 && entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-surface-400">No messages found</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls and Summary */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-surface-400 flex flex-wrap gap-2">
          <span className="font-medium text-surface-300">{counts.total} entries:</span>
          {counts.user > 0 && <EntryCountBadge type="user" count={counts.user} />}
          {counts.assistant > 0 && <EntryCountBadge type="assistant" count={counts.assistant} />}
          {counts.tool_use > 0 && <EntryCountBadge type="tool_use" count={counts.tool_use} />}
          {counts.tool_result > 0 && <EntryCountBadge type="tool_result" count={counts.tool_result} />}
          {counts.thinking > 0 && <EntryCountBadge type="thinking" count={counts.thinking} />}
          {counts.system > 0 && <EntryCountBadge type="system" count={counts.system} />}
          {counts.summary > 0 && <EntryCountBadge type="summary" count={counts.summary} />}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGlobalExpanded(true)}
            className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
          >
            Expand All
          </button>
          <button
            onClick={() => setGlobalExpanded(false)}
            className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
          >
            Collapse All
          </button>
          {globalExpanded !== null && (
            <button
              onClick={() => setGlobalExpanded(null)}
              className="px-2 py-1 text-xs rounded hover:bg-surface-700 text-surface-400 hover:text-surface-200 transition-colors"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Entries */}
      {visibleEntries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          settings={settings}
          globalExpanded={globalExpanded}
        />
      ))}
    </div>
  );
}

function EntryCountBadge({ type, count }: { type: string; count: number }) {
  const config = getEntryConfig(type);
  return (
    <span className={clsx('px-1.5 py-0.5 rounded text-xs', config.badgeBg, config.badgeText)}>
      {count} {config.label.toLowerCase()}
    </span>
  );
}

function EntryCard({ entry, settings, globalExpanded }: { entry: ParsedEntry; settings: AppSettings; globalExpanded: boolean | null }) {
  const config = getEntryConfig(entry.type);

  const getDefaultExpand = (): boolean => {
    switch (entry.type) {
      case 'user': return settings.expandUserByDefault;
      case 'assistant': return settings.expandAssistantByDefault;
      case 'thinking': return settings.expandThinkingByDefault;
      case 'tool_use': return settings.expandToolUseByDefault;
      case 'tool_result': return settings.expandToolResultByDefault;
      case 'system': return settings.expandSystemByDefault;
      case 'summary': return settings.expandSummaryByDefault;
      default: return true;
    }
  };

  const effectiveExpanded = globalExpanded !== null ? globalExpanded : getDefaultExpand();
  const [isExpanded, setIsExpanded] = useState(effectiveExpanded);

  React.useEffect(() => {
    if (globalExpanded !== null) {
      setIsExpanded(globalExpanded);
    }
  }, [globalExpanded]);

  const preview = entry.content.length <= 100 ? entry.content : entry.content.slice(0, 100).trim() + '...';

  // Get copyable content and label for this entry
  const { copyContent, copyLabel } = React.useMemo(() => {
    return getModalEntryCopyInfo(entry);
  }, [entry]);

  return (
    <div className={clsx('rounded-lg border overflow-hidden', config.borderColor, config.bgColor)}>
      <div className="w-full px-4 py-2 flex items-center gap-3 hover:bg-white/5 transition-colors">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-3 flex-1 text-left"
        >
          <svg
            className={clsx('w-4 h-4 flex-shrink-0 transition-transform', config.iconColor, isExpanded && 'rotate-90')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>

          <span className={clsx('px-2 py-0.5 text-xs font-medium rounded', config.badgeBg, config.badgeText)}>
            {config.label}
          </span>

          {entry.type === 'tool_use' && entry.toolName && (
            <span className="text-xs font-mono text-warning-400 bg-warning-500/10 px-2 py-0.5 rounded">
              {entry.toolName}
            </span>
          )}

          {entry.type === 'tool_result' && entry.isError && (
            <span className="text-xs font-medium text-error-400 bg-error-500/10 px-2 py-0.5 rounded">
              Error
            </span>
          )}

          {!isExpanded && (
            <span className="flex-1 text-sm text-surface-400 truncate">{preview}</span>
          )}

          {/* Spacer when expanded to push items to the right */}
          {isExpanded && <span className="flex-1" />}

          {entry.timestamp && (
            <span className="text-xs text-surface-500 flex-shrink-0">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
          )}

          {entry.tokens && entry.tokens > 0 && (
            <span className="text-xs text-surface-500 flex-shrink-0">
              {formatNumber(entry.tokens)} tokens
            </span>
          )}
        </button>

        {/* Copy button in header - outside the expand button */}
        {copyContent && (
          <CopyButton
            content={copyContent}
            label={copyLabel}
            iconOnly
            size="sm"
          />
        )}
      </div>

      {isExpanded && (
        <div className="px-4 py-3 border-t border-inherit">
          <EntryContentRenderer entry={entry} />
        </div>
      )}
    </div>
  );
}

/**
 * Get the copyable content and appropriate label for a modal entry
 */
function getModalEntryCopyInfo(entry: ParsedEntry): { copyContent: string; copyLabel: string } {
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

// Render entry content with prettification based on type
function EntryContentRenderer({ entry }: { entry: ParsedEntry }) {
  switch (entry.type) {
    case 'user':
    case 'assistant':
      return (
        <div className="text-surface-200">
          <ModalMarkdownRenderer content={entry.content} />
        </div>
      );

    case 'thinking':
      return prettifyThinking(entry.content);

    case 'tool_use':
      return prettifyToolUse(entry.toolName, entry.toolInput as Record<string, unknown>, entry.toolId);

    case 'tool_result':
      return <ToolResultRenderer content={entry.content} isError={entry.isError} />;

    case 'system':
      return (
        <div className="text-surface-300 text-sm">
          <ModalMarkdownRenderer content={entry.content} />
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
function ToolResultRenderer({ content, isError }: { content: string; isError?: boolean }) {
  const MAX_LINES = 50;
  const [showFull, setShowFull] = useState(false);
  const lines = content.split('\n');
  const isTruncated = lines.length > MAX_LINES && !showFull;

  const displayContent = showFull ? content : lines.slice(0, MAX_LINES).join('\n');

  // Detect language from content
  const language = detectLanguage(displayContent);
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

// Language detection helper
function detectLanguage(content: string): string | null {
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

// Markdown renderer for modal
function ModalMarkdownRenderer({ content }: { content: string }) {
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

          return (
            <ModalCodeBlockWrapper language={language || ''}>
              <code className={clsx('hljs', className)} {...props}>
                {children}
              </code>
            </ModalCodeBlockWrapper>
          );
        },
        pre: ({ children }) => <>{children}</>,
        p: ({ children }) => <div className="mb-2 last:mb-0">{children}</div>,
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

// Wrapper for code blocks in modal with copy functionality
function ModalCodeBlockWrapper({ language, children }: { language: string; children: React.ReactNode }) {
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

function getEntryConfig(type: string): { label: string; borderColor: string; bgColor: string; iconColor: string; badgeBg: string; badgeText: string } {
  const configs: Record<string, { label: string; borderColor: string; bgColor: string; iconColor: string; badgeBg: string; badgeText: string }> = {
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

interface EntryCounts {
  total: number;
  user: number;
  assistant: number;
  tool_use: number;
  tool_result: number;
  thinking: number;
  system: number;
  summary: number;
}

function parseRawEntries(rawEntries: RawEntry[]): { entries: ParsedEntry[]; counts: EntryCounts } {
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

// ============================================================================
// TOKENS TAB
// ============================================================================

function TokensTab({ session }: { session: Session }) {
  const tokenBreakdown = [
    { label: 'Input Tokens', value: session.inputTokens, color: 'bg-primary-500' },
    { label: 'Output Tokens', value: session.outputTokens, color: 'bg-success-500' },
    { label: 'Cache Write', value: session.cacheWriteTokens, color: 'bg-warning-500' },
    { label: 'Cache Read', value: session.cacheReadTokens, color: 'bg-accent-500' },
  ];

  const total = tokenBreakdown.reduce((sum, t) => sum + t.value, 0);

  return (
    <div className="space-y-6">
      {/* Token Breakdown */}
      <div>
        <h3 className="text-sm font-medium text-surface-300 mb-4">Token Breakdown</h3>
        <div className="space-y-3">
          {tokenBreakdown.map(({ label, value, color }) => (
            <div key={label}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-surface-300">{label}</span>
                <span className="text-surface-100 font-mono">{formatNumber(value)}</span>
              </div>
              <div className="h-2 bg-surface-800 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full', color)}
                  style={{ width: `${total > 0 ? (value / total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Tokens" value={formatNumber(session.tokenCount)} />
        <StatCard label="Input" value={formatNumber(session.inputTokens)} />
        <StatCard label="Output" value={formatNumber(session.outputTokens)} />
        <StatCard label="Cached" value={formatNumber(session.cacheReadTokens + session.cacheWriteTokens)} />
      </div>

      {/* Cost Analysis */}
      <div>
        <h3 className="text-sm font-medium text-surface-300 mb-4">Cost Analysis</h3>
        <div className="grid grid-cols-2 gap-4">
          <DetailRow label="Total Cost" value={formatCost(session.cost)} />
          <DetailRow
            label="Cost per Message"
            value={session.messageCount > 0 ? formatCost(session.cost / session.messageCount) : 'N/A'}
          />
          <DetailRow
            label="Cost per 1K Tokens"
            value={session.tokenCount > 0 ? formatCost((session.cost / session.tokenCount) * 1000) : 'N/A'}
          />
          <DetailRow
            label="Tokens per Message"
            value={session.messageCount > 0 ? formatNumber(Math.round(session.tokenCount / session.messageCount)) : 'N/A'}
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-surface-800 rounded-lg p-4">
      <p className="text-xs text-surface-400 mb-1">{label}</p>
      <p className={clsx(
        'text-xl font-semibold',
        highlight ? 'text-primary-400' : 'text-surface-100'
      )}>
        {value}
      </p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-surface-800 rounded-lg">
      <span className="text-sm text-surface-400">{label}</span>
      <span className="text-sm text-surface-100">{value}</span>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <span className={clsx(
      'badge text-xs',
      outcome === 'success' && 'badge-success',
      outcome === 'partial' && 'badge-warning',
      outcome === 'failed' && 'badge-error',
      outcome === 'abandoned' && 'text-surface-500 bg-surface-700'
    )}>
      {outcome}
    </span>
  );
}
