// ============================================================================
// MESSAGES TAB COMPONENT
// Shows ALL entry types from raw JSONL
// ============================================================================

import React, { useState, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { SessionMessage, AppSettings } from '../../../../shared/types';
import { formatNumber } from '../../../../shared/utils';
import { useSettingsStore } from '../../../stores/settingsStore';
import { CopyButton } from '../../common/CopyButton';
import {
  prettifyToolUse,
  prettifyThinking,
  prettifySummary,
  SyntaxHighlightedCode,
  getCopyLabel,
  detectLanguageFromContent,
} from '../../preview/contentPrettify';
import type { RawEntry, ParsedEntry } from './types';
import { getEntryConfig, parseRawEntries, detectLanguage, getModalEntryCopyInfo } from './utils';

interface MessagesTabProps {
  messages: SessionMessage[];
  loading: boolean;
}

export function MessagesTab({ messages, loading }: MessagesTabProps) {
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
  const { entries, counts } = useMemo(() => {
    return parseRawEntries(rawEntries as RawEntry[]);
  }, [rawEntries]);

  // Filter based on settings
  const visibleEntries = useMemo(() => {
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
  const { copyContent, copyLabel } = useMemo(() => {
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

// Markdown renderer for modal
function ModalMarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
