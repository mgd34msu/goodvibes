/**
 * `/intelligence` in the terminal app (terminal-shell/intelligence-command.ts):
 * lookups and installs over the workspace's one code-intelligence facade, and
 * the readiness and problems this terminal tracks in its read model.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { CodeIntelligence } from '@goodvibes/engine/platform/platform/intelligence';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { registerIntelligenceCommand, type IntelligenceHold } from '@goodvibes/engine/terminal-shell/intelligence-command';
import { requireReadModels, requireShellPaths } from './runtime-services.ts';

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
  registerIntelligenceCommand<CommandContext>(registry, {
    hold: options.holdIntelligence ?? holdWorkspaceIntelligence,
    resolvePath: (ctx, target) => requireShellPaths(ctx).resolveWorkspacePath(target),
    readiness: {
      review(ctx) {
        const state = requireReadModels(ctx).intelligence.getSnapshot();
        const notReady = [
          ...(state.diagnosticsStatus !== 'ready' ? [`problems: ${state.diagnosticsStatus} (check: /health check intelligence)`] : []),
          ...(state.symbolSearchStatus !== 'ready' ? [`symbols: ${state.symbolSearchStatus} (try: /intelligence symbols <file>)`] : []),
          ...(state.hoverStatus !== 'ready' ? [`hover: ${state.hoverStatus} (install its language server: /intelligence install <language>)`] : []),
        ];
        return [
          'Code intelligence',
          `  problems: ${state.diagnosticsStatus}`,
          `  symbols: ${state.symbolSearchStatus}`,
          `  hover: ${state.hoverStatus}`,
          `  language servers: ${state.languageServers.length > 0 ? state.languageServers.map((server) => `${server.language}=${server.state}`).join(', ') : 'none set up'}`,
          `  errors: ${state.errorCount}`,
          `  warnings: ${state.warningCount}`,
          `  files with problems: ${state.diagnostics.size}${state.diagnostics.size > 0 ? ' (/intelligence diagnostics)' : ''}`,
          ...(notReady.length > 0 ? ['  not ready:', ...notReady.map((line) => `    ${line}`)] : ['  everything is ready']),
        ].join('\n');
      },
      diagnostics(ctx, file) {
        const state = requireReadModels(ctx).intelligence.getSnapshot();
        // Tracked problems are keyed by absolute path, like every other action's file.
        const entries = [...state.diagnostics.entries()]
          .map(([filePath, diagnostics]) => ({
            filePath,
            diagnostics,
            errors: diagnostics.filter((entry) => entry.severity === 'error').length,
            warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
          }))
          .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.filePath.localeCompare(b.filePath));
        const selected = file ? entries.find((entry) => entry.filePath === file) : entries[0];
        if (!selected) throw commandRefusal(file ? `No problems are tracked for ${file}.` : 'No problems are tracked.');
        return [
          `Problems: ${selected.filePath}`,
          `  errors: ${selected.errors}`,
          `  warnings: ${selected.warnings}`,
          ...selected.diagnostics.slice(0, 8).map((diagnostic) => `  [${diagnostic.severity}] ${diagnostic.line + 1}:${diagnostic.column + 1} ${diagnostic.message}`),
          ...(entries.length > 1 ? [`  next file: /intelligence diagnostics ${entries[1]!.filePath}`] : []),
        ].join('\n');
      },
    },
  });
}
