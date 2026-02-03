// ============================================================================
// TOOL RESULT PRETTIFICATION COMPONENT
// Renders tool results with truncation and syntax highlighting
// ============================================================================

import React, { useState } from 'react';
import { CopyButton } from '../../common/CopyButton';
import { SyntaxHighlightedCode } from './CodeBlock';
import { ToolResultMarkdownRenderer } from '../../common/MarkdownRenderer';
import { PrettifiedObject } from './JsonViewer';
import { XMLTagsPrettified } from './XMLTagsViewer';
import {
  detectLanguage,
  getCopyLabel,
  parseJSONSafe,
  parseXMLTagContent,
  extractClaudeContentBlocks,
} from './utils';

interface ToolResultPrettifiedProps {
  content: string;
  isError?: boolean;
  toolName?: string;
}

/**
 * Tool Result Component - renders tool results with truncation and syntax highlighting
 * This is a proper React component since it needs state for truncation
 */
export function ToolResultPrettified({
  content,
  isError,
  toolName
}: ToolResultPrettifiedProps): React.ReactElement {
  const MAX_LINES = 50;
  const lines = content.split('\n');
  const needsTruncation = lines.length > MAX_LINES;
  const [showFull, setShowFull] = useState(false);

  const displayContent = showFull ? content : lines.slice(0, MAX_LINES).join('\n');
  const isTruncated = needsTruncation && !showFull;

  // Detect language for copy label
  const language = detectLanguage(content, toolName);
  const copyLabel = getCopyLabel(content, language);

  // If error, show in red styling
  if (isError) {
    return (
      <div className="space-y-2 relative">
        <CopyButton
          content={content}
          label={copyLabel}
          position="top-right"
          iconOnly
        />
        <div className="flex items-center gap-2">
          <span className="text-error-400 text-xs font-semibold uppercase tracking-wide">Error</span>
        </div>
        <pre className="text-error-300 text-sm font-mono whitespace-pre-wrap bg-error-500/10 border border-error-500/30 rounded-lg p-3">
          {displayContent}
        </pre>
        {isTruncated && (
          <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
        )}
      </div>
    );
  }

  // Check if content is XML-like tag-based content (e.g., <status>running</status>)
  // This should be rendered as key-value pairs
  const { parsed: xmlTagData, hasXMLTags } = parseXMLTagContent(displayContent);
  if (hasXMLTags) {
    return (
      <div className="space-y-2 relative">
        <CopyButton
          content={content}
          label="Copy"
          position="top-right"
          iconOnly
        />
        <div className="bg-surface-800/30 border border-surface-700/50 rounded-lg p-3">
          <XMLTagsPrettified data={xmlTagData} />
        </div>
        {isTruncated && (
          <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
        )}
      </div>
    );
  }

  // Check if content is Claude content block array (array of {type: "text", text: "..."})
  // This should be rendered as markdown, not as JSON
  const extractedMarkdown = extractClaudeContentBlocks(displayContent);
  if (extractedMarkdown !== null) {
    return (
      <div className="space-y-2 relative">
        <CopyButton
          content={extractedMarkdown}
          label="Copy"
          position="top-right"
          iconOnly
        />
        <div className="text-surface-200">
          <ToolResultMarkdownRenderer content={extractedMarkdown} />
        </div>
        {isTruncated && (
          <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
        )}
      </div>
    );
  }

  // If it looks like code (but NOT JSON), syntax highlight it
  // JSON tool results should be shown as key-value pairs, not code blocks
  if (language && language !== 'json') {
    // If it's markdown, render it as markdown instead of code
    if (language === 'markdown') {
      return (
        <div className="space-y-2 relative">
          <CopyButton
            content={content}
            label="Copy"
            position="top-right"
            iconOnly
          />
          <div className="text-surface-200">
            <ToolResultMarkdownRenderer content={displayContent} />
          </div>
          {isTruncated && (
            <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
          )}
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <SyntaxHighlightedCode code={displayContent} language={language} copyLabel={copyLabel} />
        {isTruncated && (
          <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
        )}
      </div>
    );
  }

  // Check if content is JSON - show as formatted key-value pairs, not JSON code block
  const parsedJson = parseJSONSafe(displayContent);
  if (parsedJson !== null) {
    return (
      <div className="space-y-2 relative">
        <CopyButton
          content={content}
          label="Copy as JSON"
          position="top-right"
          iconOnly
        />
        <div className="bg-surface-800/30 border border-surface-700/50 rounded-lg p-3">
          <PrettifiedObject data={parsedJson} />
        </div>
        {isTruncated && (
          <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
        )}
      </div>
    );
  }

  // Default: formatted monospace text with copy button
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
        <TruncationButton onClick={() => setShowFull(true)} remaining={lines.length - MAX_LINES} />
      )}
    </div>
  );
}

export function TruncationButton({ onClick, remaining }: { onClick: () => void; remaining: number }) {
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
