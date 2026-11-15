/** JSON Schema definition for the edit tool input. */
export const editSchema = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        // find/replace may each be sent as plain text or base64; the executor checks that one is present and non-empty.
        required: ['path'],
        properties: {
          path: {
            type: 'string',
            description: 'File path to edit (relative to project root or absolute within it)',
          },
          find: {
            type: 'string',
            description: 'Text to find in the file. Required unless find_base64 is sent; must not be empty.',
          },
          find_base64: {
            type: 'string',
            description: 'Base64-encoded text to find, used instead of find for binary-safe transport. Send one of find or find_base64; if both are sent they must decode to the same text.',
          },
          replace: {
            type: 'string',
            description: 'Replacement text. Required unless replace_base64 is sent; an empty string deletes the match.',
          },
          replace_base64: {
            type: 'string',
            description: 'Base64-encoded replacement text, used instead of replace for binary-safe transport. Send one of replace or replace_base64; if both are sent they must decode to the same text.',
          },
          id: {
            type: 'string',
            description: 'Optional identifier for this edit, used in result tracking',
          },
          occurrence: {
            // anyOf, not oneOf: strict OpenAI-compatible request validators
            // (RouteLLM among them) forbid the oneOf keyword inside tool
            // parameter schemas and 400 the whole chat request. The branches
            // are disjoint types, so anyOf validates identically, and it is
            // the keyword OpenAI's own function-calling schemas use.
            anyOf: [
              {
                type: 'string',
                enum: ['first', 'last', 'all'],
                description: 'Which occurrence to replace: first, last, or all',
              },
              {
                type: 'integer',
                minimum: 1,
                description: 'Replace the Nth occurrence (1-based)',
              },
            ],
            description:
              'Which occurrence to replace. Default: error if 0 or 2+ matches (ambiguity guard). ' +
              'Set to first/last/all/N to override.',
          },
          hints: {
            type: 'object',
            properties: {
              near_line: {
                type: 'integer',
                minimum: 1,
                description: 'Prefer the occurrence closest to this line number',
              },
              in_function: {
                type: 'string',
                description: 'Only match within a function with this name',
              },
              in_class: {
                type: 'string',
                description: 'Only match within a class with this name',
              },
              after: {
                type: 'string',
                description: 'Only match occurrences that appear after this text anchor in the file',
              },
              before: {
                type: 'string',
                description: 'Only match occurrences that appear before this text anchor in the file',
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    match: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['exact', 'fuzzy', 'regex', 'ast', 'ast_pattern'],
          description:
            'Match mode. exact: literal string match (whitespace differences are tolerated); text not in the file fails at once with the closest lines to copy. fuzzy: whitespace-insensitive, and when nothing matches the single closest run of lines is applied if a decision-model check reads it as the intended code. regex: treat find as regex. ' +
            'ast: structural match using tree-sitter; if unavailable, exact fallback is reported as a warning. ' +
            'ast_pattern: pattern matching using @ast-grep/napi metavariables like $VAR or $$$ARGS; if unavailable, exact fallback is reported as a warning.',
          default: 'exact',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether matching is case-sensitive. Default: true.',
          default: true,
        },
        whitespace_sensitive: {
          type: 'boolean',
          description: 'Whether whitespace differences matter. When false in exact mode, delegates to fuzzy matching algorithm. Default: true.',
          default: true,
        },
        multiline: {
          type: 'boolean',
          description:
            'When true and mode is regex, adds the s (dotAll) and m (multiline) flags. ' +
            's flag: . matches newlines, enabling patterns that span multiple lines. ' +
            'm flag: ^ and $ match at line boundaries. Default: false.',
          default: false,
        },
      },
      additionalProperties: false,
    },
    transaction: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['atomic', 'partial', 'none'],
          description:
            'atomic: all edits succeed or all fail (default). ' +
            'partial: apply succeeding edits, report failures, roll nothing back. ' +
            'none: older name for partial.',
          default: 'atomic',
        },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['count_only', 'minimal', 'with_diff', 'verbose'],
          description:
            'count_only: only total edits applied. ' +
            'minimal: per-edit success/failure summary (default). ' +
            'with_diff: include unified diff per edit. ' +
            'verbose: untruncated diffs plus each changed file\'s content before and after (20,000 characters each, longer content says how much was left out). ' +
            'Results include status field: applied | not_found | ambiguous | conflict | failed, decided by the matcher that refused the edit. ' +
            'Failed results include hint field with actionable suggestions (count_only lists failed edits by path and status).',
          default: 'minimal',
        },
        diff_context: {
          type: 'integer',
          minimum: 0,
          description:
            'Number of context lines to include around each change in unified diffs. Default: 3. ' +
            'Reduce to 0 for minimal diffs, increase for more context.',
          default: 3,
        },
      },
      additionalProperties: false,
    },
    dry_run: {
      type: 'boolean',
      description: 'Compute all replacements and return diffs without writing to disk. Default: false.',
      default: false,
    },
    validate: {
      type: 'object',
      description: 'Run validators (fixed project commands) before and/or after applying edits. They run through the exec tool\'s path, under the same sandbox, containment and credential rules as an exec command; a session without one refuses validate.',
      properties: {
        before: {
          type: 'array',
          description: 'Validators to run before applying edits. If any fail, edits are not applied.',
          items: {
            type: 'string',
            enum: ['typecheck', 'lint', 'test', 'build'],
          },
        },
        after: {
          type: 'array',
          description: 'Validators to run after applying edits. If any fail in atomic mode, edits are rolled back.',
          items: {
            type: 'string',
            enum: ['typecheck', 'lint', 'test', 'build'],
          },
        },
      },
      additionalProperties: false,
    },
    notebook_operations: {
      type: 'object',
      description:
        'Jupyter notebook (.ipynb) cell operations. Alternative to edits, provide either edits or notebook_operations, not both. ' +
        'match, transaction and validate do not apply to notebook operations and are refused when sent with them.',
      properties: {
        path: { type: 'string', description: 'Path to .ipynb notebook file' },
        operations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['op'],
            properties: {
              op: {
                type: 'string',
                enum: ['replace', 'insert', 'delete'],
                description: 'Cell operation: replace existing cell content, insert a new cell, or delete a cell. Any other op is refused by name and nothing is written.',
              },
              cell: {
                type: 'integer',
                minimum: 0,
                description:
                  '0-based cell index in the notebook as it was before any operation of this call (used by replace/delete when cell_id is not provided). Inserts and deletes earlier in the same call do not renumber it.',
              },
              cell_id: {
                type: 'string',
                description: 'Cell ID targeting, takes precedence over cell index for all operations',
              },
              after: {
                type: 'integer',
                minimum: -1,
                description: 'For insert: insert after this 0-based index, numbered as before any operation of this call (-1 = insert at beginning). Omit to append at end.',
              },
              source: {
                type: 'string',
                description: 'Cell source content (required for replace and insert operations)',
              },
              cell_type: {
                type: 'string',
                enum: ['code', 'markdown', 'raw'],
                description:
                  'Cell type (required for insert; optional for replace, if provided, changes the cell type)',
              },
              clear_outputs: {
                type: 'boolean',
                description: 'Clear cell outputs on replace (default: false)',
              },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'operations'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;
