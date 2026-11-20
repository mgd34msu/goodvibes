import {
  createContextInspectionCommand,
} from '@goodvibes-jev/engine/terminal-shell/context-inspection-command';
import { registerInteractionModeCommand } from '@goodvibes-jev/engine/terminal-shell/interaction-mode-command';
import { settingsTargetNotFoundMessage } from '@goodvibes-jev/engine/terminal-shell/settings-navigation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { ToolContractVerifier } from '@/runtime/index.ts';
import '@goodvibes-jev/engine/platform/platform/utils';
import { requireProfileManager } from './runtime-services.ts';
import { estimateConversationTokens } from '@goodvibes-jev/engine/platform/platform/core';
import { handleContextWindowSubcommand } from './context-window.ts';

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'settings',
    aliases: ['cfg-ui'],
    description: 'Open the fullscreen configuration workspace, at a category or setting when one is named',
    usage: '[category|key]',
    handler(args, ctx) {
      if (!ctx.openSettingsModal) {
        ctx.print('Configuration workspace is not available in this runtime.');
        return;
      }
      const target = args[0];
      const landed: unknown = ctx.openSettingsModal(target);
      if (target && landed === 'not-found') ctx.print(settingsTargetNotFoundMessage(target));
    },
  });

  registry.register(contextInspectionCommand);


  registry.register({
    name: 'profiles',
    // The singular `profile` alias was given up to /profile, the owner profile
    // (docs/owner-profile.md). These are two unrelated things, this command
    // loads saved display/provider settings presets, and the other one is what
    // the platform knows about the person who owns it, and the singular word
    // now belongs to the second. `/profiles` is unchanged; only the abbreviation
    // moved. See the naming note in docs/owner-profile.md §3.
    description: 'Browse and load config profiles',
    handler(_args, ctx) {
      if (ctx.openProfilePicker) {
        ctx.openProfilePicker();
      } else {
        const profiles = requireProfileManager(ctx).list();
        if (profiles.length === 0) ctx.print('No profiles saved. Open /profiles and press s to save the current settings as a profile.');
        else ctx.print(['Saved profiles:', ...profiles.map((p) => `  ${p.name}`)].join('\n'));
      }
    },
  });


  registerInteractionModeCommand<CommandContext>(registry);

  registry.register({
    name: 'tool',
    description: 'Verify registered tool contracts',
    usage: 'verify <name> | verify-all | contract show <name>',
    argsHint: 'verify <name> | verify-all | contract show <name>',
    async handler(args, ctx) {
      const sub = args[0];
      if (sub === 'verify' && args[1]) {
        const result = await ctx.extensions.toolRegistry.verifyContract(args[1]);
        if (!result) {
          ctx.print(`[tool verify] Tool '${args[1]}' is not registered.`);
          return;
        }
        ctx.print(ToolContractVerifier.formatResult(result));
        return;
      }
      if (sub === 'verify-all') {
        ctx.print(ToolContractVerifier.formatAllResults(await ctx.extensions.toolRegistry.verifyAllContracts()));
        return;
      }
      if (sub === 'contract' && args[1] === 'show' && args[2]) {
        const toolName = args[2];
        const result = await ctx.extensions.toolRegistry.verifyContract(toolName);
        if (!result) {
          ctx.print(`[tool contract show] Tool '${toolName}' is not registered.`);
          return;
        }
        const lines: string[] = [ToolContractVerifier.formatResult(result)];
        const tool = ctx.extensions.toolRegistry.list().find((t) => t.definition.name === toolName);
        if (tool) {
          lines.push('');
          lines.push('Tool Definition:');
          lines.push(`  Name:        ${tool.definition.name}`);
          lines.push(`  Description: ${tool.definition.description}`);
          lines.push(`  Parameters:  ${JSON.stringify(tool.definition.parameters, null, 2).replace(/\n/g, '\n               ')}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print(
        'Usage: /tool <subcommand>\n' +
          '  /tool verify <name>             — verify contract for a specific registered tool\n' +
          '  /tool verify-all                — verify contracts for all registered tools\n' +
          '  /tool contract show <name>      — show full contract details for a tool',
      );
    },
  });
}


const contextInspectionCommand = createContextInspectionCommand<CommandContext>({
  window: handleContextWindowSubcommand,
  estimate: (message) => estimateConversationTokens([message]),
  total: (messages) => estimateConversationTokens(messages),
});
