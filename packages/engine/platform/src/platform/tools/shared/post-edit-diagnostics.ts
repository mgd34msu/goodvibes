// Post-edit diagnostics: errors in a file the model just wrote or edited,
// appended to the tool result so the model sees a broken edit immediately.
//
// The bundled provider reports two kinds:
//   - syntax errors from the in-process tree-sitter parse of TypeScript and
//     JavaScript (no process spawn, no type checking);
//   - the language server's errors (type errors included) for the new text,
//     when a server for the file's language is already running. A server is
//     started by a lookup (find references, /intelligence), never by an edit.
// The DiagnosticsProvider interface is the seam a host can implement with
// another checker.
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { CodeIntelligence, SyntaxDiagnostic } from '../../intelligence/index.js';
import { CodeIntelligence as CodeIntelligenceImpl } from '../../intelligence/index.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** A single error-level diagnostic for a touched file. */
export interface PostEditDiagnostic {
  readonly severity: 'error';
  /** 1-based line. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  readonly message: string;
  /** `syntax`: the in-process parser; `types`: the language server. */
  readonly source?: 'syntax' | 'types' | undefined;
}

/** A diagnostic tagged with the file it belongs to (output-level shape). */
export interface PostEditFileDiagnostic extends PostEditDiagnostic {
  readonly file: string;
}

/**
 * A source of error-level diagnostics for a single file. Implementations MUST
 * NOT spawn processes and MUST never throw: return [] on any failure or when
 * they cannot produce diagnostics (honest absence).
 */
export interface DiagnosticsProvider {
  readonly name: string;
  /** True when this provider can produce diagnostics for the file's type. */
  supports(filePath: string): boolean;
  /** Collect error-level diagnostics for one file's content. */
  collect(filePath: string, content: string): Promise<PostEditDiagnostic[]>;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * How long an edit waits for a running server's diagnostics on the new text.
 * Paid only when a server for the language is running.
 */
const TYPE_CHECK_WAIT_MS = 1_500;

/** LSP DiagnosticSeverity.Error. */
const LSP_ERROR = 1;

/** True when a tsconfig.json / jsconfig.json is present at or above the file. */
function hasTsProjectContext(filePath: string): boolean {
  let dir = dirname(filePath);
  let prev = '';
  while (dir && dir !== prev) {
    if (existsSync(join(dir, 'tsconfig.json')) || existsSync(join(dir, 'jsconfig.json'))) return true;
    prev = dir;
    dir = dirname(dir);
  }
  return false;
}

/**
 * Syntax errors from the in-process parser for TypeScript and JavaScript files
 * in a TS/JS project (a tsconfig.json or jsconfig.json at or above the file),
 * and the language server's errors for any file whose server is already
 * running. Returns [] when neither applies (honest absence rather than a
 * fabricated "no errors").
 */
export class CodeDiagnosticsProvider implements DiagnosticsProvider {
  readonly name = 'code-diagnostics';
  private readonly intel: CodeIntelligence;

  constructor(intel?: CodeIntelligence, private readonly typeCheckWaitMs = TYPE_CHECK_WAIT_MS) {
    this.intel = intel ?? new CodeIntelligenceImpl();
  }

  supports(filePath: string): boolean {
    return TS_EXTS.has(extname(filePath).toLowerCase()) || this.intel.hasServerConfigured(filePath);
  }

  async collect(filePath: string, content: string): Promise<PostEditDiagnostic[]> {
    if (!this.supports(filePath)) return [];
    const [syntax, types] = await Promise.all([this.syntax(filePath, content), this.types(filePath, content)]);
    return [...syntax, ...types];
  }

  private async syntax(filePath: string, content: string): Promise<PostEditDiagnostic[]> {
    if (!TS_EXTS.has(extname(filePath).toLowerCase()) || !hasTsProjectContext(filePath)) return [];
    try {
      const diagnostics = await this.intel.getSyntaxDiagnostics(filePath, content);
      return diagnostics.map((d: SyntaxDiagnostic): PostEditDiagnostic => ({
        severity: 'error',
        line: d.line,
        column: d.column,
        message: d.message,
        source: 'syntax',
      }));
    } catch (err) {
      logger.warn('CodeDiagnosticsProvider: syntax check failed', { filePath, error: summarizeError(err) });
      return [];
    }
  }

  private async types(filePath: string, content: string): Promise<PostEditDiagnostic[]> {
    try {
      const result = await this.intel.lookupDiagnostics(filePath, { content, onlyRunning: true, waitMs: this.typeCheckWaitMs });
      if (result.status !== 'ok') {
        if (result.status !== 'no-server') logger.debug('CodeDiagnosticsProvider: no type check for this edit', { filePath, reason: result.reason });
        return [];
      }
      return result.items
        .filter((d) => d.severity === LSP_ERROR)
        .map((d): PostEditDiagnostic => ({
          severity: 'error',
          line: d.range.start.line + 1,
          column: d.range.start.character,
          message: d.message,
          source: 'types',
        }));
    } catch (err) {
      logger.warn('CodeDiagnosticsProvider: type check failed', { filePath, error: summarizeError(err) });
      return [];
    }
  }
}

/**
 * Render diagnostics as a compact human-readable block for tools whose output
 * is not pure JSON (e.g. the edit tool, which already appends text suffixes).
 * Returns '' for an empty list so callers can append unconditionally.
 */
export function formatDiagnosticsBlock(diagnostics: readonly PostEditFileDiagnostic[]): string {
  if (diagnostics.length === 0) return '';
  const typed = diagnostics.some((d) => d.source === 'types');
  const lines = diagnostics.map((d) => `  ${d.file}:${d.line}:${d.column}${typed && d.source ? ` [${d.source}]` : ''} ${d.message}`);
  return `\n⚠ ${typed ? 'Diagnostics' : 'Syntax diagnostics'} (${diagnostics.length}, errors only):\n${lines.join('\n')}`;
}

/**
 * Run a provider across several just-written files, tagging each diagnostic with
 * its file and capping the total count. Returns [] when no provider is wired.
 */
export async function collectPostEditDiagnostics(
  provider: DiagnosticsProvider | undefined,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
  cap = 20,
): Promise<PostEditFileDiagnostic[]> {
  if (!provider) return [];
  const out: PostEditFileDiagnostic[] = [];
  for (const file of files) {
    if (out.length >= cap) break;
    if (!provider.supports(file.path)) continue;
    const diagnostics = await provider.collect(file.path, file.content);
    for (const diagnostic of diagnostics) {
      if (out.length >= cap) break;
      out.push({ ...diagnostic, file: file.path });
    }
  }
  return out;
}
