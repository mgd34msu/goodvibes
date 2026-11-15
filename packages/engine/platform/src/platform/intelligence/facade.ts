/**
 * CodeIntelligence, unified facade over tree-sitter and LSP services.
 *
 * Design principles:
 *   - Never throw. Tree-sitter answers are empty when a file cannot be parsed.
 *   - Language-server lookups (`lookup*`) say why an answer is empty: no
 *     server, the server does not support the request, it timed out, or it
 *     failed. The `get*` forms return only the items.
 *   - No setup step: the first call loads the language files (user and project
 *     languages/{id}.json) and tree-sitter initialises on the first parse.
 *     `initialize()` remains for callers that want that work done early.
 *   - Without its own TreeSitterService a facade uses the process's shared one,
 *     so every tool parses with one parser and loads each grammar once.
 */
import { readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { BUILTIN_LANGUAGES, resolveLanguages, type ResolvedLanguages } from './config.js';
import { TreeSitterService, sharedTreeSitterService } from './tree-sitter/service.js';

import type { Tree, Language, Node } from 'web-tree-sitter';

/** Result of parsing a file with tree-sitter. */
export interface ParseResult { tree: Tree; language: Language; lang: string; }

/** A syntax-level diagnostic derived from the tree-sitter parse (no type checking). */
export interface SyntaxDiagnostic {
  /** 1-based line. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  readonly message: string;
}

/**
 * Walk a parse tree and collect the minimal set of syntax-error sites (ERROR
 * and MISSING nodes), capped. Descends only into subtrees that contain an
 * error, and does not descend past an error node (its whole subtree is noise).
 */
function collectSyntaxErrors(tree: Tree, cap = 20): SyntaxDiagnostic[] {
  const root = tree.rootNode;
  if (!root.hasError) return [];
  const out: SyntaxDiagnostic[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0 && out.length < cap) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      const where = { line: node.startPosition.row + 1, column: node.startPosition.column };
      const message = node.isMissing
        ? `Missing '${node.type}'`
        : `Unexpected syntax near '${(node.text ?? '').trim().slice(0, 40) || node.type}'`;
      out.push({ ...where, message });
      continue; // do not descend into an error subtree
    }
    if (!node.hasError) continue;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return out;
}
import { LspService, type LanguageServerInstallOutcome } from './lsp/service.js';
import { LspRequestTimeoutError, type LspClient } from './lsp/client.js';
import type { LspCapabilities } from './lsp/capabilities.js';
import { lspLanguageIdFor, symbolFamilyFor } from './tree-sitter/languages.js';
import { extractSymbols, extractOutline, findEnclosingScope } from './tree-sitter/queries.js';
import { logger } from '../utils/logger.js';
import type { SymbolInfo, OutlineEntry } from './tree-sitter/queries.js';
import type { Location, DocumentSymbol, Diagnostic, Hover } from './lsp/protocol.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { summarizeError } from '../utils/error-display.js';

/** Why a language-server lookup has nothing, when it has nothing. */
export type LookupStatus = 'ok' | 'no-server' | 'unsupported' | 'timeout' | 'failed';

/**
 * A language-server answer. `ok` with empty items means the server looked and
 * found none; any other status means it was not asked or did not answer, and
 * `reason` and `next` say why and what to do.
 */
export type LookupResult<T> =
  | { readonly status: 'ok'; readonly items: T }
  | { readonly status: Exclude<LookupStatus, 'ok'>; readonly items: T; readonly reason: string; readonly next: readonly string[] };

/** Time limit for one lookup request; a server still loading the project can take this long. */
const LOOKUP_TIMEOUT_MS = 15_000;
/** Default wait for a server's diagnostics on a document it was just sent. */
const DEFAULT_DIAGNOSTICS_WAIT_MS = 3_000;
/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

type LookupFailure = Exclude<LookupResult<null>, { status: 'ok' }>;

function failure(status: LookupFailure['status'], reason: string, next: readonly string[] = []): LookupFailure {
  return { status, items: null, reason, next };
}

function withItems<T>(failed: LookupFailure, items: T): LookupResult<T> {
  return { status: failed.status, items, reason: failed.reason, next: failed.next };
}

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * Convert a filesystem path to a file:// URI.
 * Correctly handles paths with spaces and special characters.
 */
export function pathToUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

/**
 * Convert a file:// URI back to a filesystem path.
 * Correctly handles percent-encoded URIs.
 */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

// ---------------------------------------------------------------------------
// CodeIntelligence
// ---------------------------------------------------------------------------

type ShellPaths = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory' | 'resolveProjectPath' | 'resolveUserPath'>;

/** A hold on a workspace's one code-intelligence facade. */
export interface WorkspaceCodeIntelligenceHold {
  readonly intelligence: CodeIntelligence;
  /** Ends this hold; the last one shuts the workspace's language servers down. A second call does nothing. */
  release(): Promise<void>;
}

const workspaceFacades = new Map<string, { readonly intelligence: CodeIntelligence; holders: number }>();

export class CodeIntelligence {
  /**
   * The one facade of a workspace in this process, shared by everything that
   * works on it (the model's tools, worker agents in the same directory, the
   * /intelligence command), so each language server starts once and stays warm
   * for every asker until the last hold is released.
   */
  static holdForWorkspace(shellPaths: ShellPaths): WorkspaceCodeIntelligenceHold {
    const key = `${resolve(shellPaths.workingDirectory)}\0${resolve(shellPaths.homeDirectory)}`;
    let entry = workspaceFacades.get(key);
    if (!entry) {
      entry = { intelligence: new CodeIntelligence({ shellPaths }), holders: 0 };
      workspaceFacades.set(key, entry);
    }
    entry.holders += 1;
    const held = entry;
    let released = false;
    return {
      intelligence: held.intelligence,
      async release() {
        if (released) return;
        released = true;
        held.holders -= 1;
        if (held.holders > 0 || workspaceFacades.get(key) !== held) return;
        workspaceFacades.delete(key);
        await held.intelligence.dispose();
      },
    };
  }

  private treeSitter: TreeSitterService;
  private readonly ownsTreeSitter: boolean;
  private lsp: LspService | null;
  private readonly shellPaths: ShellPaths | null;
  /** Built-in language facts until the workspace's language files are loaded. */
  private languages: ResolvedLanguages = BUILTIN_LANGUAGES;
  private readyPromise: Promise<void> | null = null;

  constructor(options: {
    shellPaths?: ShellPaths | undefined;
    treeSitter?: TreeSitterService | undefined;
    lsp?: LspService | undefined;
  } = {}) {
    this.shellPaths = options.shellPaths ?? null;
    this.ownsTreeSitter = options.treeSitter !== undefined;
    this.treeSitter = options.treeSitter ?? sharedTreeSitterService();
    this.lsp = options.lsp ?? (this.shellPaths ? new LspService(this.shellPaths) : null);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load the language files and initialise tree-sitter now rather than on the
   * first call. Optional: every method does what it needs itself.
   */
  async initialize(): Promise<void> {
    await this.ready();
    try {
      await this.treeSitter.initialize();
    } catch (err) {
      logger.warn('CodeIntelligence: TreeSitterService init error', { error: summarizeError(err) });
    }
  }

  /**
   * Read the language files once and register their servers with the
   * LspService. A server already registered through registerServer() is kept.
   */
  private ready(): Promise<void> {
    return (this.readyPromise ??= (async () => {
      if (!this.shellPaths) return;
      try {
        this.languages = resolveLanguages(this.shellPaths);
        const lsp = this.lsp;
        if (!lsp) return;
        for (const [langId, cfg] of this.languages.configs) {
          if (!cfg.lsp || lsp.serverFor(langId)) continue;
          lsp.registerServer(langId, {
            command: cfg.lsp.command,
            args: cfg.lsp.args,
            initializationOptions: cfg.lsp.initializationOptions,
          });
        }
      } catch (err) {
        logger.warn('CodeIntelligence: failed to load language configs', { error: summarizeError(err) });
      }
    })());
  }

  /** Shutdown all owned services for this facade instance. */
  async dispose(): Promise<void> {
    try { await this.lsp?.shutdown(); } catch (err) { logger.warn('LSP shutdown error', { error: summarizeError(err) }); }
    if (!this.ownsTreeSitter) return;
    try { this.treeSitter.dispose(); } catch (err) { logger.warn('TreeSitter dispose error', { error: summarizeError(err) }); }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Parse a file and run `use` on the tree before anything else can touch it.
   * `lang` in the parse result is the grammar the file was parsed with.
   * Returns null if the language is unknown or has no grammar.
   */
  private async _withParsed<T>(
    filePath: string,
    content: string,
    use: (parsed: ParseResult) => T,
    needsSymbols = false,
  ): Promise<T | null> {
    await this.ready();
    const lang = this.languages.detect(filePath);
    if (!lang) return null;
    const grammar = this.languages.grammar(lang);
    if (!grammar) return null;
    if (needsSymbols && !symbolFamilyFor(grammar)) return null;
    return this.treeSitter.withParsedTree(content, grammar, (tree, language) => use({ tree, language, lang: grammar }));
  }

  // -------------------------------------------------------------------------
  // Tree-sitter operations
  // -------------------------------------------------------------------------

  /** Detect the language of a file by its extension (and any extensions a language file added). */
  detectLanguage(filePath: string): string | null {
    return this.languages.detect(filePath);
  }

  /** True when the file's language has a grammar, so it can be parsed. */
  hasTreeSitter(filePath: string): boolean {
    const lang = this.languages.detect(filePath);
    if (!lang) return false;
    const grammar = this.languages.grammar(lang);
    return grammar !== undefined && !this.treeSitter.isUnavailable(grammar);
  }

  /**
   * Parse a file and extract symbols.
   * Returns an empty array when the language has no grammar or no symbols.
   */
  async getSymbols(filePath: string, content: string): Promise<SymbolInfo[]> {
    try {
      return await this._withParsed(filePath, content, (parsed) => extractSymbols(parsed.tree, parsed.language, parsed.lang), true) ?? [];
    } catch (err) {
      logger.warn('CodeIntelligence.getSymbols error', { filePath, error: summarizeError(err) });
      return [];
    }
  }

  /**
   * Parse a file and extract an outline (signatures only).
   * Returns an empty array when the language has no grammar or no symbols.
   */
  async getOutline(filePath: string, content: string): Promise<OutlineEntry[]> {
    try {
      return await this._withParsed(filePath, content, (parsed) => extractOutline(parsed.tree, parsed.language, parsed.lang), true) ?? [];
    } catch (err) {
      logger.warn('CodeIntelligence.getOutline error', { filePath, error: summarizeError(err) });
      return [];
    }
  }

  /**
   * Parse a file and return syntax-level diagnostics (ERROR / MISSING nodes)
   * from the tree-sitter parse. In-process and cheap, this does NOT type-check
   * and never spawns a language server. Returns [] when the language has no
   * grammar or the parse is clean.
   */
  async getSyntaxDiagnostics(filePath: string, content: string): Promise<SyntaxDiagnostic[]> {
    try {
      return await this._withParsed(filePath, content, (parsed) => collectSyntaxErrors(parsed.tree)) ?? [];
    } catch (err) {
      logger.warn('CodeIntelligence.getSyntaxDiagnostics error', { filePath, error: summarizeError(err) });
      return [];
    }
  }

  /**
   * Find the scope (function/class) enclosing a line.
   * Returns null if unavailable.
   */
  async getEnclosingScope(
    filePath: string,
    content: string,
    line: number,
  ): Promise<{ kind: string; name: string; startLine: number; endLine: number } | null> {
    try {
      return await this._withParsed(filePath, content, (parsed) => findEnclosingScope(parsed.tree, parsed.language, parsed.lang, line), true);
    } catch (err) {
      logger.warn('CodeIntelligence.getEnclosingScope error', { filePath, error: summarizeError(err) });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // LSP operations
  // -------------------------------------------------------------------------

  /** Check if an LSP server is installed for a file's language. */
  async hasLsp(filePath: string): Promise<boolean> {
    if (!this.lsp) return false;
    await this.ready();
    const lang = this.languages.detect(filePath);
    if (!lang) return false;
    try {
      return await this.lsp.isAvailable(lang);
    } catch (err) { logger.warn('hasLsp error', { error: summarizeError(err) });
      return false;
    }
  }

  /** True when a language server is configured for the file's language. */
  hasServerConfigured(filePath: string): boolean {
    const lang = this.languages.detect(filePath);
    return lang !== null && this.languages.configs.get(lang)?.lsp !== undefined;
  }

  /** True when a language server for the file's language is running now. */
  async hasRunningServer(filePath: string): Promise<boolean> {
    if (!this.lsp) return false;
    await this.ready();
    const lang = this.languages.detect(filePath);
    return lang !== null && this.lsp.runningClient(lang) !== null;
  }

  /**
   * Install the language server for a file's language (or a language id) into
   * the user's bin directory: an explicit owner action, never part of a lookup.
   */
  async installLanguageServer(
    fileOrLanguage: string,
    options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
  ): Promise<LanguageServerInstallOutcome> {
    await this.ready();
    const lang = this.languages.detect(fileOrLanguage) ?? fileOrLanguage;
    if (!this.lsp) {
      return { langId: lang, command: '', status: 'not-configured', reason: 'This facade has no language-server service (no workspace paths)', at: Date.now() };
    }
    return this.lsp.installServer(lang, options);
  }

  /**
   * Resolve the client for a file and send it the file's text. `capability`
   * is checked against what the server said it supports.
   */
  private async _prepare(
    filePath: string,
    capability: keyof LspCapabilities | null,
    options: { readonly content?: string | undefined; readonly onlyRunning?: boolean | undefined } = {},
  ): Promise<{ client: LspClient; lang: string; uri: string; sync: ReturnType<LspClient['syncDocument']> } | LookupFailure> {
    await this.ready();
    const lang = this.languages.detect(filePath);
    if (!lang) {
      return failure('unsupported', `No language is known for ${basename(filePath)}, so no language server can be asked.`,
        ['Add its extension to a user languages file with an lsp command.']);
    }
    if (!this.lsp) {
      return failure('no-server', 'This lookup has no language-server service (it was built without workspace paths).');
    }
    let client: LspClient;
    if (options.onlyRunning) {
      const running = this.lsp.runningClient(lang);
      if (!running) return failure('no-server', `No ${lang} language server is running.`);
      client = running;
    } else {
      const resolution = await this.lsp.resolveClient(lang);
      if (resolution.status !== 'ok') return failure(resolution.status, resolution.reason, resolution.next);
      client = resolution.client;
    }
    if (capability && client.capabilities && !client.capabilities[capability]) {
      return failure('unsupported', `The ${lang} language server does not support ${capability} requests.`);
    }
    let text = options.content;
    if (text === undefined) {
      try { text = readFileSync(filePath, 'utf-8'); }
      catch (err) {
        return failure('failed', `${filePath} could not be read to send to the language server: ${summarizeError(err)}`);
      }
    }
    const uri = pathToUri(filePath);
    const sync = client.syncDocument(uri, lspLanguageIdFor(lang), text);
    return { client, lang, uri, sync };
  }

  /** Map a request failure to its lookup status. */
  private _requestFailure(lang: string, method: string, err: unknown): LookupFailure {
    if (err instanceof LspRequestTimeoutError) {
      return failure('timeout', `The ${lang} language server did not answer ${method} within ${err.timeoutMs} ms.`,
        ['Try again: a server that is still loading the project answers once it is done.']);
    }
    const message = summarizeError(err);
    if (message.includes(`LSP error ${METHOD_NOT_FOUND}:`)) {
      return failure('unsupported', `The ${lang} language server does not support ${method}.`);
    }
    return failure('failed', `The ${lang} language server failed on ${method}: ${message}`);
  }

  private async _request<T>(
    filePath: string,
    capability: keyof LspCapabilities,
    method: string,
    params: (uri: string) => unknown,
    empty: T,
    shape: (raw: unknown) => T,
  ): Promise<LookupResult<T>> {
    try {
      const prepared = await this._prepare(filePath, capability);
      if ('status' in prepared) return withItems(prepared, empty);
      try {
        const raw = await prepared.client.request<unknown>(method, params(prepared.uri), { timeoutMs: LOOKUP_TIMEOUT_MS });
        return { status: 'ok', items: shape(raw) };
      } catch (err) {
        return withItems(this._requestFailure(prepared.lang, method, err), empty);
      }
    } catch (err) {
      logger.warn('CodeIntelligence: language-server lookup failed', { filePath, method, error: summarizeError(err) });
      return withItems(failure('failed', `The lookup failed: ${summarizeError(err)}`), empty);
    }
  }

  /** Definition locations at a position, with why the list is empty when it is. */
  lookupDefinition(filePath: string, line: number, column: number): Promise<LookupResult<Location[]>> {
    return this._request(filePath, 'definition', 'textDocument/definition',
      (uri) => ({ textDocument: { uri }, position: { line, character: column } }), [],
      (raw) => (raw ? (Array.isArray(raw) ? raw as Location[] : [raw as Location]) : []));
  }

  /** References to the symbol at a position, with why the list is empty when it is. */
  lookupReferences(filePath: string, line: number, column: number): Promise<LookupResult<Location[]>> {
    return this._request(filePath, 'references', 'textDocument/references',
      (uri) => ({ textDocument: { uri }, position: { line, character: column }, context: { includeDeclaration: true } }), [],
      (raw) => (Array.isArray(raw) ? raw as Location[] : []));
  }

  /** Hover text at a position, with why there is none when there is none. */
  lookupHover(filePath: string, line: number, column: number): Promise<LookupResult<Hover | null>> {
    return this._request<Hover | null>(filePath, 'hover', 'textDocument/hover',
      (uri) => ({ textDocument: { uri }, position: { line, character: column } }), null,
      (raw) => (raw ? raw as Hover : null));
  }

  /**
   * The language server's diagnostics (type errors included) for a file's
   * text. `content` is the text to check (default: the file on disk);
   * `onlyRunning` asks only a server that is already running and never starts
   * one; `waitMs` bounds the wait for the server's answer to this exact text.
   */
  async lookupDiagnostics(
    filePath: string,
    options: { readonly content?: string | undefined; readonly onlyRunning?: boolean | undefined; readonly waitMs?: number | undefined } = {},
  ): Promise<LookupResult<Diagnostic[]>> {
    const waitMs = options.waitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS;
    try {
      const prepared = await this._prepare(filePath, null, options);
      if ('status' in prepared) return withItems(prepared, []);
      const { client, lang, uri, sync } = prepared;
      if (client.capabilities?.pullDiagnostics) {
        try {
          const pulled = await client.request<{ items?: Diagnostic[] } | null>('textDocument/diagnostic', { textDocument: { uri } }, { timeoutMs: waitMs });
          return { status: 'ok', items: pulled?.items ?? [] };
        } catch (err) {
          return withItems(this._requestFailure(lang, 'textDocument/diagnostic', err), []);
        }
      }
      const published = await client.waitForDiagnostics(uri, sync, waitMs);
      if (published === null) {
        return withItems(failure('timeout', `The ${lang} language server did not report diagnostics for this text within ${waitMs} ms.`), []);
      }
      return { status: 'ok', items: published };
    } catch (err) {
      logger.warn('CodeIntelligence.lookupDiagnostics error', { filePath, error: summarizeError(err) });
      return withItems(failure('failed', `The diagnostics lookup failed: ${summarizeError(err)}`), []);
    }
  }

  /** Definition location, or null (see {@link lookupDefinition} for why). */
  async getDefinition(filePath: string, line: number, column: number): Promise<Location | null> {
    return (await this.lookupDefinition(filePath, line, column)).items[0] ?? null;
  }

  /** References, or [] (see {@link lookupReferences} for why). */
  async getReferences(filePath: string, line: number, column: number): Promise<Location[]> {
    return (await this.lookupReferences(filePath, line, column)).items;
  }

  /** Hover information, or null (see {@link lookupHover} for why). */
  async getHover(filePath: string, line: number, column: number): Promise<Hover | null> {
    return (await this.lookupHover(filePath, line, column)).items;
  }

  /** Diagnostics for the file on disk, or [] (see {@link lookupDiagnostics} for why). */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    return (await this.lookupDiagnostics(filePath)).items;
  }

  /**
   * Get document symbols.
   * Tries LSP first; falls back to tree-sitter if LSP is unavailable.
   */
  async getDocumentSymbols(
    filePath: string,
    content: string,
  ): Promise<DocumentSymbol[] | SymbolInfo[]> {
    try {
      const prepared = await this._prepare(filePath, 'documentSymbols', { content });
      if (!('status' in prepared)) {
        const lspSymbols = await prepared.client.request<DocumentSymbol[] | null>(
          'textDocument/documentSymbol',
          { textDocument: { uri: prepared.uri } },
          { timeoutMs: LOOKUP_TIMEOUT_MS },
        );
        if (lspSymbols && lspSymbols.length > 0) return lspSymbols;
      }
    } catch (err) {
      logger.warn('CodeIntelligence.getDocumentSymbols LSP error; falling back to tree-sitter', { filePath, error: summarizeError(err) });
    }
    return this.getSymbols(filePath, content);
  }
}
