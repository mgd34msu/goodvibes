import { CodeIntelligence } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { registerIntelligenceCommand } from '@goodvibes-jev/engine/terminal-shell/intelligence-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

/**
 * `/intelligence` in the Agent (terminal-shell/intelligence-command.ts): code
 * lookups and language-server installs over the workspace's one facade, the
 * one the model's read and find tools hold, so a server installed here is the
 * one their next lookup starts. The readiness reading is the terminal app's.
 */
export function registerIntelligenceRuntimeCommands(registry: CommandRegistry): void {
  registerIntelligenceCommand<CommandContext>(registry, {
    hold: (ctx) => CodeIntelligence.holdForWorkspace(requireShellPaths(ctx)),
    resolvePath: (ctx, target) => requireShellPaths(ctx).resolveWorkspacePath(target),
    readiness: { unavailable: 'The Agent keeps no reading of code problems; the terminal app does (/intelligence review there). Lookups and installs work here.' },
  });
}
