/**
 * /status, the current model and its context window with where the window
 * came from ('catalog: abacus', 'consensus of 4 providers', 'family
 * default', 'user override'), read from the platform registry the status line
 * reads. Token use stays on the status line and in /context.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { describeContextWindowSource } from '@goodvibes-jev/engine/platform/platform/providers';
import { abbreviateCount } from '../../utils/format-number.ts';
import { worktreeStatusLines } from '@goodvibes-jev/engine/platform/platform/runtime/shell';

/** The /status text for a model, its known window (null when unknown) and any user override. */
export function buildAgentStatusText(model: ModelDefinition, knownWindow: number | null, override: number | null): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(12)} ${value}`;
  const window = knownWindow === null
    ? model.contextWindowProvenance === 'accepted_floor'
      ? `unknown (the provider accepted ${abbreviateCount(model.contextWindow, { bSuffix: true })}, more than the stated window)`
      : 'unknown (nothing states this model\'s context window)'
    : abbreviateCount(knownWindow, { bSuffix: true });
  return [
    'Status',
    row('model', `${model.displayName} (${model.provider})`),
    row('context', window),
    row('window from', describeContextWindowSource(model)),
    row('override', override === null ? 'none (automatic); set with /context window <size>' : `${override.toLocaleString()} tokens`),
  ].join('\n');
}

/**
 * The worktree section: what the start-up pass removed and each worktree it
 * kept for the owner's decision with the next steps, as the start notice said.
 */
function worktreeSection(ctx: CommandContext): string[] {
  const worktrees = ctx.workspace.worktreeRegistry;
  const workingDirectory = ctx.workspace.shellPaths?.workingDirectory;
  if (!worktrees || workingDirectory === undefined) return [];
  return ['Worktrees', ...worktreeStatusLines(worktrees.lastStartupReport(), workingDirectory).map((line) => `  ${line}`)];
}

/** Print /status for the current model. Returns the text it printed (for tests). */
export function handleStatusCommand(ctx: CommandContext): string {
  const registry = ctx.provider.providerRegistry;
  const model = registry.getCurrentModel();
  const text = [
    buildAgentStatusText(model, registry.getKnownContextWindowForModel(model), registry.getModelContextCap(model.registryKey)),
    ...worktreeSection(ctx),
  ].join('\n');
  ctx.print(text);
  return text;
}

export function registerStatusRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'status',
    effect: 'read-only',
    description: 'Show the current model and its context window, with where the window came from, and the worktrees the start-up pass removed or kept for you',
    handler: (_args, ctx) => {
      handleStatusCommand(ctx);
    },
  });
}
