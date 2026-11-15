import type { ToolDefinition } from '../../types/tools.js';

/**
 * JSON Schema for the analyze tool's input.
 * A mode router for code analysis: impact, dependencies, dead code,
 * security, coverage, surface, preview, diff, and bundle.
 */
export const analyzeSchema: ToolDefinition = {
  name: 'analyze',
  description:
    'Multi-mode code analysis tool. Modes: impact (change blast radius), ' +
    'dependencies (import graph / circular detection), dead_code (unreferenced exports), ' +
    'security (hardcoded secrets/env audit), coverage (lcov parse), ' +
    'surface (public API exports), preview (diff without writing), ' +
    'diff (git ref diff), bundle (stats.json parse), ' +
    'breaking (API breaking changes between refs), semantic_diff (LLM-powered diff summary), ' +
    'upgrade (npm registry version check), permissions (dangerous pattern scan), ' +
    'env_audit (.env file key comparison), test_find (locate test files for source files).',
  sideEffects: ['read_fs', 'network'],
  concurrency: 'parallel',
  supportsProgress: true,
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: [
          'impact',
          'dependencies',
          'dead_code',
          'security',
          'coverage',
          'bundle',
          'preview',
          'diff',
          'surface',
          'breaking',
          'semantic_diff',
          'upgrade',
          'permissions',
          'env_audit',
          'test_find',
        ],
        description: 'Analysis mode to run.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target files or directories for analysis.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory. Defaults to current working directory.',
      },
      // mode: impact
      changes: {
        type: 'string',
        description: 'Description of planned changes (mode: impact).',
      },
      // mode: dependencies
      submode: {
        type: 'string',
        enum: ['analyze', 'circular', 'upgrade'],
        description:
          'Sub-mode for dependencies analysis. analyze: the import graph. circular: import cycles. ' +
          'upgrade: lists the external packages the scanned files import, with no version check (mode upgrade checks versions). Default: analyze.',
      },
      // mode: security
      securityScope: {
        type: 'string',
        enum: ['secrets', 'permissions', 'env', 'all'],
        description: 'Security check scope (mode: security). Default: all.',
      },
      // mode: diff
      before: {
        type: 'string',
        description: "Git ref (branch, tag or commit; must not start with '-') for the before state (modes: diff, breaking, semantic_diff). Not a file path; use files to narrow the diff to paths.",
      },
      after: {
        type: 'string',
        description: "Git ref (branch, tag or commit; must not start with '-') for the after state (modes: diff, breaking, semantic_diff). Not a file path.",
      },
      // mode: preview
      find: {
        type: 'string',
        description: 'String to find (mode: preview). Used with replace.',
      },
      replace: {
        type: 'string',
        description: 'Replacement string (mode: preview).',
      },
      // mode: upgrade
      packages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Package names to check (mode: upgrade). Defaults to all packages in package.json.',
      },
      output: {
        type: 'object',
        description: 'Output options.',
        properties: {
          format: {
            type: 'string',
            enum: ['summary', 'detailed', 'json'],
            description: 'Output format. Default: json.',
          },
          max_tokens: {
            type: 'integer',
            minimum: 0,
            description: 'Approximate token budget for the response.',
          },
        },
      },
    },
  },
};
