// ============================================================================
// CONTENT PRETTIFICATION FUNCTIONS
// Functions for formatting various content types
// ============================================================================

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { CopyButton } from '../../common/CopyButton';
import { SyntaxHighlightedCode } from './CodeBlock';
import { PrettifiedObject } from './JsonViewer';
import { parseXmlLikeTags } from './utils';
import type { CollapsibleContentProps } from './types';

// ============================================================================
// TOOL USE PRETTIFICATION
// ============================================================================

/**
 * Format tool use with prominent tool name and pretty-printed input as key-value pairs
 * NOT as JSON code blocks - those are reserved for assistant/thinking content
 */
export function prettifyToolUse(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  toolId?: string
): React.ReactNode {
  const inputJson = toolInput ? JSON.stringify(toolInput, null, 2) : '';

  return (
    <div className="space-y-3 relative">
      {/* Copy button for full tool input */}
      {inputJson && (
        <CopyButton
          content={inputJson}
          label="Copy as JSON"
          position="top-right"
          iconOnly
        />
      )}

      {/* Tool Name Header */}
      <div className="flex items-center gap-3">
        <span className="text-warning-400 font-semibold text-base">
          {toolName || 'Unknown Tool'}
        </span>
        {toolId && (
          <span className="text-surface-500 text-xs font-mono bg-surface-800 px-2 py-0.5 rounded">
            {toolId}
          </span>
        )}
      </div>

      {/* Input Parameters - rendered as key-value pairs, not JSON */}
      {toolInput && Object.keys(toolInput).length > 0 && (
        <div className="space-y-2">
          <div className="border-t border-surface-700/50 pt-2">
            <PrettifiedObject data={toolInput} />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// THINKING BLOCK PRETTIFICATION
// ============================================================================

/**
 * Parse and render thinking blocks with XML-like tags styled nicely
 */
export function prettifyThinking(content: string): React.ReactNode {
  // Parse XML-like tags and render them with subtle styling
  const parts = parseXmlLikeTags(content);

  return (
    <div className="space-y-2 text-sm relative">
      <CopyButton
        content={content}
        label="Copy"
        position="top-right"
        iconOnly
      />
      {parts.map((part, index) => {
        // Create stable key from part type, tag name (if present), and content hash
        const contentKey = `${part.type}-${part.tagName || 'text'}-${index}-${part.content.slice(0, 50)}`;
        if (part.type === 'tag') {
          return (
            <div key={contentKey} className="relative pl-3 border-l-2 border-accent-500/30">
              <span className="absolute -left-0.5 top-0 text-accent-400/60 text-xs font-mono">
                {part.tagName}
              </span>
              <div className="pt-4 text-surface-300 whitespace-pre-wrap">
                {part.content}
              </div>
            </div>
          );
        }
        return (
          <div key={contentKey} className="text-surface-300 whitespace-pre-wrap">
            {part.content}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// SUMMARY PRETTIFICATION
// ============================================================================

/**
 * Format summary content as nicely styled text/markdown
 */
export function prettifySummary(content: string): React.ReactNode {
  return (
    <div className="text-surface-300 text-sm leading-relaxed prose prose-invert prose-sm max-w-none relative">
      <CopyButton
        content={content}
        label="Copy"
        position="top-right"
        iconOnly
      />
      {content}
    </div>
  );
}

// ============================================================================
// SYSTEM MESSAGE PRETTIFICATION
// ============================================================================

/**
 * Format system messages with appropriate styling
 */
export function prettifySystem(content: string): React.ReactNode {
  return (
    <div className="text-surface-300 text-sm leading-relaxed relative">
      <CopyButton
        content={content}
        label="Copy"
        position="top-right"
        iconOnly
      />
      {content}
    </div>
  );
}

// ============================================================================
// COLLAPSIBLE CODE BLOCK - For tool results with "Show more"
// ============================================================================

export function CollapsibleContent({
  content,
  maxLines = 50,
  isError = false,
  language
}: CollapsibleContentProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split('\n');
  const needsTruncation = lines.length > maxLines;

  const displayContent = expanded
    ? content
    : lines.slice(0, maxLines).join('\n');

  const contentClass = clsx(
    'text-sm font-mono whitespace-pre-wrap overflow-x-auto rounded-lg p-3',
    isError
      ? 'text-error-300 bg-error-500/10 border border-error-500/30'
      : 'text-surface-300 bg-surface-800/50 border border-surface-700'
  );

  // If we have a language hint, use syntax highlighting
  if (language && !isError) {
    return (
      <div className="space-y-2">
        <SyntaxHighlightedCode code={displayContent} language={language} />
        {needsTruncation && !expanded && (
          <TruncationButton
            onClick={() => setExpanded(true)}
            remaining={lines.length - maxLines}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <pre className={contentClass}>
        {displayContent}
      </pre>
      {needsTruncation && !expanded && (
        <TruncationButton
          onClick={() => setExpanded(true)}
          remaining={lines.length - maxLines}
        />
      )}
    </div>
  );
}

function TruncationButton({ onClick, remaining }: { onClick: () => void; remaining: number }) {
  return (
    <button
      onClick={onClick}
      className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1 transition-colors"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
      Show {remaining} more lines
    </button>
  );
}
