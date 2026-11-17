/** Encodings `content` may be written in. `content` is text, so hex and base64 (which re-read it as encoded bytes) are not among them: send bytes as `content_base64`. */
export const WRITE_TEXT_ENCODINGS = ['utf-8', 'utf8', 'ascii', 'latin1', 'binary'] as const;

/**
 * JSON Schema definition for the write tool input.
 */
export const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'Array of files to write.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write, relative to project root or absolute.',
          },
          content: {
            type: 'string',
            description: 'Text file content to write. Exactly one of content or content_base64 is required (content may be an empty string), except with mode restore, which takes neither.',
          },
          content_base64: {
            type: 'string',
            description:
              'Base64-encoded file bytes, written exactly as decoded (use it for binary files, or when content contains single quotes, backticks, or ${} patterns). Exactly one of content or content_base64 is required.',
          },
          encoding: {
            type: 'string',
            enum: [...WRITE_TEXT_ENCODINGS],
            description: 'How the text in content is encoded on disk. Default: utf-8. Text with a character the chosen encoding cannot hold is refused. content_base64 and mode restore write exact bytes and take no other encoding.',
            default: 'utf-8',
          },
          mode: {
            type: 'string',
            enum: ['fail_if_exists', 'overwrite', 'backup', 'restore'],
            description:
              'Behaviour when the file already exists. ' +
              'fail_if_exists (default): return an error. ' +
              'overwrite: replace existing content. ' +
              'backup: copy the existing file to .goodvibes/.backups/ before overwriting (the newest 5 copies per file are kept; the result names the copy). ' +
              'restore: put back the newest backup of this file (send no content).',
            default: 'fail_if_exists',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      minItems: 1,
    },
    verbosity: {
      type: 'string',
      enum: ['count_only', 'minimal', 'standard', 'verbose'],
      description:
        'Output detail level. Default: count_only (recommended, you provided the content). At every level the result lists backup copies made, backups restored, and files auto-heal rewrote (healed), whose content then differs from what you sent.',
      default: 'count_only',
    },
    dry_run: {
      type: 'boolean',
      description: 'If true, validate and plan writes but do not write any files.',
      default: false,
    },
    validate: {
      type: 'object',
      description: 'Run validators after all files have been written.',
      properties: {
        after: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['typecheck', 'lint', 'test', 'build'],
          },
          description: 'Validators to run after writing: the project\'s own typecheck, lint, test or build command (its package.json script through its package manager, or the Cargo/Go toolchain). One the project does not declare is refused before anything is written. A failure makes the call unsuccessful but does NOT undo writes.',
        },
      },
      additionalProperties: false,
    },
    transaction: {
      type: 'object',
      description: 'Batch transaction behaviour when one or more file writes fail.',
      properties: {
        mode: {
          type: 'string',
          enum: ['atomic', 'partial', 'none'],
          description:
            'atomic: if any write fails, undo all previously written files (restores originals). '
            + 'partial: skip failed writes but continue. '
            + 'none (default): same as partial, no rollback.',
          default: 'none',
        },
      },
      additionalProperties: false,
    },
  },
  required: ['files'],
  additionalProperties: false,
} as const;

export type WriteMode = 'fail_if_exists' | 'overwrite' | 'backup' | 'restore';
export type WriteVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';
export type WriteValidatorName = 'typecheck' | 'lint' | 'test' | 'build';
export type WriteTransactionMode = 'atomic' | 'partial' | 'none';

export interface WriteFileInput {
  path: string;
  content?: string | undefined;
  content_base64?: string | undefined;
  encoding?: string | undefined;
  mode?: WriteMode | undefined;
}

export interface WriteInput {
  files: WriteFileInput[];
  verbosity?: WriteVerbosity | undefined;
  dry_run?: boolean | undefined;
  validate?: {
    after?: WriteValidatorName[] | undefined;
  };
  transaction?: {
    mode?: WriteTransactionMode | undefined;
  };
}
