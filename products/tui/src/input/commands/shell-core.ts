import { createShellCoreActions } from '@goodvibes-jev/engine/terminal-shell/shell-core-actions';
import { createBasicShellCommands, createShellNavigationCommands } from '@goodvibes-jev/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { CompactBusyError, compactConversation, requireKeybindingsManager, requireProviderApi, requireSessionMemoryStore } from './runtime-services.ts';
import {
  buildCompactionPreview,
  buildCompactionAfterNotice,
  buildPinUsageText,
  buildPinSuccessText,
} from '../../renderer/compaction-preview.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { createCompactCommand } from '@goodvibes-jev/engine/terminal-shell/everyday-commands';
import { helpForCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { registerModelCommands } from '@goodvibes-jev/engine/terminal-shell/model-command';

const coreActions = createShellCoreActions<CommandContext>(
  { requireKeybindingsManager, startFreshConversation },
  {
    hidden: false,
    shortcutOverlay: true,
    freshConversation: (ctx, savedAs) =>
      ctx.showToast?.({
        title: 'Fresh conversation',
        body: 'The previous one is saved as ' + savedAs + '. /session resume ' + savedAs + ' returns to it.',
        tone: 'info',
      }),
  },
);

export function registerShellCoreCommands(registry: CommandRegistry): void {
  const basicCommands = createBasicShellCommands<CommandContext>();
  const navigation = createShellNavigationCommands<CommandContext>({
    shortcutsHidden: false,
    shortcutsFallback: 'Press ? for every command and keyboard shortcut.',
  });

  // `/model` and `/effort` are one description each, shared with the other terminal app; a missing key is asked for before a switch lands.
  registerModelCommands<CommandContext>(registry, { requireProviderApi, beforeSelection: ensureProviderKeyThenSelect });

  registry.register(navigation.shortcuts);


  registry.register(coreActions.keybindings);

  registry.register(basicCommands.paste);


  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Open help: every command and keyboard shortcut in one searchable list; picking a command runs it. /help <command> shows one command\'s actions and lines',
    argsHint: '[command]',
    handler(args, ctx) {
      const named = args[0]?.replace(/^\//, '');
      if (named) {
        const command = registry.get(named);
        if (!command) throw commandRefusal(`No command named /${named}.`, '/help lists every command.');
        ctx.print(helpForCommand(command));
        return;
      }
      // `?`, /help, /commands and Ctrl+P open the same palette, built live from
      // the registry and the key table (terminal-shell/command-palette.ts).
      if (ctx.openCommandPalette) {
        ctx.openCommandPalette();
        return;
      }
      const commands = registry
        .getAll()
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      ctx.print(
        [
          'Commands:',
          ...commands.map((cmd) => {
            const argsHint = cmd.argsHint ?? cmd.usage;
            return `  /${cmd.name}${argsHint ? ` ${argsHint}` : ''} — ${cmd.description}`;
          }),
        ].join('\n'),
      );
    },
  });

  registry.register(coreActions.clear);

  registry.register(compactCommand);


  registry.register({
    name: 'keep',
    // The pinned text is kept exactly as typed.
    rawRest: 0,
    aliases: [],
    description: 'Pin text to session memory (survives compaction)',
    usage: '<text>',
    argsHint: '<text to preserve>',
    handler(args, ctx) {
      const text = args.join(' ').trim();
      if (!text) {
        ctx.print(buildPinUsageText());
        ctx.renderRequest();
        return;
      }
      const memStore = requireSessionMemoryStore(ctx);
      const id = memStore.add(text);
      if (!id) {
        ctx.print('[Pin] Nothing pinned: text was blank.');
      } else {
        const count = memStore.list().length;
        ctx.print(buildPinSuccessText(id, text, count));
      }
      ctx.renderRequest();
    },
  });

  registry.register(navigation.quit);

}

/** `/compact` is a single-action command shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const compactCommand = createCompactCommand<CommandContext>(async (_values, ctx) => {
  const messages = ctx.session.conversationManager.getMessagesForLLM();
  // contextWindow IS reachable from CommandContext, the same
  // call compactConversation() (runtime-services.ts) already makes to scale
  // its own behaviour by window size. Previously hardcoded to 0 here, which
  // silently suppressed buildCompactionPreview()'s capacity-% clause even
  // though the builder has always supported it.
  // 0 when the window is unknown: the preview then leaves out the capacity clause.
  const contextWindow =
    ctx.provider.providerRegistry.getKnownContextWindowForModel(ctx.provider.providerRegistry.getCurrentModel()) ?? 0;
  const memStore = ctx.session.sessionMemoryStore;
  const pinnedMemoryCount = memStore ? memStore.list().length : 0;
  // Pre-compact preview: honest estimate, clearly labelled.
  const preview = buildCompactionPreview({ messages, contextWindow, pinnedMemoryCount, trigger: 'manual' });
  ctx.print(preview);
  let result: Awaited<ReturnType<typeof compactConversation>>;
  try {
    result = await compactConversation(ctx);
  } catch (error) {
    if (!(error instanceof CompactBusyError)) throw error;
    ctx.print(error.message);
    return;
  }
  if (result.kind === 'summarised') {
    // Post-compact notice: uses real CompactionEvent figures, plus the
    // quality-score grade line when one was computed.
    ctx.print(buildCompactionAfterNotice({ event: result.event, pinnedMemoryCount, qualityScore: result.qualityScore }));
  } else if (result.kind === 'dropped') {
    ctx.print(`[Context] Dropped the ${result.dropped} oldest message(s) without a summary and kept the last ${result.kept}: this model's context window is too small to summarise them. Their tool results are gone; re-read any file you still need. /session compactions lists it.`);
  } else {
    ctx.print(`[Context] Nothing was compacted: ${result.reason}.`);
  }
  ctx.renderRequest();
});
