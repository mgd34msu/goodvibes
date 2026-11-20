/**
 * `/intelligence`, described once (command-actions/) for both terminal apps:
 * code lookups over the workspace's one code-intelligence facade (the object
 * the model's read and find tools hold, so a language server the session
 * already started answers at once), installing the language server a
 * language needs, and, in the terminal app, how ready it all is and the
 * problems it tracks. A lookup never installs a server; its "no server"
 * answer names the install action.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { CodeIntelligence, DocumentSymbol, LookupResult, SymbolInfo } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import type { ActionDescription, CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import { readAction, textInput } from './described-command-kit.js';
import { runLanguageServerInstall } from './language-server-install.js';

type IntelligenceFacade = Pick<
  CodeIntelligence,
  'getDocumentSymbols' | 'getOutline' | 'hasTreeSitter' | 'lookupDefinition' | 'lookupReferences' | 'lookupHover' | 'installLanguageServer'
>;

/** A facade to ask and the call that ends this command's hold on it. */
export interface IntelligenceHold {
  readonly intelligence: IntelligenceFacade;
  release(): Promise<void>;
}

/** What one app does for `/intelligence`. */
export interface IntelligenceHost<Ctx> {
  /** The workspace's facade, held for one action. */
  readonly hold: (ctx: Ctx) => IntelligenceHold;
  /** A file argument as an absolute workspace path. */
  readonly resolvePath: (ctx: Ctx, target: string) => string;
  /** How ready lookups are and the problems tracked, or why this app keeps no such reading. */
  readonly readiness: { readonly unavailable: string } | {
    review(ctx: Ctx): string;
    diagnostics(ctx: Ctx, file: string): string;
  };
}

let installed: IntelligenceHost<CommandActionContext> | undefined;
function hostOf(): IntelligenceHost<CommandActionContext> {
  if (!installed) throw commandRefusal('Code intelligence is not available in this session.');
  return installed;
}
function readinessOf() {
  const readiness = hostOf().readiness;
  if ('unavailable' in readiness) throw commandRefusal(readiness.unavailable);
  return readiness;
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
/** The lines that say why a lookup has nothing, or nothing when it answered. */
function lookupStatusLines(result: LookupResult<unknown>): string[] {
  if (result.status === 'ok') return [];
  return [`  ${result.status}: ${result.reason}`, ...result.next.map((step) => `  next: ${step}`)];
}

function existingFile(ctx: CommandActionContext, file: string): string {
  const target = hostOf().resolvePath(ctx, file);
  if (!existsSync(target)) throw commandRefusal(`No file at ${target}.`);
  return target;
}
function position(values: Readonly<Record<string, string>>): { readonly line: number; readonly column: number } {
  const line = Number.parseInt(values.line ?? '', 10);
  const column = Number.parseInt(values.column ?? '', 10);
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) throw commandRefusal('A line and a column are whole numbers from 1.');
  return { line: line - 1, column: column - 1 };
}
async function withFacade<T>(ctx: CommandActionContext, work: (intelligence: IntelligenceFacade) => Promise<T>): Promise<T> {
  const hold = hostOf().hold(ctx);
  try {
    return await work(hold.intelligence);
  } finally {
    await hold.release();
  }
}

const FILE: InputDescription = textInput({ id: 'file', label: 'File', help: 'A source file in this project', why: 'a file path', kind: 'path', typed: { position: 1 } });
const AT: readonly InputDescription[] = [
  FILE,
  { id: 'line', label: 'Line', help: 'The line, from 1', kind: 'number', freeTextReason: 'a line number', required: true, typed: { position: 2 } },
  { id: 'column', label: 'Column', help: 'The column, from 1', kind: 'number', freeTextReason: 'a column number', required: true, typed: { flag: '--column' } },
];
const TERMINAL_ONLY = { terminalOnly: 'Code lookups run against this terminal\'s workspace.' } as const;

type IntelligenceAction = ActionDescription<CommandActionContext>;
function lookup(fields: Pick<IntelligenceAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'>): IntelligenceAction {
  return readAction({ ...fields, operator: TERMINAL_ONLY });
}

export const INTELLIGENCE_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'intelligence',
  title: 'Code intelligence',
  summary: 'Look up symbols, definitions and references in your code, install the language server a language needs, and see what is ready',
  group: 'Knowledge',
  report: 'review',
  firstScreenRows: [
    'review', 'definition', 'references', 'symbols',
    { label: 'More lookups…', actions: ['outline', 'hover', 'diagnostics'] },
    'install',
  ],
  actions: [
    lookup({
      id: 'review', label: 'See what code intelligence is ready', word: 'review', inputs: [],
      sentence: 'Shows whether problems, symbols and hover answers are ready, the language servers and their state, the problems tracked, and what to run when something is not ready.', example: {},
      async run(_values, ctx) { return readinessOf().review(ctx); },
    }),
    lookup({
      id: 'diagnostics', label: 'See the problems in a file', word: 'diagnostics',
      inputs: [{ ...FILE, help: 'A source file; blank for the file with the most errors', required: { default: '', defaultMeans: 'the file with the most errors' } }],
      sentence: 'Shows the errors and warnings tracked for the file named.', example: { file: 'src/index.ts' },
      async run(values, ctx) { return readinessOf().diagnostics(ctx, values.file ? hostOf().resolvePath(ctx, values.file) : ''); },
    }),
    lookup({
      id: 'symbols', label: 'See the symbols in a file', word: 'symbols', inputs: [FILE],
      sentence: 'Lists the symbols of {file}, from its language server or, without one, from its syntax tree.', example: { file: 'src/index.ts' },
      async run(values, ctx) {
        const target = existingFile(ctx, values.file!);
        return withFacade(ctx, async (intelligence) => {
          const symbols = await intelligence.getDocumentSymbols(target, readFileSync(target, 'utf-8'));
          const fromServer = symbols.length > 0 && 'selectionRange' in symbols[0]!;
          const entries = symbols.slice(0, 12).map((symbol) => ('selectionRange' in symbol ? formatDocumentSymbol(symbol) : formatTreeSitterSymbol(symbol)));
          return [
            `Symbols: ${target}`,
            `  from: ${fromServer ? 'the language server' : 'the syntax tree (the language server gave none or is not set up)'}`,
            `  results: ${symbols.length}`,
            ...(entries.length > 0 ? entries : ['  No symbols for this file.']),
          ].join('\n');
        });
      },
    }),
    lookup({
      id: 'outline', label: 'See the outline of a file', word: 'outline', inputs: [FILE],
      sentence: 'Shows the outline of {file}: its declarations and their lines.', example: { file: 'src/index.ts' },
      async run(values, ctx) {
        const target = existingFile(ctx, values.file!);
        return withFacade(ctx, async (intelligence) => {
          const outline = await intelligence.getOutline(target, readFileSync(target, 'utf-8'));
          return [
            `Outline: ${target}`,
            `  language ready: ${intelligence.hasTreeSitter(target) ? 'yes' : 'no'}`,
            `  results: ${outline.length}`,
            ...outline.slice(0, 12).map((entry) => `  ${entry.signature || entry.name}  line ${entry.line}`),
            ...(outline.length === 0 ? ['  No outline for this file.'] : []),
          ].join('\n');
        });
      },
    }),
    lookup({
      id: 'definition', label: 'Find where a symbol is defined', word: 'definition', inputs: AT,
      sentence: 'Finds where the symbol at line {line}, column {column} of {file} is defined.', example: { file: 'src/index.ts', line: '12', column: '8' },
      async run(values, ctx) {
        const target = existingFile(ctx, values.file!);
        const at = position(values);
        return withFacade(ctx, async (intelligence) => {
          const found = await intelligence.lookupDefinition(target, at.line, at.column);
          const definition = found.items[0];
          return [
            `Definition: ${target}:${at.line + 1}:${at.column + 1}`,
            ...(definition
              ? [`  in: ${definition.uri}`, `  line: ${definition.range.start.line + 1}`, `  column: ${definition.range.start.character + 1}`]
              : found.status === 'ok' ? ['  The language server found no definition there.'] : lookupStatusLines(found)),
          ].join('\n');
        });
      },
    }),
    lookup({
      id: 'references', label: 'Find where a symbol is used', word: 'references', inputs: AT,
      sentence: 'Finds every use of the symbol at line {line}, column {column} of {file}.', example: { file: 'src/index.ts', line: '12', column: '8' },
      async run(values, ctx) {
        const target = existingFile(ctx, values.file!);
        const at = position(values);
        return withFacade(ctx, async (intelligence) => {
          const found = await intelligence.lookupReferences(target, at.line, at.column);
          return [
            `Uses: ${target}:${at.line + 1}:${at.column + 1}`,
            `  results: ${found.items.length}`,
            ...found.items.slice(0, 12).map((reference) => `  ${reference.uri}  ${reference.range.start.line + 1}:${reference.range.start.character + 1}`),
            ...(found.items.length === 0 && found.status === 'ok' ? ['  The language server found no uses there.'] : []),
            ...lookupStatusLines(found),
          ].join('\n');
        });
      },
    }),
    lookup({
      id: 'hover', label: 'See what a symbol is', word: 'hover', inputs: AT,
      sentence: 'Shows the type and documentation of the symbol at line {line}, column {column} of {file}.', example: { file: 'src/index.ts', line: '12', column: '8' },
      async run(values, ctx) {
        const target = existingFile(ctx, values.file!);
        const at = position(values);
        return withFacade(ctx, async (intelligence) => {
          const found = await intelligence.lookupHover(target, at.line, at.column);
          const hover = found.items;
          const lines = typeof hover?.contents === 'string'
            ? hover.contents.split('\n')
            : Array.isArray(hover?.contents)
              ? hover.contents.flatMap((entry) => typeof entry === 'string' ? entry : entry.value.split('\n'))
              : hover?.contents && 'value' in hover.contents ? hover.contents.value.split('\n') : [];
          return [
            `About: ${target}:${at.line + 1}:${at.column + 1}`,
            ...(lines.length > 0 ? lines.slice(0, 8).map((line) => `  ${line}`) : found.status === 'ok' ? ['  The language server has nothing about that position.'] : lookupStatusLines(found)),
          ].join('\n');
        });
      },
    }),
    {
      id: 'install', label: 'Install the language server for a language', word: 'install',
      inputs: [textInput({ id: 'language', label: 'Language', help: 'A language name, or a file of that language', why: 'a language or a file', typed: { position: 1 } })],
      sentence: 'The language server for {language} is downloaded into your GoodVibes bin folder, and code lookups use it from then on, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'It installs into this machine\'s GoodVibes bin folder.' }, example: { language: 'typescript' },
      async run(values, ctx) {
        await runLanguageServerInstall(values.language!, {
          print: (text) => ctx.print(text),
          resolvePath: (target) => hostOf().resolvePath(ctx, target),
          hold: () => hostOf().hold(ctx),
          nextAfterInstall: 'code lookups for this language (/intelligence definition, references, symbols) use it from now on',
        });
      },
    },
  ],
};

const INTELLIGENCE_SLASH_COMMAND = defineCommand(INTELLIGENCE_COMMAND);

/** Register `/intelligence` (the one description) with this app's host. */
export function registerIntelligenceCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: IntelligenceHost<Ctx>): void {
  installed = host as unknown as IntelligenceHost<CommandActionContext>;
  registry.register(INTELLIGENCE_SLASH_COMMAND as never);
}
