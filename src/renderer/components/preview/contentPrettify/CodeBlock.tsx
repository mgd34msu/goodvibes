// ============================================================================
// SYNTAX HIGHLIGHTED CODE COMPONENT
// ============================================================================

import React, { useState } from 'react';
import { hljs } from './hljs-config';
import { escapeHtml, getLanguageDisplayLabel } from './utils';
import type { SyntaxHighlightedCodeProps } from './types';

export function SyntaxHighlightedCode({
  code,
  language,
  showLineNumbers = false,
  copyLabel
}: SyntaxHighlightedCodeProps) {
  const [copied, setCopied] = useState(false);

  // Highlight the code
  let highlighted: string;
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(code, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch {
    highlighted = escapeHtml(code);
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Determine the display label - use custom label or generate from language
  const displayLabel = copyLabel || getLanguageDisplayLabel(language);

  const lines = highlighted.split('\n');

  return (
    <div className="relative group rounded-lg overflow-hidden bg-surface-950 border border-surface-700">
      {/* Header */}
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
              {displayLabel}
            </>
          )}
        </button>
      </div>

      {/* Code */}
      <div className="overflow-x-auto">
        <pre className="p-3">
          {showLineNumbers ? (
            <code className="text-sm font-mono">
              {lines.map((line, i) => (
                <div key={i} className="flex">
                  <span className="select-none text-surface-500 text-right pr-4 min-w-[3rem]">
                    {i + 1}
                  </span>
                  <span
                    className="flex-1"
                    dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }}
                  />
                </div>
              ))}
            </code>
          ) : (
            <code
              className="text-sm font-mono text-surface-200 hljs"
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </pre>
      </div>
    </div>
  );
}
