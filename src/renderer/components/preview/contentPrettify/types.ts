// ============================================================================
// CONTENT PRETTIFICATION TYPES
// ============================================================================

export interface PrettifiedObjectProps {
  data: unknown;
  indent?: number;
}

export interface SyntaxHighlightedCodeProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  /** Custom copy label like "Copy as JSON" or "Copy as TypeScript" */
  copyLabel?: string;
}

export interface CollapsibleContentProps {
  content: string;
  maxLines?: number;
  isError?: boolean;
  language?: string | null;
}

export interface ParsedPart {
  type: 'text' | 'tag';
  content: string;
  tagName?: string;
}
