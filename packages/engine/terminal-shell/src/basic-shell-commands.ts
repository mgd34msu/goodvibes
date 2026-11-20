import type { TerminalSlashCommand } from './command-registry.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import type { CommandActionContext } from './command-actions/types.js';
import { doAction } from './described-command-kit.js';
export interface BasicShellCommandContext {
  readonly print: (message: string) => void;
  readonly pasteFromClipboard?: (() => { readonly pasted: boolean }) | undefined;
}
/**
 * /reset is not here: it is an alias of /clear (shell-core-actions.ts), whose
 * startFreshConversation saves a copy and resets the journal, recovery point,
 * rewind anchors and usage counters together.
 */
export function createBasicShellCommands<Context extends BasicShellCommandContext>(): {
  readonly paste: TerminalSlashCommand<Context>;
} {
  return {
    paste: {
      name: 'paste',
      effect: 'local-state',
      aliases: ['clip'],
      description: 'Insert clipboard text or image into the prompt',
      handler(_args, context) {
        if (!context.pasteFromClipboard) {
          context.print('Paste is not available in this context.');
          return;
        }
        const result = context.pasteFromClipboard();
        if (!result.pasted) context.print('Clipboard does not contain supported text or image data.');
      },
    },
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
