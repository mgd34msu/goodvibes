// ============================================================================
// CONTENT PRETTIFICATION UTILITIES
// Helper functions for content detection, parsing, and formatting
// ============================================================================

import type { ParsedPart } from './types';

// ============================================================================
// JSON UTILITIES
// ============================================================================

/**
 * Detect if a string is valid JSON and return the parsed object
 * Returns null if not valid JSON
 */
export function parseJSONSafe(content: string): unknown | null {
  try {
    const trimmed = content.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      return JSON.parse(trimmed);
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Detect if content is a Claude content block array (array of {type: "text", text: "..."} objects)
 * Returns the concatenated text if it is, null otherwise
 */
export function extractClaudeContentBlocks(content: string): string | null {
  try {
    const trimmed = content.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every((block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            (block as { type: string }).type === 'text' &&
            'text' in block &&
            typeof (block as { text: unknown }).text === 'string'
          )) {
        // Concatenate all text blocks
        return parsed.map((block: { text: string }) => block.text).join('\n\n');
      }
    }
  } catch {
    // Not valid JSON or not the expected format
  }
  return null;
}

// ============================================================================
// CODE DETECTION & LANGUAGE HELPERS
// ============================================================================

/**
 * Detect programming language from content and optional hints
 */
export function detectLanguage(content: string, hint?: string): string | null {
  // Check hint first (e.g., tool name like "Read" often returns file content)
  if (hint) {
    const hintLower = hint.toLowerCase();
    if (hintLower.includes('read') || hintLower.includes('write')) {
      // Try to detect from content
      return detectLanguageFromContent(content);
    }
  }

  return detectLanguageFromContent(content);
}

export function detectLanguageFromContent(content: string): string | null {
  const trimmed = content.trim();

  // File path hints in first line (e.g., "1 -> export function...")
  const firstLine = trimmed.split('\n')[0];

  // Check for common file content patterns

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
  if (/^#!\/bin\/(bash|sh|zsh)/.test(trimmed) ||
      /^\$\s/.test(firstLine || '')) {
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

  // YAML
  if (/^[\w-]+:\s/.test(trimmed) && !trimmed.includes('{')) {
    return 'yaml';
  }

  // JSON (already handled elsewhere, but as fallback)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON
    }
  }

  // XML
  if (/^<\?xml/.test(trimmed) || /^<[\w-]+\s*xmlns/.test(trimmed)) {
    return 'xml';
  }

  // Markdown (common patterns)
  if (/^#{1,6}\s/.test(trimmed) || /^\*\*.*\*\*/.test(trimmed)) {
    return 'markdown';
  }

  return null;
}

/**
 * Get a human-readable display label for the language
 */
export function getLanguageDisplayLabel(language: string | null): string {
  if (!language) return 'Copy';

  const languageLabels: Record<string, string> = {
    javascript: 'Copy as JavaScript',
    typescript: 'Copy as TypeScript',
    python: 'Copy as Python',
    rust: 'Copy as Rust',
    go: 'Copy as Go',
    bash: 'Copy as Bash',
    html: 'Copy as HTML',
    xml: 'Copy as XML',
    css: 'Copy as CSS',
    sql: 'Copy as SQL',
    json: 'Copy as JSON',
    yaml: 'Copy as YAML',
    markdown: 'Copy as Markdown',
  };

  return languageLabels[language] || 'Copy';
}

/**
 * Get the appropriate copy label based on content and detected language
 */
export function getCopyLabel(content: string, detectedLanguage: string | null): string {
  // If we have a detected language, use it
  if (detectedLanguage) {
    return getLanguageDisplayLabel(detectedLanguage);
  }

  // Check if content is JSON
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'Copy as JSON';
    } catch {
      // Not valid JSON
    }
  }

  return 'Copy';
}

// ============================================================================
// XML TAG PARSING
// ============================================================================

export function parseXmlLikeTags(content: string): ParsedPart[] {
  const parts: ParsedPart[] = [];

  // Match XML-like tags: <tagname>content</tagname>
  const tagRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    // Add text before the tag
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index).trim();
      if (textBefore) {
        parts.push({ type: 'text', content: textBefore });
      }
    }

    // Add the tag content
    parts.push({
      type: 'tag',
      tagName: match[1] || '',
      content: (match[2] || '').trim(),
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      parts.push({ type: 'text', content: remaining });
    }
  }

  // If no tags found, return the whole content as text
  if (parts.length === 0) {
    parts.push({ type: 'text', content: content });
  }

  return parts;
}

/**
 * Strip ANSI escape codes from a string
 */
export function stripAnsiCodes(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Parse XML-like tag content into key-value pairs
 * Matches patterns like: <tag_name>content</tag_name>
 *
 * @returns Object with parsed key-value pairs and a flag indicating if any tags were found
 */
export function parseXMLTagContent(content: string): { parsed: Record<string, string>; hasXMLTags: boolean } {
  // Match tags like <word-word> or <word_word> with closing tag
  const tagPattern = /<([\w][\w-]*)>([\s\S]*?)<\/\1>/g;
  const result: Record<string, string> = {};
  let match;
  let foundAny = false;

  while ((match = tagPattern.exec(content)) !== null) {
    foundAny = true;
    const [, matchedTagName, tagContent] = match;
    if (matchedTagName && tagContent !== undefined) {
      result[matchedTagName] = tagContent.trim();
    }
  }

  // Only return hasXMLTags: true if we found multiple tags or the content
  // looks like it's primarily XML-tag based (not just one accidental tag in prose)
  const tagCount = Object.keys(result).length;
  const isXMLTagContent = tagCount >= 2 ||
    (tagCount === 1 && content.trim().startsWith('<'));

  return { parsed: result, hasXMLTags: isXMLTagContent && foundAny };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
