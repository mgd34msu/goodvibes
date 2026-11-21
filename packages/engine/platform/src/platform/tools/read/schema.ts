import type { ImageMode } from './media.js';

/**
 * JSON Schema definition for the `read` tool.
 *
 * The read tool accepts a list of files and returns their content (or a
 * transformed view of it) in one batched response.
 */
export const READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'Files to read. Processed as a batch in one call.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative or absolute path to the file.',
          },
          extract: {
            type: 'string',
            enum: ['content', 'outline', 'symbols', 'ast', 'lines'],
            description:
              'Extraction mode. Overrides the global extract for this file.'
              + ' content: full text; outline: signatures without bodies;'
              + ' symbols: exported names only; lines: specific line range;'
              + ' ast: the syntax tree from tree-sitter, each structural node (declarations, blocks) with its type, name and line range, indented by depth (falls back to a line-pattern outline, with a note saying why, when the file has no grammar).',
          },
          range: {
            type: 'object',
            description: 'Line range to read (1-based, inclusive). Used with extract=lines.',
            properties: {
              start: { type: 'integer', minimum: 1, description: 'First line to read, counting from 1.' },
              end: { type: 'integer', minimum: 1, description: 'Last line to read, included.' },
            },
            required: ['start', 'end'],
          },
          force: {
            type: 'boolean',
            description: 'Bypass cache and re-read the file from disk.',
          },
          force_text: {
            type: 'boolean',
            description: 'Read a file as UTF-8 text even though it contains a NUL byte (otherwise it is skipped as binary)'
              + ' or is not valid UTF-8 (otherwise it is refused); invalid bytes then show as U+FFFD and the file\'s result carries a warning.',
          },
          pages: {
            type: 'string',
            description: 'Accepted for PDF files but not applied: PDF text is returned for the whole document and labelled approximate, because page boundaries are not available.',
          },
          image_mode: {
            type: 'string',
            enum: ['default', 'unoptimized', 'metadata-only', 'thumbnail-only'],
            description:
              'Image handling mode. default: resize to 1568px max edge (token-efficient).'
              + ' unoptimized: full resolution. metadata-only: dimensions/format/size only, no image data.'
              + ' thumbnail-only: aggressive 256px resize for previews.',
          },
        },
        required: ['path'],
      },
      minItems: 1,
    },
    extract: {
      type: 'string',
      enum: ['content', 'outline', 'symbols', 'ast', 'lines'],
      description:
        'Global extraction mode applied to all files unless overridden per-file.'
        + ' Defaults to content.',
    },
    output: {
      type: 'object',
      description: 'Output formatting options.',
      properties: {
        format: {
          type: 'string',
          enum: ['count_only', 'minimal', 'standard', 'verbose'],
          description:
            'count_only: file count + totals; minimal: paths + line counts;'
            + ' standard: full content with line numbers (default);'
            + ' verbose: full content + metadata.',
        },
        include_line_numbers: {
          type: 'boolean',
          description: 'Include line numbers in content output. Default true.',
        },
        max_per_item: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum lines to return per file.',
        },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          description: 'Token cap across the entire response; use this to bound a read. Every file clipped by it is'
            + ' listed in summary.truncated; for content and lines extracts the entry gives next_start_line to continue from'
            + ' (extract=lines with range), and for other extracts (outline, symbols, ast, PDF, notebook, archive) it gives'
            + ' returned_characters, so read that file alone or with a larger max_tokens. Default: 25000 unless token_budget is set.',
        },
      },
    },
    token_budget: {
      type: 'integer',
      minimum: 1,
      description:
        'Splits a large multi-file batch into pages of whole files that fit the budget; fetch later pages with'
        + ' page=N (pagination.pending_files lists the rest). Use only for batches too large for one response;'
        + ' to cap one response use output.max_tokens. When omitted, the owner\'s tools.defaultTokenBudget setting applies if it is above 0.',
    },
    page: {
      type: 'integer',
      minimum: 1,
      description: 'Page number to return when using token_budget pagination. Default 1.',
    },
    image_mode: {
      type: 'string',
      enum: ['default', 'unoptimized', 'metadata-only', 'thumbnail-only'],
      description:
        'Global image handling mode. Per-file image_mode overrides this. Default: default.',
    },
    max_image_size: {
      type: 'integer',
      minimum: 1,
      description:
        'Maximum image file size in bytes. Images exceeding this return metadata only.'
        + ' Default: 5242880 (5MB).',
    },
  },
  required: ['files'],
} as const;

/** Extract mode for a single file or globally. */
export type ExtractMode = 'content' | 'outline' | 'symbols' | 'ast' | 'lines';

/** Output verbosity format. */
export type OutputFormat = 'count_only' | 'minimal' | 'standard' | 'verbose';

/** Input shape for a single file entry in the read tool. */
export interface ReadFileInput {
  path: string;
  extract?: ExtractMode | undefined;
  range?: { start: number; end: number };
  force?: boolean | undefined;
  /** Decode as UTF-8 text even when a NUL byte marks the file as binary. */
  force_text?: boolean | undefined;
  /** Accepted for PDF files but not applied; the whole document's text is returned and labelled approximate. */
  pages?: string | undefined;
  image_mode?: ImageMode | undefined;
}

/** Full input shape for the read tool. */
export interface ReadInput {
  files: ReadFileInput[];
  extract?: ExtractMode | undefined;
  output?: {
    format?: OutputFormat | undefined;
    include_line_numbers?: boolean | undefined;
    max_per_item?: number | undefined;
    max_tokens?: number | undefined;
  };
  token_budget?: number | undefined;
  page?: number | undefined;
  image_mode?: ImageMode | undefined;
  max_image_size?: number | undefined;
}
