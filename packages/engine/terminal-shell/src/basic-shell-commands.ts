import type { TerminalSlashCommand } from './command-registry.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext } from './command-actions/types.js';
import { doAction, listInput, readAction } from './described-command-kit.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { commandRefusal } from './command-confirmation.js';
export interface BasicShellCommandContext extends CommandActionContext {
  readonly pasteFromClipboard?: (() => { readonly pasted: boolean }) | undefined;
  /** Text folded in the composer as `[TEXT: pN, M lines]`, by its id. */
  readonly getPendingPastes?: (() => ReadonlyMap<string, string>) | undefined;
}

const PENDING_PASTES = defineList<BasicShellCommandContext>({
  name: 'composer.pastes',
  async read(ctx) {
    return [...(ctx.getPendingPastes?.() ?? new Map<string, string>())].map(([id, content]): ListRow => ({
      value: id, label: content.split('\n')[0]!.slice(0, 80), state: `${content.split('\n').length} lines`,
    }));
  },
  operator: { terminalOnly: 'Pastes are held in the terminal app\'s composer.' },
});

/** `/paste`: put the clipboard into the prompt, and read what folded pastes hold before sending them. */
export function createBasicShellCommands<Context extends BasicShellCommandContext>(): {
  readonly paste: DescribedCommand<Context>;
} {
  return {
    paste: defineCommand<Context>({
      name: 'paste', title: 'Paste', summary: 'Put the clipboard into the prompt, and read folded pastes before you send them', group: 'Conversation', report: 'see-pastes',
      actions: [
        readAction<Context>({
          id: 'see-pastes', label: 'Read the pastes folded in the prompt', word: 'list',
          inputs: [listInput({ id: 'paste', label: 'Paste', help: 'Pastes folded in the prompt now', list: PENDING_PASTES, optional: { default: '', means: 'a line for each' } })],
          sentence: 'Shows what each folded paste ([TEXT: pN, M lines]) in the prompt holds; with one chosen, its whole text.',
          operator: { terminalOnly: 'Pastes are held in the terminal app\'s composer.' }, example: { paste: 'p1' },
          async run(values, ctx) {
            const pending = ctx.getPendingPastes?.();
            if (!pending || pending.size === 0) return 'No paste is folded in the prompt (a paste over 8 lines folds to [TEXT: pN, M lines]).';
            if (values.paste) {
              const content = pending.get(values.paste);
              if (content === undefined) throw commandRefusal(`No folded paste is ${values.paste}.`, `Folded now: ${[...pending.keys()].join(', ')}`);
              return `${values.paste} (${content.split('\n').length} lines):\n${content}`;
            }
            return ['Folded in the prompt now:', ...[...pending].map(([id, content]) => {
              const lines = content.split('\n');
              const preview = lines[0]!.slice(0, 80);
              return `  ${id} (${lines.length} lines): ${preview}${lines.length > 1 || preview.length < lines[0]!.length ? '…' : ''}`;
            })].join('\n');
          },
        }),
        doAction<Context>({
          id: 'paste-clipboard', label: 'Paste the clipboard into the prompt', word: 'clipboard', touches: 'reads',
          sentence: 'The text or image on the clipboard goes into the prompt; nothing is sent until you send it.',
          operator: { terminalOnly: 'It is the terminal app\'s prompt.' },
          async run(_values, ctx) {
            if (!ctx.pasteFromClipboard) throw commandRefusal('Pasting is not available here.');
            if (!ctx.pasteFromClipboard().pasted) throw commandRefusal('The clipboard holds no text or image this app can paste.');
          },
        }),
      ],
    }),
  };
}

/**
 * `/shortcuts` and `/quit`. `/quit` is described once (command-actions/): one
 * action, the same in both terminal apps. A bare `:q` or `:wq` typed in the
 * composer still closes the program (feed-token-routes.ts); those are keys,
 * not names of this command. The command palette is `/help` (and `?`, Ctrl+P).
 */
export function createShellNavigationCommands<
  Context extends CommandActionContext & {
    print(text: string): void;
    exit(): void;
    readonly openShortcutsOverlay?: (() => void) | undefined;
  },
>(policy: {
  readonly shortcutsHidden: boolean;
  readonly shortcutsFallback: string;
}): { shortcuts: TerminalSlashCommand<Context>; quit: DescribedCommand<Context> } {
  return {
    shortcuts: {
      name: 'shortcuts',
      effect: 'ui-navigation',
      aliases: ['keys', 'keybinds'],
      description: 'Show keyboard shortcuts reference',
      firstScreen: !policy.shortcutsHidden,
      handler(_args, context) {
        if (context.openShortcutsOverlay) {
          context.openShortcutsOverlay();
          return;
        }
        context.print(policy.shortcutsFallback);
      },
    },
    quit: defineCommand<Context>({
      name: 'quit',
      title: 'Quit',
      summary: 'Close this program',
      group: 'Shell',
      actions: [
        doAction<Context>({
          id: 'quit', label: 'Close this program', word: '',
          sentence: 'This program closes; work the daemon runs goes on without it.',
          ownerOnly: { reason: 'it closes the program you are using', instead: 'Say that the work is done; the owner closes the program.' },
          async run(_values, context) { context.exit(); },
        }),
      ],
    }),
  };
}
