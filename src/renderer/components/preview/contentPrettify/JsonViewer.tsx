// ============================================================================
// JSON VIEWER COMPONENTS
// Renders objects/arrays as formatted key-value pairs instead of JSON
// ============================================================================

import React from 'react';
import { SyntaxHighlightedCode } from './CodeBlock';
import type { PrettifiedObjectProps } from './types';

/**
 * Detect if a string is valid JSON and prettify it with syntax highlighting
 * Used for assistant/thinking blocks where JSON should be displayed as JSON
 */
export function prettifyJSON(content: string): React.ReactNode {
  // Try to parse as JSON
  try {
    const trimmed = content.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = JSON.parse(trimmed);
      const formatted = JSON.stringify(parsed, null, 2);
      return <SyntaxHighlightedCode code={formatted} language="json" />;
    }
  } catch {
    // Not valid JSON, return as-is
  }
  return null;
}

/**
 * Recursively render an object as key-value pairs
 * - Strings: just the value
 * - Numbers/booleans: styled value
 * - Arrays: bulleted list or inline for simple arrays
 * - Objects: nested with indent
 */
export function PrettifiedObject({ data, indent = 0 }: PrettifiedObjectProps): React.ReactElement {
  const indentPx = indent * 16;

  // Handle null/undefined
  if (data === null || data === undefined) {
    return (
      <span className="text-surface-500 text-sm italic">
        {data === null ? 'null' : 'undefined'}
      </span>
    );
  }

  // Handle primitives
  if (typeof data === 'string') {
    // Check if it's a long multi-line string
    if (data.includes('\n') && data.length > 100) {
      return (
        <pre className="text-surface-300 text-sm font-mono whitespace-pre-wrap bg-surface-800/30 rounded px-2 py-1 mt-1">
          {data}
        </pre>
      );
    }
    return <span className="text-surface-300 text-sm">{data}</span>;
  }

  if (typeof data === 'number') {
    return <span className="text-info-400 text-sm">{data}</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="text-amber-400 text-sm">{data ? 'true' : 'false'}</span>;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    // Empty array
    if (data.length === 0) {
      return <span className="text-surface-500 text-sm italic">[]</span>;
    }

    // Simple array of primitives - show inline
    const allPrimitives = data.every(
      item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    );

    if (allPrimitives && data.length <= 5) {
      return (
        <span className="text-surface-300 text-sm">
          {data.map((item, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-surface-500">, </span>}
              <PrettifiedObject data={item} indent={indent} />
            </React.Fragment>
          ))}
        </span>
      );
    }

    // Complex array - show as list
    return (
      <div style={{ marginLeft: indentPx > 0 ? 8 : 0 }}>
        {data.map((item, i) => (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="text-surface-500 select-none">-</span>
            <div className="flex-1">
              <PrettifiedObject data={item} indent={indent + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Handle objects
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);

    // Empty object
    if (entries.length === 0) {
      return <span className="text-surface-500 text-sm italic">{'{}'}</span>;
    }

    return (
      <div style={{ marginLeft: indentPx > 0 ? 8 : 0 }}>
        {entries.map(([key, value]) => {
          const isComplexValue =
            typeof value === 'object' &&
            value !== null &&
            (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);

          return (
            <div key={key} className="py-0.5">
              {/* Use items-baseline for proper vertical alignment of key-value pairs */}
              <div className="flex items-baseline gap-2">
                <span className="text-surface-400 font-mono text-sm shrink-0">{key}:</span>
                {!isComplexValue && (
                  <div className="flex-1">
                    <PrettifiedObject data={value} indent={indent + 1} />
                  </div>
                )}
              </div>
              {isComplexValue && (
                <div className="mt-0.5">
                  <PrettifiedObject data={value} indent={indent + 1} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback for unknown types
  return <span className="text-surface-300 text-sm">{String(data)}</span>;
}
