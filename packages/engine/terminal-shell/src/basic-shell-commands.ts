import type { TerminalSlashCommand } from './command-registry.js';
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

export function createShellNavigationCommands<
  Context extends {
    print(text: string): void;
    exit(): void;
    readonly openHelpOverlay?: (() => void) | undefined;
    readonly openShortcutsOverlay?: (() => void) | undefined;
  },
>(policy: {
  readonly beforeCommands?: ((context: Context) => boolean) | undefined;
  readonly shortcutsHidden: boolean;
  readonly shortcutsFallback: string;
  readonly quitAliases: string[];
}): { commands: TerminalSlashCommand<Context>; shortcuts: TerminalSlashCommand<Context>; quit: TerminalSlashCommand<Context> } {
  return {
    commands: {
      name: 'commands',
      effect: 'ui-navigation',
      aliases: ['cmds'],
      description: 'Browse all commands in a scrollable list',
      handler(_args, context) {
        if (policy.beforeCommands?.(context)) return;
        if (context.openHelpOverlay) {
          context.openHelpOverlay();
          return;
        }
        context.print('Use /help for interactive command list');
      },
    },
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
    quit: {
      name: 'quit',
      effect: 'session-lifecycle',
      aliases: policy.quitAliases,
      description: 'Exit the application',
      handler(_args, context) {
        context.exit();
      },
    },
  };
}
