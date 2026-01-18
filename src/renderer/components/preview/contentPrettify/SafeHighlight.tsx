// ============================================================================
// SAFE SYNTAX HIGHLIGHTING
// Converts highlight.js HTML output to React elements without dangerouslySetInnerHTML
// ============================================================================

import React from 'react';

/**
 * Parse highlight.js HTML output into React elements safely.
 *
 * highlight.js produces HTML that only contains:
 * - Plain text (properly escaped)
 * - <span class="hljs-*">...</span> elements
 *
 * This parser only allows these patterns, rejecting any other HTML.
 */
export function parseHighlightedCode(html: string): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let currentIndex = 0;
  let keyCounter = 0;

  // Regex to match hljs span tags: <span class="hljs-something">content</span>
  // We use a non-greedy match and handle nesting by recursion
  const spanRegex = /<span class="(hljs-[\w-]+)">([\s\S]*?)<\/span>/g;

  function parseSegment(text: string): React.ReactNode[] {
    const result: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    // Reset regex state
    spanRegex.lastIndex = 0;

    while ((match = spanRegex.exec(text)) !== null) {
      // Add text before this match
      if (match.index > lastIndex) {
        const textBefore = text.slice(lastIndex, match.index);
        if (textBefore) {
          result.push(decodeHtmlEntities(textBefore));
        }
      }

      const className = match[1] ?? '';
      const content = match[2] ?? '';

      // Recursively parse nested spans
      const children = parseSegment(content);

      result.push(
        <span key={keyCounter++} className={className}>
          {children}
        </span>
      );

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex);
      if (remaining) {
        result.push(decodeHtmlEntities(remaining));
      }
    }

    return result;
  }

  // Parse the entire HTML
  let match: RegExpExecArray | null;
  spanRegex.lastIndex = 0;

  while ((match = spanRegex.exec(html)) !== null) {
    // Add text before this match
    if (match.index > currentIndex) {
      const textBefore = html.slice(currentIndex, match.index);
      if (textBefore) {
        elements.push(decodeHtmlEntities(textBefore));
      }
    }

    const className = match[1] ?? '';
    const content = match[2] ?? '';

    // Recursively parse nested spans
    const children = parseSegment(content);

    elements.push(
      <span key={keyCounter++} className={className}>
        {children}
      </span>
    );

    currentIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (currentIndex < html.length) {
    const remaining = html.slice(currentIndex);
    if (remaining) {
      elements.push(decodeHtmlEntities(remaining));
    }
  }

  return elements;
}

/**
 * Decode HTML entities that highlight.js uses for escaping.
 * Only handles the standard entities that hljs produces.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, '\u00A0');
}

/**
 * Split highlighted HTML into lines while preserving span structure.
 * Returns React elements for each line.
 */
export function splitHighlightedLines(html: string): React.ReactNode[][] {
  // Split by newlines, but we need to be careful about spans that span lines
  const lines = html.split('\n');
  return lines.map((line) => {
    if (!line) {
      // Empty line - return non-breaking space to maintain line height
      return ['\u00A0'];
    }
    return parseHighlightedCode(line);
  });
}
