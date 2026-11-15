import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { CodeIntelligence } from '@goodvibes-jev/engine/platform/platform/intelligence';
import type { DocumentSymbol, LookupResult } from '@goodvibes-jev/engine/platform/platform/intelligence';
import type { SymbolInfo } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { openCommandView, requireReadModels, requireShellPaths } from './runtime-services.ts';

function resolveTargetPath(pathArg: string, ctx: CommandContext): string {
  return requireShellPaths(ctx).resolveWorkspacePath(pathArg);
}

function parsePosition(lineArg: string | undefined, columnArg: string | undefined): { line: number; column: number } | null {
  const line = Number.parseInt(lineArg ?? '', 10);
  const column = Number.parseInt(columnArg ?? '', 10);
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return null;
  return { line: line - 1, column: column - 1 };
}

function formatSymbolKind(kind: number | string | undefined): string {
  if (typeof kind === 'number') return `kind=${kind}`;
  if (typeof kind === 'string' && kind.trim().length > 0) return kind;
  return 'symbol';
}

function formatDocumentSymbol(symbol: DocumentSymbol): string {
  const line = (symbol.selectionRange?.start.line ?? symbol.range.start.line) + 1;
  const column = (symbol.selectionRange?.start.character ?? symbol.range.start.character) + 1;
  return `  ${symbol.name}  ${formatSymbolKind(symbol.kind)}  ${line}:${column}`;
}

function formatTreeSitterSymbol(symbol: SymbolInfo): string {
  return `  ${symbol.name}  ${formatSymbolKind(symbol.kind)}  ${symbol.line + 1}:${symbol.column + 1}`;
}

function ensureExistingFile(pathArg: string | undefined, ctx: CommandContext): string | null {
  if (!pathArg) {
    ctx.print('Intelligence Review\n  Missing file path.');
    return null;
  }
  const targetPath = resolveTargetPath(pathArg, ctx);
  if (!existsSync(targetPath)) {
    ctx.print(`Intelligence Review\n  File not found: ${targetPath}`);
    return null;
  }
  return targetPath;
}

type IntelligenceFacade = Pick<
  CodeIntelligence,
  'getDocumentSymbols' | 'getOutline' | 'hasTreeSitter' | 'lookupDefinition' | 'lookupReferences' | 'lookupHover' | 'installLanguageServer'
>;

/** A facade to ask and the call that ends this command's hold on it. */
interface IntelligenceHold {
  readonly intelligence: IntelligenceFacade;
  release(): Promise<void>;
}

/** The lines that say why a lookup has nothing, or nothing when it answered. */
function lookupStatusLines(result: LookupResult<unknown>): string[] {
  if (result.status === 'ok') return [];
  return [`  ${result.status}: ${result.reason}`, ...result.next.map((step) => `  next: ${step}`)];
}

async function handleIntelligenceQuery(
  sub: 'symbols' | 'outline' | 'definition' | 'references' | 'hover',
  args: string[],
  ctx: CommandContext,
  intelligence: IntelligenceFacade,
): Promise<void> {
  if (sub === 'symbols' || sub === 'outline') {
    const targetPath = ensureExistingFile(args[1], ctx);
    if (!targetPath) return;
    const content = readFileSync(targetPath, 'utf-8');
    if (sub === 'symbols') {
      const symbols = await intelligence.getDocumentSymbols(targetPath, content);
      const entries = symbols.slice(0, 12).map((symbol) => ('selectionRange' in symbol ? formatDocumentSymbol(symbol) : formatTreeSitterSymbol(symbol)));
      const fromServer = symbols.length > 0 && 'selectionRange' in symbols[0]!;
      ctx.print([
        `Intelligence Symbols: ${targetPath}`,
        `  source: ${fromServer ? 'language server' : 'tree-sitter (the language server gave none or is not set up)'}`,
        `  results: ${symbols.length}`,
        ...(entries.length > 0 ? entries : ['  No symbols available for this file.']),
        '  next: /health intelligence',
      ].join('\n'));
      return;
    }

    const outline = await intelligence.getOutline(targetPath, content);
    ctx.print([
      `Intelligence Outline: ${targetPath}`,
      `  source: tree-sitter outline extraction`,
      `  language ready: ${intelligence.hasTreeSitter(targetPath) ? 'yes' : 'no'}`,
      `  results: ${outline.length}`,
      ...(outline.slice(0, 12).map((entry) => `  ${entry.signature || entry.name}  line ${entry.line}`)),
      ...(outline.length === 0 ? ['  No outline entries available for this file.'] : []),
      '  next: /intelligence symbols ' + targetPath,
    ].join('\n'));
    return;
  }

  if (sub === 'definition' || sub === 'references' || sub === 'hover') {
    const targetPath = ensureExistingFile(args[1], ctx);
    if (!targetPath) return;
    const position = parsePosition(args[2], args[3]);
    if (!position) {
      ctx.print(`Intelligence ${sub[0]!.toUpperCase()}${sub.slice(1)}\n  Usage: /intelligence ${sub} <file> <line> <column>`);
      return;
    }

    if (sub === 'definition') {
      const lookup = await intelligence.lookupDefinition(targetPath, position.line, position.column);
      const definition = lookup.items[0];
      ctx.print([
        `Intelligence Definition: ${targetPath}:${position.line + 1}:${position.column + 1}`,
        ...(definition
          ? [
              `  target: ${definition.uri}`,
              `  line: ${definition.range.start.line + 1}`,
              `  column: ${definition.range.start.character + 1}`,
              '  next: open the target file or use /intelligence references on the same symbol',
            ]
          : lookup.status === 'ok'
            ? ['  The language server found no definition at that position.']
            : lookupStatusLines(lookup)),
      ].join('\n'));
      return;
    }

    if (sub === 'references') {
      const lookup = await intelligence.lookupReferences(targetPath, position.line, position.column);
      const references = lookup.items;
      ctx.print([
        `Intelligence References: ${targetPath}:${position.line + 1}:${position.column + 1}`,
        `  results: ${references.length}`,
        ...(references.slice(0, 12).map((reference) => `  ${reference.uri}  ${reference.range.start.line + 1}:${reference.range.start.character + 1}`)),
        ...(references.length === 0 && lookup.status === 'ok' ? ['  The language server found no references at that position.'] : []),
        ...lookupStatusLines(lookup),
        ...(references.length > 0 ? ['  next: /intelligence definition ' + `${targetPath} ${position.line + 1} ${position.column + 1}`] : []),
      ].join('\n'));
      return;
    }

    const hoverLookup = await intelligence.lookupHover(targetPath, position.line, position.column);
    const hover = hoverLookup.items;
    const hoverLines = typeof hover?.contents === 'string'
      ? hover.contents.split('\n')
      : Array.isArray(hover?.contents)
        ? hover.contents.flatMap((entry) => typeof entry === 'string' ? entry : entry.value.split('\n'))
        : hover?.contents && 'value' in hover.contents
          ? hover.contents.value.split('\n')
          : [];
    ctx.print([
      `Intelligence Hover: ${targetPath}:${position.line + 1}:${position.column + 1}`,
      ...(hoverLines.length > 0
        ? hoverLines.slice(0, 8).map((line) => `  ${line}`)
        : hoverLookup.status === 'ok' ? ['  The language server has no hover information for that position.'] : lookupStatusLines(hoverLookup)),
    ].join('\n'));
    return;
  }
}

export interface IntelligenceRuntimeOptions {
  /** The facade one command call asks. Defaults to the workspace's shared CodeIntelligence. */
  readonly holdIntelligence?: (ctx: CommandContext) => IntelligenceHold;
}

/**
 * The workspace's one facade, the same object the model's read and find tools
 * hold, so a language server the session already started answers at once and
 * stays running after the command.
 */
function holdWorkspaceIntelligence(ctx: CommandContext): IntelligenceHold {
  return CodeIntelligence.holdForWorkspace(requireShellPaths(ctx));
}

export function registerIntelligenceRuntimeCommands(registry: CommandRegistry, options: IntelligenceRuntimeOptions = {}): void {
  const holdIntelligence = options.holdIntelligence ?? holdWorkspaceIntelligence;
  registry.register({
    name: 'intelligence',
    aliases: ['intel'],
    description: 'Review workspace intelligence readiness, diagnostics posture, and symbol search availability',
    usage: '[review|panel|diagnostics [file]|symbols <file>|outline <file>|definition <file> <line> <column>|references <file> <line> <column>|hover <file> <line> <column>|install <file|language>|repair]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'panel' || sub === 'open') {
        // There is no intelligence view; its read model backs every
        // subcommand below. Say so and open Agents rather than failing.
        ctx.print('There is no intelligence view: use /intelligence review|diagnostics|symbols|outline|definition|references|hover|install|repair for the live data. Opening Agents.');
        try {
          openCommandView(ctx, 'agents');
        } catch {
          // The view openers may be absent in lightweight command-only contexts.
        }
        return;
      }

      if (sub === 'symbols' || sub === 'outline' || sub === 'definition' || sub === 'references' || sub === 'hover') {
        const hold = holdIntelligence(ctx);
        try {
          await handleIntelligenceQuery(sub, args, ctx, hold.intelligence);
        } finally {
          await hold.release();
        }
        return;
      }

      if (sub === 'install') {
        const target = args[1];
        if (!target) {
          ctx.print('Intelligence Install\n  Usage: /intelligence install <file|language>  (installs the language server for that language into your GoodVibes bin directory)');
          return;
        }
        const hold = holdIntelligence(ctx);
        try {
          const subject = target.includes('.') || target.includes('/') ? resolveTargetPath(target, ctx) : target;
          ctx.print(`Intelligence Install: ${target}\n  installing (up to 3 minutes)...`);
          const outcome = await hold.intelligence.installLanguageServer(subject);
          ctx.print([
            `Intelligence Install: ${outcome.langId}`,
            `  ${outcome.status}: ${outcome.reason}`,
            ...(outcome.path ? [`  path: ${outcome.path}`] : []),
            ...(outcome.status === 'installed' || outcome.status === 'already-installed'
              ? ['  next: /intelligence references <file> <line> <column>'] : []),
          ].join('\n'));
        } finally {
          await hold.release();
        }
        return;
      }

      const state = requireReadModels(ctx).intelligence.getSnapshot();
      if (sub === 'diagnostics') {
        // Tracked diagnostics are keyed by absolute path, like every other subcommand's target.
        const file = args[1] ? resolveTargetPath(args[1], ctx) : undefined;
        const entries = [...state.diagnostics.entries()]
          .map(([filePath, diagnostics]) => ({
            filePath,
            diagnostics,
            errors: diagnostics.filter((entry) => entry.severity === 'error').length,
            warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
          }))
          .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.filePath.localeCompare(b.filePath));
        const selected = file
          ? entries.find((entry) => entry.filePath === file)
          : entries[0];
        if (!selected) {
          ctx.print(file
            ? `Intelligence Diagnostics\n  No diagnostics are currently tracked for ${file}.`
            : 'Intelligence Diagnostics\n  No diagnostics are currently tracked.');
          return;
        }
        ctx.print([
          `Intelligence Diagnostics: ${selected.filePath}`,
          `  errors: ${selected.errors}`,
          `  warnings: ${selected.warnings}`,
          ...selected.diagnostics.slice(0, 8).map((diagnostic) => (
            `  [${diagnostic.severity}] ${diagnostic.line + 1}:${diagnostic.column + 1} ${diagnostic.message}`
          )),
          ...(entries.length > 1 ? [`  next: /intelligence diagnostics ${entries[1]!.filePath}`] : []),
        ].join('\n'));
        return;
      }

      if (sub === 'repair') {
        const lines = [
          'Intelligence Repair',
          '  verify: /health intelligence',
          ...(state.diagnosticsStatus !== 'ready' ? ['  /setup review', '  /health intelligence'] : []),
          ...(state.symbolSearchStatus !== 'ready' ? ['  /symbols', '  /intelligence symbols <file>', '  /health intelligence'] : []),
          ...(state.completionsStatus !== 'ready' || state.hoverStatus !== 'ready'
            ? ['  /intelligence review', '  /intelligence hover <file> <line> <column>', '  /setup onboarding']
            : []),
        ];
        ctx.print(lines.length > 1 ? lines.join('\n') : 'Intelligence Repair\n  No active repair actions suggested.');
        return;
      }

      const issues: string[] = [];
      if (state.diagnosticsStatus !== 'ready') issues.push(`diagnostics=${state.diagnosticsStatus}`);
      if (state.symbolSearchStatus !== 'ready') issues.push(`symbols=${state.symbolSearchStatus}`);
      if (state.completionsStatus !== 'ready') issues.push(`completions=${state.completionsStatus}`);
      if (state.hoverStatus !== 'ready') issues.push(`hover=${state.hoverStatus}`);

      ctx.print([
        'Intelligence Review',
        `  diagnostics: ${state.diagnosticsStatus}`,
        `  symbols: ${state.symbolSearchStatus}`,
        `  completions: ${state.completionsStatus}`,
        `  hover: ${state.hoverStatus}`,
        `  errors: ${state.errorCount}`,
        `  warnings: ${state.warningCount}`,
        `  requests: ${state.totalRequests}`,
        `  avg latency: ${Math.round(state.avgLatencyMs)}ms`,
        ...(issues.length > 0 ? [`  issues: ${issues.join(', ')}`] : ['  issues: none']),
        `  diagnostic files: ${state.diagnostics.size}`,
        ...(state.diagnostics.size > 0 ? ['  next: /intelligence diagnostics'] : []),
        '  next: /intelligence symbols <file>',
        '  next: /intelligence outline <file>',
        '  next: /intelligence references <file> <line> <column>',
        '  next: /intelligence definition <file> <line> <column>',
        '  next: /intelligence hover <file> <line> <column>',
        '  next: /intelligence install <file|language>',
        '  next: /intelligence repair',
      ].join('\n'));
    },
  });
}
