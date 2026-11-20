import { createSecretsCommand } from '@goodvibes-jev/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes-jev/engine/terminal-shell/local-command-actions';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';

import { openCommandView, requireProviderApi } from './runtime-services.ts';

export const localActions = createLocalCommandActions<CommandContext>(requireProviderApi, {
  hidden: false,
  unpinByModelId: false,
  imageHint: '<path> [prompt text]',
  supportedFormats: '\nSupported: .png, .jpg, .jpeg, .webp, .gif',
  maximumImageSize: 'Maximum: 20MB',
  partialRefresh: 'Some refreshes failed: see messages above.',
  error: (detail) => 'Error: ' + detail,
  imageFailure: (kind, detail) => kind + ': ' + detail,
  invalidBlockType: (type, valid) => 'Unknown type: ' + type + '\nValid types: ' + valid.join(', '),
  noteTouch: (conversation, key) => conversation.searchExpansion.noteUserTouch(key),
});

// `/secrets` is one description shared with the other terminal app (terminal-shell/secrets-command.ts); a credential is kept where it is asked.
const secretsCommand = createSecretsCommand<CommandContext>({
  writeScope: (_key, requested) => requested,
  deleteScope: (_key, requested) => requested,
  relocationNote: () => '',
});

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'incident-review',
    aliases: [],
    description: 'Alias for /incident open',
    handler(_args, ctx) {
      if (ctx.openIncidentView) {
        ctx.openIncidentView();
        return;
      }
      ctx.print('The Agents view is not available in this runtime.');
    },
  });

  registry.register({
    name: 'tools',
    aliases: ['t'],
    description: 'List available tools and review compact native tool capabilities',
    usage: '[review|panel]',
    handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'panel' || sub === 'review') {
        // Tool results render inline in the transcript and per agent in the
        // Agents modal; there is no separate tools view.
        ctx.print('Tool activity renders inline in the transcript and per agent in the Agents view. Opening Agents.');
        try {
          openCommandView(ctx, 'agents');
        } catch {
          // The view openers may be absent in lightweight command-only contexts.
        }
        if (sub === 'review') {
          ctx.print(
            [
              'Tool Surface Review',
              '  Native file tools stay compact by default.',
              '  Read/write/edit/notebook capabilities are available through the native tool stack, with detail routed inline and to approval surfaces instead of transcript bloat.',
              '  Shell and native tool approvals classify work into read, mutation, destructive, dependency, config, notebook, network, remote, and lifecycle risk families.',
              '  Use /tools panel to open Agents for live per-agent tool activity.',
              '  Use /approval review shell or /approval review file when you need the action-specific why-prompted posture.',
            ].join('\n'),
          );
        }
        return;
      }
      const tools = ctx.extensions.toolRegistry.list();
      if (ctx.openSelection) {
        const items: SelectionItem[] = tools.map((t) => ({
          id: t.definition.name,
          label: t.definition.name,
          detail: typeof t.definition.description === 'string' ? t.definition.description.slice(0, 50) : '',
        }));
        ctx.openSelection('Available Tools', items, { allowSearch: true }, (result) => {
          if (!result) return;
          const tool = tools.find((t2) => t2.definition.name === result.item.id);
          if (tool) ctx.print(`Tool: ${tool.definition.name}\n  ${tool.definition.description ?? ''}`);
        });
        return;
      }
      ctx.print(['Available tools:', ...tools.map((t) => `  • ${t.definition.name}`)].join('\n'));
    },
  });



  registry.register(secretsCommand);

  registry.register(localActions['image']);

  registry.register(localActions['refresh-models']);

  registry.register(localActions['pin']);

  registry.register(localActions['unpin']);
}
