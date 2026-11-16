import type { ToolDefinition } from '../../types/tools.js';

/**
 * JSON Schema for the find tool's input.
 * Supports three modes: files (glob), content (grep), symbols (regex-based extraction).
 */
export const findSchema: ToolDefinition = {
  name: 'find',
  // Sent in full on every model request (see ToolDefinition.core).
  core: true,
  description:
    'Search the codebase using glob patterns, regex content search, or symbol extraction. ' +
    'Supports multiple queries in one call. Modes: files (glob), content (grep), symbols (regex).',
  sideEffects: ['read_fs'],
  // Every mode searches under `path` (and reads `file` in references mode); globs match below it only.
  subjects: { paths: ['queries[].path', 'queries[].file'] },
  concurrency: 'parallel',
  supportsProgress: true,
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: 'One or more search queries to execute.',
        items: {
          type: 'object',
          required: ['id', 'mode'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for this query. Results are keyed by this id.',
            },
            mode: {
              type: 'string',
              enum: ['files', 'content', 'symbols', 'references', 'structural'],
              description: 'Search mode: files (glob), content (grep; files over 8 MiB are skipped and counted), symbols (declarations from the tree-sitter parser; a language without a grammar uses line patterns and a warning says so), references (the language server\'s answer when one is attached, an empty answer included, scoped to path; otherwise a word match on the symbol name with fallback_reason saying why), structural (AST pattern matching via ast-grep).',
            },
            // files mode
            patterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns (mode: files).',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns to exclude (mode: files).',
            },
            min_size: {
              type: 'integer',
              minimum: 0,
              description: 'Minimum file size in bytes (mode: files).',
            },
            max_size: {
              type: 'integer',
              minimum: 0,
              description: 'Maximum file size in bytes (mode: files).',
            },
            modified_after: {
              type: 'string',
              description: 'ISO date string, include only files modified after this date (mode: files).',
            },
            modified_before: {
              type: 'string',
              description: 'ISO date string, include only files modified before this date (mode: files).',
            },
            respect_gitignore: {
              type: 'boolean',
              description: 'Exclude files matched by .gitignore patterns (mode: files). Default: true. Note: only reads the project root .gitignore, nested .gitignore files are not applied.',
            },
            sort_by: {
              type: 'string',
              enum: ['name', 'size', 'modified'],
              description: 'Sort results by name, size, or modified date (mode: files). Default: name.',
            },
            sort_order: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort direction (mode: files). Default: asc.',
            },
            has_content: {
              type: 'string',
              description: 'Regex pattern, include only files whose content matches (mode: files).',
            },
            is_empty: {
              type: 'boolean',
              description: 'When true include only empty files; when false exclude empty files (mode: files).',
            },
            follow_symlinks: {
              type: 'boolean',
              description: 'Follow symbolic links when collecting files (mode: files). Default: false.',
            },
            include_hidden: {
              type: 'boolean',
              description: 'Include hidden files and directories (dot-prefixed) (mode: files). Default: false.',
            },
            // content mode
            pattern: {
              type: 'string',
              description: 'Regex search pattern (mode: content).',
            },
            pattern_base64: {
              type: 'string',
              description: 'Base64-encoded regex pattern, alternative to pattern (mode: content).',
            },
            glob: {
              type: 'string',
              description: 'File filter glob pattern (mode: content).',
            },
            path: {
              type: 'string',
              description: 'Directory to search (modes: files, content, symbols, references, structural). Defaults to project root.',
            },
            case_sensitive: {
              type: 'boolean',
              description: 'Case-sensitive matching (mode: content). Default: true.',
            },
            whole_word: {
              type: 'boolean',
              description: 'Match whole words only (mode: content).',
            },
            multiline: {
              type: 'boolean',
              description: 'No effect: content mode matches each line on its own, so a pattern cannot span lines (the call warns when this is set). Search for one line of the text instead.',
            },
            negate: {
              type: 'boolean',
              description: 'Return files that do NOT match the pattern (mode: content).',
            },
            ranked: {
              type: 'boolean',
              description:
                'Sort results by relevance (mode: content). Each matched file is judged against the pattern; files where what the pattern names is defined, declared, exported or implemented come first, files that only mention it come after. Every match is still returned.',
            },
            preview_replace: {
              type: 'string',
              description:
                'Replacement string (mode: content). When provided, shows what each matched line would look like after replacement WITHOUT writing to disk. Adds original and replaced fields to each match.',
            },
            relationships: {
              type: 'boolean',
              description:
                'Include import/export relationships (mode: content). For each matched file, shows which files import it and which files it imports.',
            },
            // references mode
            symbol: {
              type: 'string',
              description: 'Symbol name to search for references to (mode: references).',
            },
            file: {
              type: 'string',
              description: 'File path containing the symbol (mode: references).',
            },
            line: {
              type: 'integer',
              minimum: 1,
              description: 'One-based line number of the symbol, as find results report lines (mode: references).',
            },
            column: {
              type: 'integer',
              minimum: 0,
              description: 'Zero-based column offset of the symbol on that line (mode: references). Used only by a language server.',
            },
            // symbols mode
            query: {
              type: 'string',
              description: 'Symbol name pattern to filter by (mode: symbols).',
            },
            kinds: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['function', 'class', 'interface', 'type', 'variable', 'constant', 'enum'],
              },
              description: 'Symbol kinds to include (mode: symbols).',
            },
            exported_only: {
              type: 'boolean',
              description: 'Only return exported symbols (mode: symbols). Default: false.',
            },
            include_private: {
              type: 'boolean',
              description:
                'Include non-exported (private) symbols (mode: symbols). When true, overrides exported_only and includes all symbols regardless of export status.',
            },
            group_by: {
              type: 'string',
              enum: ['file', 'kind', 'none'],
              description: 'Group symbol results (mode: symbols). file: group by file path, kind: group by symbol kind, none: flat list (default).',
            },
            // structural mode
            lang: {
              type: 'string',
              enum: ['ts', 'tsx', 'js', 'jsx', 'css', 'html'],
              description:
                'Language for AST parsing (mode: structural). Omitted: each file is parsed by its extension. ' +
                'Set without glob: only files with this language\'s extensions are searched. Set with glob: every file the glob names is parsed as this language. ' +
                'Supported: ts, tsx, js, jsx, css, html. Files with other extensions are skipped and counted.',
            },
          },
        },
        minItems: 1,
      },
      output: {
        type: 'object',
        description: 'Output format options.',
        properties: {
          format: {
            type: 'string',
            enum: ['count_only', 'files_only', 'locations', 'matches', 'context', 'with_stats', 'with_preview', 'signatures', 'full'],
            description:
              'Progressive disclosure format. count_only < files_only < locations < matches < context. ' +
              'The format is shared by every query of the call; a format that does not belong to a query\'s mode is replaced by the nearest one for that mode and the result warns. ' +
              'with_stats returns file size and modified date per file (mode: files). ' +
              'with_preview returns first N lines of each file (mode: files, controlled by preview_lines). ' +
              'signatures: include full function/method signature with params+return type (mode: symbols). ' +
              'full: include signature + JSDoc comment + container class/namespace (mode: symbols).',
          },
          preview_lines: {
            type: 'integer',
            minimum: 1,
            description: 'Number of lines to include in preview (format: with_preview). Default: 3.',
          },
          context_before: {
            type: 'integer',
            minimum: 0,
            description: 'Lines before each match (format: context).',
          },
          context_after: {
            type: 'integer',
            minimum: 0,
            description: 'Lines after each match (format: context).',
          },
          expand_to: {
            type: 'string',
            enum: ['line', 'block', 'function', 'class'],
            description:
              'Expand each content match to its enclosing scope. ' +
              "'function' expands to the enclosing function/method, 'class' to the enclosing class. " +
              'Adds startLine and endLine fields to each match. ' +
              'Requires tree-sitter grammar for the file language; results remain unexpanded when unavailable. ' +
              "'line' and 'block' are accepted but currently behave the same as no expansion.",
          },
          offset: {
            type: 'integer', minimum: 0,
            description: 'Zero-based result offset for pagination. Use next_offset from the previous page.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            description: 'Results per page, at least 1. Default: 100. Searches all eligible files and reports the full count and next_offset.',
          },
          max_per_item: {
            type: 'integer',
            minimum: 0,
            description: 'Optional per-file display limit. By default all matches are eligible for pagination.',
          },
          max_total_matches: {
            type: 'integer',
            minimum: 1,
            description: 'Matches per page across all files. Default: 100. Does not stop the search scan.',
          },
          max_tokens: {
            type: 'integer',
            minimum: 0,
            description: 'Approximate token budget for the whole call\'s results (about 4 characters per token), shared equally among its queries. '
              + 'A page that would exceed its share is shortened; continue with next_offset. Default: about 10,000 tokens per query, less when several queries share the call.',
          },
          max_line_length: {
            type: 'integer',
            minimum: 1,
            description: 'Truncate matched lines longer than this value (mode: content). Adds "..." suffix when truncated.',
          },
        },
      },
      parallel: {
        type: 'boolean',
        description: 'Execute queries concurrently. Default: true.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1,
        description: 'Deadline for the whole call. A query still running then returns timed_out with no results '
          + 'while finished queries keep theirs. Default: 60000.',
      },
    },
    required: ['queries'],
  },
};
