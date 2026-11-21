/**
 * Per-language configuration for CodeIntelligence and auto-heal.
 *
 * Config is loaded from (in priority order, higher overrides lower):
 *   1. every configured project languages/{langId}.json file
 *   2. every configured user languages/{langId}.json file
 *   3. Built-in defaults (the language table in tree-sitter/languages.ts)
 * A file whose langId has no built-in default adds that language.
 *
 * Fields of a languages/{langId}.json file:
 *   - `extensions`: file extensions (without the dot) that belong to the language.
 *   - `lsp`: `{ command, args, initializationOptions? }`, the language server.
 *   - `treeSitter`: the embedded grammar its files are parsed with
 *     (typescript, tsx, javascript, python, json or css).
 *   - `formatter`, `linter`: `{ command, args }` that auto-heal runs on a copy
 *     of a file of the language, in place of prettier and eslint; the command
 *     rewrites the file it is given. An argument `{file}` is replaced with the
 *     file's path; without one the path is appended.
 * A project file cannot set `lsp`, `formatter` or `linter`: each names a
 * program to run, and a cloned repository is not trusted to choose one.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { summarizeError } from '../utils/error-display.js';
import { LANGUAGES, detectLanguage, grammarFor } from './tree-sitter/languages.js';

export interface CommandSpec { command: string; args: string[] }

export interface LanguageConfig {
  lsp?: {
    command: string;
    args: string[];
    initializationOptions?: Record<string, unknown> | undefined;
  };
  /** Embedded grammar the language's files are parsed with. */
  treeSitter?: string | undefined;
  /** File extensions (without the dot) that belong to the language. */
  extensions?: string[] | undefined;
  formatter?: CommandSpec;
  linter?: CommandSpec;
}

export type IntelligenceRoots = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'> & Partial<Pick<ShellPathService, 'resolveProjectPath' | 'resolveUserPath'>>;

/** Fields a project languages file may not set: each names a program to run. */
const PROGRAM_FIELDS = ['lsp', 'formatter', 'linter'] as const;

/** The grammars built into the product; a language file's `treeSitter` must name one of them. */
const EMBEDDED_GRAMMARS = new Set(LANGUAGES.flatMap((entry) => (entry.grammar ? [entry.grammar] : [])));

// ---------------------------------------------------------------------------
// Default configurations
// ---------------------------------------------------------------------------

/** Built-in defaults: every language in the table that has a default language server. */
export function getDefaultConfigs(): Map<string, LanguageConfig> {
  const defaults = new Map<string, LanguageConfig>();
  for (const entry of LANGUAGES) {
    if (!entry.lsp) continue;
    defaults.set(entry.id, {
      lsp: { command: entry.lsp.command, args: [...entry.lsp.args] },
      ...(entry.grammar ? { treeSitter: entry.grammar } : {}),
    });
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommandSpec(value: unknown): value is CommandSpec {
  return isRecord(value)
    && typeof value.command === 'string'
    && value.command.trim().length > 0
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === 'string');
}

/**
 * Check a parsed language file against the LanguageConfig shape. Returns the
 * reason it is unusable, or null when every field present is well formed and
 * at least one field is present.
 */
function describeLanguageConfigProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'file is not a JSON object';
  const known = ['lsp', 'treeSitter', 'extensions', 'formatter', 'linter'] as const;
  if (!known.some((key) => value[key] !== undefined)) {
    return 'file sets none of lsp, treeSitter, extensions, formatter, linter';
  }
  if (value.lsp !== undefined) {
    if (!isCommandSpec(value.lsp)) return 'lsp needs a non-empty command string and an args string array';
    const init: unknown = (value.lsp as unknown as Record<string, unknown>).initializationOptions;
    if (init !== undefined && !isRecord(init)) return 'lsp.initializationOptions must be an object';
  }
  if (value.treeSitter !== undefined && (typeof value.treeSitter !== 'string' || value.treeSitter.trim().length === 0)) {
    return 'treeSitter must be a non-empty string';
  }
  if (value.extensions !== undefined && (!Array.isArray(value.extensions)
    || !value.extensions.every((ext) => typeof ext === 'string' && ext.replace(/^\./, '').trim().length > 0))) {
    return 'extensions must be an array of non-empty strings';
  }
  if (value.formatter !== undefined && !isCommandSpec(value.formatter)) {
    return 'formatter needs a non-empty command string and an args string array';
  }
  if (value.linter !== undefined && !isCommandSpec(value.linter)) {
    return 'linter needs a non-empty command string and an args string array';
  }
  return null;
}

/**
 * Read one languages/{langId}.json file. Returns null (after a warning) when
 * the file cannot be read, is not JSON, or does not have the LanguageConfig
 * shape, so a bad file never replaces a working config.
 */
function readConfigFile(filePath: string): LanguageConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logger.warn('config: failed to read language config', {
      filePath,
      error: summarizeError(err),
    });
    return null;
  }
  const problem = describeLanguageConfigProblem(parsed);
  if (problem) {
    logger.warn('config: skipping invalid language config', { filePath, problem });
    return null;
  }
  const config = parsed as LanguageConfig;
  if (config.treeSitter !== undefined && !EMBEDDED_GRAMMARS.has(config.treeSitter)) {
    // The rest of the file still loads; the language is parsed with its
    // built-in grammar, if it has one.
    logger.warn('config: ignoring a treeSitter grammar that is not built in', {
      filePath,
      treeSitter: config.treeSitter,
      embeddedGrammars: [...EMBEDDED_GRAMMARS].join(', '),
    });
    delete config.treeSitter;
  }
  if (config.extensions) {
    config.extensions = config.extensions.map((ext) => ext.replace(/^\./, '').trim().toLowerCase());
  }
  return config;
}

/**
 * Read every *.json file in a languages directory, keyed by language id (the
 * file name without .json). A missing directory yields an empty map.
 */
function readConfigDirectory(dir: string): Map<string, LanguageConfig> {
  const found = new Map<string, LanguageConfig>();
  if (!existsSync(dir)) return found;
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    logger.warn('config: failed to list language config directory', { dir, error: summarizeError(err) });
    return found;
  }
  for (const name of names) {
    const langId = name.slice(0, -'.json'.length);
    if (langId.length === 0) continue;
    const cfg = readConfigFile(join(dir, name));
    if (cfg) found.set(langId, cfg);
  }
  return found;
}

/**
 * Load all language configs: the built-in defaults, then every
 * languages/*.json file in the user directory, then every one in the project
 * directory. Precedence is defaults < user < project, merged per top-level
 * field. A file for a language id with no built-in default adds that language.
 */
export function loadLanguageConfigs(roots: IntelligenceRoots): Map<string, LanguageConfig> {
  const result = getDefaultConfigs();

  const userDir = roots.resolveUserPath
    ? roots.resolveUserPath('languages')
    : join(roots.homeDirectory, '.goodvibes', 'languages');
  const projectDir = roots.resolveProjectPath
    ? roots.resolveProjectPath('languages')
    : join(roots.workingDirectory, '.goodvibes', 'languages');

  const projectLayer = readConfigDirectory(projectDir);
  // A language server, formatter or linter is a program the project would pick
  // for the user, and a cloned repository is not trusted to do that. Those come
  // from the defaults or the user's own directory; a project file may still
  // describe the language in every other respect.
  for (const [langId, cfg] of projectLayer) {
    const refused = PROGRAM_FIELDS.filter((field) => cfg[field] !== undefined);
    if (refused.length === 0) continue;
    logger.warn('config: ignoring the programs a project language file asks for; set them in your user languages directory instead', { langId, fields: refused, dir: projectDir });
    const { lsp: _lsp, formatter: _formatter, linter: _linter, ...rest } = cfg;
    if (Object.keys(rest).length === 0) projectLayer.delete(langId);
    else projectLayer.set(langId, rest);
  }

  for (const layer of [readConfigDirectory(userDir), projectLayer]) {
    for (const [langId, cfg] of layer) {
      result.set(langId, { ...(result.get(langId) ?? {}), ...cfg });
    }
  }

  return result;
}

/**
 * Get config for a specific language ID.
 * Loads configs on demand.
 */
export function getLanguageConfig(langId: string, roots: IntelligenceRoots): LanguageConfig | null {
  return loadLanguageConfigs(roots).get(langId) ?? null;
}

/** The language facts for one workspace: the table plus the user and project files. */
export interface ResolvedLanguages {
  readonly configs: ReadonlyMap<string, LanguageConfig>;
  /** Language id of a file, with extensions the language files added. */
  detect(filePath: string): string | null;
  /** Embedded grammar a language is parsed with, if any. */
  grammar(langId: string): string | undefined;
  /** The formatter or linter a language file set for the language. */
  tool(langId: string, kind: 'formatter' | 'linter'): CommandSpec | undefined;
}

/** Build the language facts from loaded configs (no file reads). */
export function resolveLanguagesFrom(configs: ReadonlyMap<string, LanguageConfig>): ResolvedLanguages {
  const extensions = new Map<string, string>();
  for (const [langId, cfg] of configs) {
    for (const ext of cfg.extensions ?? []) extensions.set(ext, langId);
  }
  return {
    configs,
    detect: (filePath) => detectLanguage(filePath, extensions),
    grammar: (langId) => {
      const named = configs.get(langId)?.treeSitter;
      if (named && EMBEDDED_GRAMMARS.has(named)) return named;
      return grammarFor(langId);
    },
    tool: (langId, kind) => configs.get(langId)?.[kind],
  };
}

/** Load the language files for a workspace and resolve them. */
export function resolveLanguages(roots: IntelligenceRoots): ResolvedLanguages {
  return resolveLanguagesFrom(loadLanguageConfigs(roots));
}

/** Built-in language facts only (no workspace, no user files). */
export const BUILTIN_LANGUAGES: ResolvedLanguages = resolveLanguagesFrom(getDefaultConfigs());

/** The argv for a formatter or linter run on one file: `{file}` replaced, else appended. */
export function languageToolArgv(spec: CommandSpec, filePath: string): string[] {
  const hasPlaceholder = spec.args.some((arg) => arg.includes('{file}'));
  const args = hasPlaceholder ? spec.args.map((arg) => arg.split('{file}').join(filePath)) : [...spec.args, filePath];
  return [spec.command, ...args];
}
