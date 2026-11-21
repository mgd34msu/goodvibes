import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { registerProviderCommand } from '@goodvibes/engine/terminal-shell/provider-command';
import { formatAgentRecordSource } from '@goodvibes/engine/terminal-shell/agent-turn/record-labels';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireProviderApi, requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';

/** `/provider` is one description shared with the other terminal app (terminal-shell/provider-command.ts); here a subscription sign-in always finishes with the pasted code. */
export function registerLocalProviderRuntimeCommands(registry: CommandRegistry): void {
  registerProviderCommand<CommandContext>(registry, {
    requireProviderApi,
    requireShellPaths,
    requireSecretsManager,
    requireSubscriptionManager,
    requireServiceRegistry,
    beforeSelection: (_ctx, _provider, complete) => complete(),
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    signInListens: false,
    codeEditing: false,
    formatSource: formatAgentRecordSource,
  });
}
