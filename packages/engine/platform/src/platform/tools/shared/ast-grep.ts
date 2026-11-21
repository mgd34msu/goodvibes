/**
 * The one ast-grep loader and extension table, shared by the find tool's
 * structural mode and the edit tool's AST mode: both parse exactly the same
 * files, as the same language, from one module load.
 */
import { extname } from 'node:path';

export type AstGrepModule = typeof import('@ast-grep/napi');

/** The languages structural search and AST edits parse. */
export type AstGrepLang = 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'html';

/** A language's parser: source text in, a tree to search out. */
export type AstGrepLangParser = Pick<AstGrepModule['ts'], 'parse'>;

let astGrepModulePromise: Promise<AstGrepModule> | null = null;

/** Loads the native module once per process; a failed load rejects every caller the same way. */
export function loadAstGrep(): Promise<AstGrepModule> {
  astGrepModulePromise ??= import('@ast-grep/napi');
  return astGrepModulePromise;
}

/** The parser for each file extension; any other extension is not parsed. */
export const AST_GREP_LANG_BY_EXTENSION: Readonly<Record<string, AstGrepLang>> = Object.freeze({
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  css: 'css', html: 'html', htm: 'html',
});

/** The language a file is parsed as, from its extension; null when it is not one ast-grep parses here. */
export function astGrepLangOf(filePath: string): AstGrepLang | null {
  return AST_GREP_LANG_BY_EXTENSION[extname(filePath).slice(1).toLowerCase()] ?? null;
}

export function astGrepParser(astGrep: AstGrepModule, lang: AstGrepLang): AstGrepLangParser {
  switch (lang) {
    case 'ts': return astGrep.ts;
    case 'tsx': return astGrep.tsx;
    case 'js': return astGrep.js;
    case 'jsx': return astGrep.jsx;
    case 'css': return astGrep.css;
    case 'html': return astGrep.html;
  }
}

/** The parser for a file, from its extension; null when it is not one ast-grep parses here. */
export function parserForFile(astGrep: AstGrepModule, filePath: string): AstGrepLangParser | null {
  const lang = astGrepLangOf(filePath);
  return lang === null ? null : astGrepParser(astGrep, lang);
}
