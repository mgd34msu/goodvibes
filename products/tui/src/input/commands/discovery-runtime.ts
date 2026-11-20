import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand } from '@goodvibes/engine/terminal-shell/command-actions';
import { scan, persistProviders } from '@goodvibes/engine/platform/platform/discovery';
import { requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

/**
 * `/scan`, described once (command-actions/): one action that looks for
 * model servers on this computer and the local network and adds the ones it
 * finds to the providers.
 */
export function registerDiscoveryRuntimeCommands(registry: CommandRegistry, scanProviders: typeof scan = scan): void {
  registry.register(defineCommand<CommandContext>({
    name: 'scan',
    title: 'Find local model servers',
    summary: 'Look for model servers on this computer and your local network, and add what is found',
    group: 'Providers',
    actions: [{
      id: 'scan', label: 'Find model servers nearby', word: '', inputs: [],
      sentence: 'Probes this computer and your local network for model servers (Ollama, LM Studio and the like) and adds each one found to your providers, until you change it.',
      done: '', touches: 'another-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The scan runs from the terminal app\'s machine.' }, example: {},
      async run(_values, ctx) {
        ctx.print('Looking for model servers...');
        ctx.renderRequest();
        const result = await scanProviders();
        const lines = result.servers.length === 0
          ? [`No model servers found (looked at ${result.scannedHosts} hosts, ${result.scannedPorts} ports in ${Math.round(result.durationMs / 1000)}s).`]
          : [
              `Found ${result.servers.length} server(s) in ${Math.round(result.durationMs / 1000)}s:`,
              ...result.servers.map((server) => `  ${server.name.padEnd(30)} ${server.models.length} model(s)  ${server.host}:${server.port}`),
              'Choose one of their models: /model',
            ];
        if (result.skipped.length > 0) {
          lines.push(`${result.skipped.length} server(s) answered but were left out:`, ...result.skipped.map((server) => `  ${server.host}:${server.port}  ${server.reason}`));
        }
        try {
          await requireProviderApi(ctx).registerDiscoveredProviders(result.servers);
        } catch (err) {
          lines.push(`Some servers could not be added as providers: ${summarizeError(err)}`);
        }
        if (result.servers.length > 0) {
          persistProviders({ homeDirectory: requireShellPaths(ctx).homeDirectory, surfaceRoot: 'tui' }, result.servers);
        }
        ctx.renderRequest();
        return lines.join('\n');
      },
    }],
  }));
}
