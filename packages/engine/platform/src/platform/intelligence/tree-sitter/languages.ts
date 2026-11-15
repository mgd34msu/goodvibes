/**
 * The one table of languages the product understands. Detection by extension,
 * the supported-language list, grammar loading, symbol extraction and the
 * default language server all read it; a user languages/{id}.json file can add
 * extensions or a whole language on top of it (see ../config.ts).
 */

/** Which symbol extractor a grammar's trees go through. */
export type SymbolFamily = 'ecmascript' | 'python';

export interface LanguageEntry {
  readonly id: string;
  readonly extensions: readonly string[];
  /**
   * Key of the grammar embedded in the binary (embedded-wasm.ts). Absent: the
   * language is recognised (for language servers and per-language tools) but
   * not parsed.
   */
  readonly grammar?: string;
  /** npm package that provides the grammar. */
  readonly grammarPackage?: string;
  readonly symbols?: SymbolFamily;
  /** Default language server. */
  readonly lsp?: { readonly command: string; readonly args: readonly string[] };
  /** Language id the protocol uses, when it differs from `id`. */
  readonly lspLanguageId?: string;
}

const TYPESCRIPT_SERVER = { command: 'typescript-language-server', args: ['--stdio'] } as const;

export const LANGUAGES: readonly LanguageEntry[] = [
  { id: 'typescript', extensions: ['ts', 'mts', 'cts'], grammar: 'typescript', grammarPackage: 'tree-sitter-typescript', symbols: 'ecmascript', lsp: TYPESCRIPT_SERVER },
  { id: 'tsx', extensions: ['tsx'], grammar: 'tsx', grammarPackage: 'tree-sitter-typescript', symbols: 'ecmascript', lsp: TYPESCRIPT_SERVER, lspLanguageId: 'typescriptreact' },
  { id: 'javascript', extensions: ['js', 'mjs', 'cjs', 'jsx'], grammar: 'javascript', grammarPackage: 'tree-sitter-javascript', symbols: 'ecmascript', lsp: TYPESCRIPT_SERVER },
  { id: 'python', extensions: ['py'], grammar: 'python', grammarPackage: 'tree-sitter-python', symbols: 'python', lsp: { command: 'pyright-langserver', args: ['--stdio'] } },
  { id: 'json', extensions: ['json'], grammar: 'json', grammarPackage: 'tree-sitter-json', lsp: { command: 'vscode-json-language-server', args: ['--stdio'] } },
  { id: 'css', extensions: ['css', 'scss'], grammar: 'css', grammarPackage: 'tree-sitter-css', lsp: { command: 'vscode-css-language-server', args: ['--stdio'] } },
  { id: 'rust', extensions: ['rs'], lsp: { command: 'rust-analyzer', args: [] } },
  { id: 'go', extensions: ['go'], lsp: { command: 'gopls', args: ['serve'] } },
  { id: 'bash', extensions: ['sh', 'bash', 'zsh'], lsp: { command: 'bash-language-server', args: ['start'] }, lspLanguageId: 'shellscript' },
  { id: 'html', extensions: ['html', 'htm'], lsp: { command: 'vscode-html-language-server', args: ['--stdio'] } },
  { id: 'java', extensions: ['java'] },
  { id: 'c', extensions: ['c', 'h'] },
  { id: 'cpp', extensions: ['cpp', 'hpp', 'cc'] },
  { id: 'ruby', extensions: ['rb'] },
  { id: 'yaml', extensions: ['yaml', 'yml'] },
  { id: 'toml', extensions: ['toml'] },
  { id: 'markdown', extensions: ['md'] },
];

const BY_ID = new Map(LANGUAGES.map((entry) => [entry.id, entry]));
const BY_EXTENSION = new Map(LANGUAGES.flatMap((entry) => entry.extensions.map((ext) => [ext, entry.id] as const)));

function extensionOf(filePath: string): string | null {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = filePath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Map a file path to a language id by its extension. `extra` holds extensions
 * a user languages file added (extension → language id); they win over the
 * built-in table. Returns null for an unknown extension.
 */
export function detectLanguage(filePath: string, extra?: ReadonlyMap<string, string>): string | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  return extra?.get(ext) ?? BY_EXTENSION.get(ext) ?? null;
}

/** The table entry for a language id, if it is a built-in language. */
export function languageEntry(langId: string): LanguageEntry | undefined {
  return BY_ID.get(langId);
}

/** The embedded grammar for a language id, or undefined when it has none. */
export function grammarFor(langId: string): string | undefined {
  return BY_ID.get(langId)?.grammar;
}

/** The symbol extractor for a grammar, or undefined when it has none. */
export function symbolFamilyFor(grammar: string): SymbolFamily | undefined {
  return LANGUAGES.find((entry) => entry.grammar === grammar)?.symbols;
}

/** The language id the language-server protocol uses for a language. */
export function lspLanguageIdFor(langId: string): string {
  return BY_ID.get(langId)?.lspLanguageId ?? langId;
}

/** Map a language id to the npm package that provides its grammar. */
export function getGrammarPackage(langId: string): string {
  return BY_ID.get(langId)?.grammarPackage ?? `tree-sitter-${langId}`;
}

/** Language ids the product can parse: those with an embedded grammar. */
export function getSupportedLanguages(): string[] {
  return LANGUAGES.filter((entry) => entry.grammar !== undefined).map((entry) => entry.id);
}
