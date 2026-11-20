// ---------------------------------------------------------------------------
// codebase-runtime.ts, /codebase
//
// Explicit-query + transparency surface over the repo source-tree code index
// (CodeIndexStore, @goodvibes-jev/engine/platform/platform/state, landed on platform main
// with explicit-query build/status/search) via the TUI's own wiring in
// src/runtime/code-index-services.ts, threaded through
// CommandContext.session.codeIndexStore exactly like wrfcController/
// workstreamEngine already are (bootstrap-command-context.ts).
//
// Mirrors /memory's transparency idiom (memory-command.ts's search index report:
// status/rebuild) and /workstream's registerXRuntimeCommands function-export
// shape: build (schedules the index build, visible as a fleet 'code-index'
// node while it runs), status (counts, skips, degradation state, last
// build), search <query> (explicit retrieval, results labeled
// 'lexical'|'semantic' honestly, never implied as more precise than they
// are). Passive auto-injection into coding turns and tool-site incremental
// reindex followed later; `status` surfaces both honestly (the
// auto-injection flag+setting gate, and the last reindex activity).
// ---------------------------------------------------------------------------

import type { CodeIndexStats, CodeContextResult, CodeIndexReindexActivity } from '@goodvibes-jev/engine/platform/platform/state';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { isCodeIndexAutoStartEnabled, CODE_INDEX_MAX_FILES, CODE_INDEX_MAX_FILE_BYTES, CODE_INDEX_MAX_TOTAL_BYTES } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * Honest one-line auto-injection state: both the (default-off)
 * `agent-passive-code-injection` feature flag AND storage.codeIndexEnabled must
 * be on for passive code injection to run, state which is off, and why.
 */
function renderAutoInjectionState(flagEnabled: boolean, settingEnabled: boolean): string {
  if (flagEnabled && settingEnabled) {
    return '  auto-injection: on (code hits may be injected into coding turns within the shared knowledge budget)';
  }
  const reasons: string[] = [];
  if (!flagEnabled) reasons.push('agent-passive-code-injection flag off (default off); enable in the settings modal flags section');
  if (!settingEnabled) reasons.push('storage.codeIndexEnabled off: /settings to change');
  return `  auto-injection: off (${reasons.join('; ')})`;
}

/** Honest last-reindex activity line (tool-site incremental reindex). */
function renderReindexActivity(activity: CodeIndexReindexActivity | null, now: number, autoStart: boolean): string {
  if (!activity) {
    return autoStart
      ? '  last reindex: none this session (writes/edits reindex touched files once the index is built)'
      : '  last reindex: off: edits do not update the index (storage.codeIndexEnabled is off; run /codebase build again or turn it on)';
  }
  const agoSec = Math.max(0, Math.round((now - activity.at) / 1000));
  const detail = activity.status === 'error'
    ? `error: ${activity.error ?? 'unknown'}`
    : activity.status === 'skipped'
      ? `skipped (${activity.reason ?? activity.mode ?? 'empty'})`
      : `indexed (${activity.mode ?? 'symbols'})`;
  return `  last reindex: ${activity.path}; ${detail}, ${agoSec}s ago`;
}

interface CodeIndexStatusExtras {
  readonly flagEnabled: boolean;
  readonly reindexActivity: CodeIndexReindexActivity | null;
  readonly now?: number;
}

function renderCodeIndexStatus(stats: CodeIndexStats, configManager: Pick<ConfigManager, 'get'>, extras: CodeIndexStatusExtras): string {
  const lines: string[] = [];
  lines.push(`Code index: backend: ${stats.backend}, available: ${stats.available ? 'yes' : 'no'}`);
  lines.push(`  path: ${stats.path}`);
  lines.push(`  indexed: ${stats.indexedFiles} file(s), ${stats.indexedChunks} chunk(s), ${stats.dimensions} dims`);
  lines.push(`  embedding provider: ${stats.embeddingProviderLabel} (${stats.embeddingProviderId})`);
  lines.push(
    stats.semanticRetrievalAvailable
      ? '  search results labeled: semantic'
      : '  search results labeled: lexical (hashed fallback; low precision)',
  );
  const autoStart = isCodeIndexAutoStartEnabled(configManager);
  lines.push(
    `  auto-build on startup: ${autoStart ? 'on' : 'off'} (storage.codeIndexEnabled, default off; /settings to change)`,
  );
  // Passive code auto-injection state (flag + setting) and the last tool-site reindex.
  lines.push(renderAutoInjectionState(extras.flagEnabled, autoStart));
  lines.push(renderReindexActivity(extras.reindexActivity, extras.now ?? Date.now(), autoStart));
  if ([CODE_INDEX_MAX_FILES, CODE_INDEX_MAX_FILE_BYTES, CODE_INDEX_MAX_TOTAL_BYTES].every(limit => limit === Infinity)) {
    lines.push('  limits: no file count or byte limits');
  } else {
    lines.push(
      `  bounds: max ${CODE_INDEX_MAX_FILES} files (maxFiles), ${formatBytes(CODE_INDEX_MAX_FILE_BYTES)} per file (maxFileBytes),`
      + ` ${formatBytes(CODE_INDEX_MAX_TOTAL_BYTES)} total per build (maxTotalBytes)`,
    );
  }

  // Provider-space honesty (platform finding): vectors embedded under a different
  // provider than the current default disable the vector search path until a
  // rebuild re-embeds, say so, in the store's own words.
  if (stats.embeddingProviderMismatch) {
    lines.push(`  provider mismatch: ${stats.embeddingProviderMismatch} (vector search disabled; lexical fallback only)`);
  }

  if (stats.building) {
    lines.push('  build: in progress');
  } else if (stats.lastBuild) {
    const b = stats.lastBuild;
    lines.push(
      `  last build: ${b.filesIndexed} indexed, ${b.filesUnchanged} unchanged, ${b.filesRemoved} removed,`
      + ` ${b.chunksIndexed} chunk(s) embedded (${b.chunksUnchanged} unchanged), ${b.durationMs}ms`,
    );
    if (b.filesFailed) lines.push(`  build failures: ${b.filesFailed} file(s) not indexed; first error: ${b.firstFailure ?? 'unknown'}`);
    const skip = b.skip;
    const skipParts: string[] = [];
    if (skip.tooLarge) skipParts.push(`${skip.tooLarge} too large`);
    if (skip.overFileCap) skipParts.push(`${skip.overFileCap} over file cap (maxFiles)`);
    if (skip.overTotalBytes) skipParts.push(`${skip.overTotalBytes} over total byte budget (maxTotalBytes)`);
    if (skip.binary) skipParts.push(`${skip.binary} binary`);
    if (skip.ignoredByGitignore) skipParts.push(`${skip.ignoredByGitignore} gitignored`);
    if (skip.readErrors) skipParts.push(`${skip.readErrors} read error(s)`);
    if (skip.chunkedByWindow) skipParts.push(`${skip.chunkedByWindow} windowed (no tree-sitter symbols)`);
    lines.push(skipParts.length > 0 ? `  skipped: ${skipParts.join(', ')}` : '  skipped: none');
  } else {
    lines.push('  last build: never; run /codebase build');
  }

  if (stats.error) lines.push(`  error: ${stats.error}`);
  if (stats.lastBuildError) lines.push(`  last build error: ${stats.lastBuildError}`);
  if (stats.lastSearchError) lines.push(`  last search error: ${stats.lastSearchError}`);

  const degradation = stats.semanticRetrievalAvailable ? null : describeDegradationFallback(stats);
  if (degradation) lines.push(`  ${degradation}`);

  return lines.join('\n');
}

/** Reuses the exact wording CodeIndexStore.describeDegradation() would return for a hashed-only provider, without requiring a live call the status renderer doesn't otherwise need. */
function describeDegradationFallback(stats: CodeIndexStats): string | null {
  if (stats.semanticRetrievalAvailable) return null;
  return 'code auto-retrieval disabled: no semantic embedding provider configured';
}

function renderSearchResults(results: readonly CodeContextResult[]): string {
  return results
    .map((result) => {
      const c = result.chunk;
      const pct = Math.round(result.similarity * 100);
      const symbol = c.symbol ? ` ${c.symbol}` : '';
      return `  ${c.path}:${c.startLine}-${c.endLine}  [${result.label}]  sim ${pct}%  ${c.kind}${symbol}`;
    })
    .join('\n');
}

function storeOf(ctx: CommandContext) {
  const store = ctx.session.codeIndexStore;
  if (!store) throw commandRefusal('The code index is not available in this session.');
  return store;
}

const TERMINAL_ONLY = { terminalOnly: 'The code index is kept by this terminal for this project.' } as const;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerCodebaseRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'codebase',
    title: 'Code index',
    summary: 'This project\'s code index: how it stands, build it, and search it',
    group: 'Knowledge',
    report: 'status',
    actions: [
      readAction<CommandContext>({
        id: 'status', label: 'See how the code index stands', word: 'status',
        sentence: 'Shows what is indexed, how search results are found, what was skipped, and the last build and reindex.', operator: TERMINAL_ONLY,
        async run(_values, ctx) {
          return renderCodeIndexStatus(storeOf(ctx).stats(), ctx.platform.configManager, {
            flagEnabled: ctx.session.isPassiveCodeInjectionFlagEnabled?.() ?? false,
            reindexActivity: ctx.session.codeIndexReindexScheduler?.lastActivity() ?? null,
          });
        },
      }),
      doAction<CommandContext>({
        id: 'build', label: 'Build the code index', word: 'build',
        sentence: 'The code index of this project is built in the background; Your agents shows it under Background services while it runs.', operator: TERMINAL_ONLY,
        async run(_values, ctx) {
          const store = storeOf(ctx);
          if (store.isBuilding()) {
            const progress = store.buildProgress();
            throw commandRefusal(progress ? `A build is already running (${progress.scanned}/${progress.total} files read).` : 'A build is already running.');
          }
          store.scheduleBuild();
          return 'Build started: /codebase status, or Your agents (F2) under Background services (b), shows how it goes.';
        },
      }),
      readAction<CommandContext>({
        id: 'search', label: 'Search the code index', word: 'search',
        inputs: [
          textInput({ id: 'words', label: 'Words', help: 'What to look for in the code', why: 'your own words', typed: { tail: true } }),
          { id: 'limit', label: 'How many', help: 'The most results to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: 'the usual number' }, typed: { flag: '--limit' } },
        ],
        sentence: 'Finds the parts of this project\'s code that match {words}, each labelled semantic or lexical.', example: { words: 'retry backoff', limit: '5' }, operator: TERMINAL_ONLY,
        async run(values, ctx) {
          const store = storeOf(ctx);
          const limit = values.limit ? Number.parseInt(values.limit, 10) : Number.NaN;
          const results = await store.search(values.words!, Number.isNaN(limit) ? undefined : { limit });
          if (results.length === 0) {
            const stats = store.stats();
            return stats.lastSearchError ? `Search failed: ${stats.lastSearchError}` : stats.indexedChunks === 0 ? 'No results: the code index is empty. Build it: /codebase build' : 'No matching code found.';
          }
          return `${results.length} result(s):\n${renderSearchResults(results)}`;
        },
      }),
    ],
  }));
}
