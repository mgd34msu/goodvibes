// ============================================================================
// CONTENT PRETTIFICATION UTILITIES
// Transforms raw content into beautifully formatted React components
// ============================================================================

// Re-export types
export type {
  PrettifiedObjectProps,
  SyntaxHighlightedCodeProps,
  CollapsibleContentProps,
  ParsedPart,
} from './types';

// Re-export utility functions
export {
  parseJSONSafe,
  extractClaudeContentBlocks,
  detectLanguage,
  detectLanguageFromContent,
  getLanguageDisplayLabel,
  getCopyLabel,
  parseXmlLikeTags,
  stripAnsiCodes,
  parseXMLTagContent,
  escapeHtml,
} from './utils';

// Re-export components
export { SyntaxHighlightedCode } from './CodeBlock';
export { ToolResultMarkdownRenderer } from './MarkdownRenderer';
export { prettifyJSON, PrettifiedObject } from './JsonViewer';
export { XMLTagValue, XMLTagsPrettified } from './XMLTagsViewer';
export { ToolResultPrettified, TruncationButton } from './ToolResultPrettified';
export {
  prettifyToolUse,
  prettifyThinking,
  prettifySummary,
  prettifySystem,
  CollapsibleContent,
} from './prettifiers';

// Re-export hljs for consumers that need it
export { hljs } from './hljs-config';
