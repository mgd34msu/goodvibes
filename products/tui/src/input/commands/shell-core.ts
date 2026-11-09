import { createShellCoreActions } from '@goodvibes-jev/engine/terminal-shell/shell-core-actions';
import { createBasicShellCommands, createShellNavigationCommands } from '@goodvibes-jev/engine/terminal-shell/basic-shell-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { publishActiveEffortOptions } from '../../providers/reasoning-effort-surface.ts';
import { executeWriteQuit } from './quit-shared.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi, requireSessionMemoryStore } from './runtime-services.ts';
import {
  buildCompactionPreview,
  buildCompactionAfterNotice,
  buildPinUsageText,
  buildPinSuccessText,
} from '../../renderer/compaction-preview.ts';
import { buildCompactionHistoryText } from '../../renderer/compaction-history-modal.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';
import '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/utils';

const coreActions = createShellCoreActions<CommandContext>(
  { requireProviderApi, requireKeybindingsManager, startFreshConversation },
  {
    hidden: false,
    modelHint: '[model-id]',
    choiceMarker: '\\u25c9',
    offeredIndent: '',
    shortcutOverlay: true,
    unsupportedEffortAdvice: true,
    beforeSelection: ensureProviderKeyThenSelect,
    publishEffort: (_ctx, model) => publishActiveEffortOptions(model),
    modelSelected: (model, provider) => 'Switched to model: ' + model + ' (' + provider + ')',
    effortMessage: (level, changed) => (changed ? 'Reasoning effort set to: ' : 'Reasoning effort: ') + level,
    error: (detail) => 'Error: ' + detail,
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
    shortcutsFallback: 'Use /commands for shortcuts',
    quitAliases: [':q', 'exit'],
  });

  registry.register(coreActions.model);

  registry.register(navigation.commands);

  registry.register(navigation.shortcuts);

  registry.register({
    name: 'find',
    aliases: ['findtext'],
    description: 'Search THIS conversation transcript (same as Ctrl+F). Searching the web instead? Use /search',
    handler(_args, ctx) {
      if (ctx.openTranscriptSearch) {
        ctx.openTranscriptSearch();
        return;
      }
      ctx.print('Transcript search is not available in this context; try Ctrl+F.');
    },
  });

  registry.register(coreActions.keybindings);

  registry.register(basicCommands.paste);

  registry.register({
    name: 'pastes',
    aliases: ['pending-pastes'],
    description: 'Preview the actual content behind each [TEXT: pN, M lines] fold in the composer, before you submit',
    usage: '[pN]',
    argsHint: '[pN]',
    handler(args, ctx) {
      const pending = ctx.getPendingPastes?.();
      if (!pending || pending.size === 0) {
        ctx.print('[Pastes] No folded pastes are currently in the composer (pastes over 8 lines fold to [TEXT: pN, M lines]).');
        return;
      }
      const requestedId = args[0]?.trim();
      if (requestedId) {
        const content = pending.get(requestedId);
        if (!content) {
          ctx.print(`[Pastes] No pending paste with id "${requestedId}". Pending: ${[...pending.keys()].join(', ')}`);
          return;
        }
        ctx.print(`[Pastes] ${requestedId} (${content.split('\n').length} lines):\n${content}`);
        return;
      }
      const lines = ['[Pastes] Folded in the composer right now:'];
      for (const [id, content] of pending) {
        const contentLines = content.split('\n');
        const preview = contentLines[0].slice(0, 80);
        lines.push(
          `  ${id} (${contentLines.length} lines): ${preview}${contentLines.length > 1 || preview.length < contentLines[0].length ? '…' : ''}`,
        );
      }
      lines.push('', 'Full text: /pastes <id>');
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Browse every command with its description; picking one runs it',
    handler(_args, ctx) {
      // Generated live from the command registry, never a hand-maintained
      // list, so /help can never drift from the real command set. Category
      // labels come from the same single source of truth as the generated
      // reference and the palette (ctx.getCommandCategories; see its doc for
      // why it is threaded through the context rather than imported here).
      const commands = registry
        .getAll()
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      if (ctx.openSelection) {
        const categoryByName = ctx.getCommandCategories?.() ?? new Map<string, string>();
        const items: SelectionItem[] = commands.map((cmd) => {
          const argsHint = cmd.argsHint ?? cmd.usage;
          const aliases = cmd.aliases ?? [];
          return {
            id: cmd.name,
            label: argsHint ? `/${cmd.name} ${argsHint}` : `/${cmd.name}`,
            detail: aliases.length > 0 ? `${cmd.description} [aka ${aliases.map((a) => `/${a}`).join(', ')}]` : cmd.description,
            category: categoryByName.get(cmd.name) ?? 'Other',
          };
        });
        // every item here is a command, and picking one RUNS it, label
        // the verb "Run" (matching the slash-command palette) instead of the
        // generic "Select" default.
        ctx.openSelection('Help: Commands', items, { allowSearch: true, primaryVerbLabel: 'Run' }, (result) => {
          if (!result) return;
          const name = result.item.id;
          void (ctx.executeCommand?.(name, []) ?? registry.execute(name, [], ctx));
        });
        return;
      }
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

  registry.register(basicCommands.reset);

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Summarize conversation to free context window',
    async handler(_args, ctx) {
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
      const result = await compactConversation(ctx);
      if (result) {
        // Post-compact notice: uses real CompactionEvent figures, plus an
        // out-of-band quality-score grade line when one was computed ().
        ctx.print(buildCompactionAfterNotice({ event: result.event, pinnedMemoryCount, qualityScore: result.qualityScore }));
      } else {
        ctx.print('[Context] Compact complete.');
      }
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'compact-history',
    aliases: ['compaction-history'],
    description: 'Show compaction history for this session',
    handler(_args, ctx) {
      ctx.print(buildCompactionHistoryText());
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'keep',
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

  registry.register({
    name: 'wq',
    aliases: [':wq'],
    description: 'Commit all git changes and then exit',
    async handler(_args, ctx) {
      await executeWriteQuit(ctx);
    },
  });

  registry.register({
    name: 'debug',
    aliases: [],
    description: 'Toggle debug mode',
    handler(_args, ctx) {
      ctx.session.runtime.debugMode = !ctx.session.runtime.debugMode;
      ctx.print(`Debug mode: ${ctx.session.runtime.debugMode ? 'ON' : 'OFF'}`);
      // Honest quiet counter for direct terminal writes the guard intercepted
      // (routed here instead of spamming the transcript). (item 1a.)
      const intercepted = ctx.session.runtime.terminalWritesIntercepted ?? 0;
      if (intercepted > 0) {
        ctx.print(`Terminal writes intercepted this session: ${intercepted} (details in the activity log)`);
      }
    },
  });

  registry.register(coreActions.effort);
}
