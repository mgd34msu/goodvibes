// ============================================================================
// XML TAGS VIEWER COMPONENTS
// Renders XML-like tag content as prettified key-value pairs
// ============================================================================

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { stripAnsiCodes } from './utils';

/**
 * Component to render a single XML tag value
 * Handles multi-line content, ANSI codes, and special formatting
 */
export function XMLTagValue({ value }: { value: string; tagName?: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const MAX_LINES = 10;

  // Strip ANSI codes for display
  const cleanValue = stripAnsiCodes(value);
  const lines = cleanValue.split('\n');
  const isMultiLine = lines.length > 1;
  const needsTruncation = lines.length > MAX_LINES;

  // Empty value
  if (!cleanValue || cleanValue.length === 0) {
    return <span className="text-surface-500 text-sm italic">(empty)</span>;
  }

  // Single line value
  if (!isMultiLine) {
    return <span className="text-surface-300 text-sm">{cleanValue}</span>;
  }

  // Multi-line value - render as code block
  const displayContent = expanded ? cleanValue : lines.slice(0, MAX_LINES).join('\n');

  return (
    <div className="mt-1 space-y-1">
      <pre className="text-surface-300 text-sm font-mono whitespace-pre-wrap bg-surface-800/50 border border-surface-700 rounded-lg p-2 overflow-x-auto max-h-[300px] overflow-y-auto">
        {displayContent}
      </pre>
      {needsTruncation && !expanded && (
        <button
          onClick={() => setExpanded(true)}
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

/**
 * Component to render parsed XML tags as prettified key-value pairs
 */
export function XMLTagsPrettified({ data }: { data: Record<string, string> }): React.ReactElement {
  const entries = Object.entries(data);

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => {
        const cleanValue = stripAnsiCodes(value);
        const isMultiLine = cleanValue.includes('\n');

        return (
          <div key={key} className="py-0.5">
            <div className={clsx(
              "flex gap-2",
              isMultiLine ? "flex-col" : "items-baseline"
            )}>
              <span className="text-surface-400 font-mono text-sm shrink-0">{key}:</span>
              {!isMultiLine && (
                <div className="flex-1">
                  <XMLTagValue value={value} tagName={key} />
                </div>
              )}
            </div>
            {isMultiLine && (
              <XMLTagValue value={value} tagName={key} />
            )}
          </div>
        );
      })}
    </div>
  );
}
