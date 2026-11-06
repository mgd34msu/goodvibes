import type { TerminalSlashCommand } from './command-registry.js';
export interface BasicShellCommandContext {
  readonly print: (message: string) => void;
  readonly pasteFromClipboard?: (() => { readonly pasted: boolean }) | undefined;
  readonly reloadSystemPrompt?: (() => string) | undefined;
  readonly renderRequest: () => void;
  readonly session: {
    readonly conversationManager: { resetAll(): void; rebuildHistory(): unknown };
    readonly runtime: { systemPrompt: string };
  };
}
export function createBasicShellCommands<Context extends BasicShellCommandContext>(): {
  readonly paste: TerminalSlashCommand<Context>;
  readonly reset: TerminalSlashCommand<Context>;
} {
  return {
    paste: {
      name: 'paste',
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
    reset: {
      name: 'reset',
      aliases: [],
      description: 'Full reset: clear display and conversation context',
      handler(_args, context) {
        context.session.conversationManager.resetAll();
        if (context.reloadSystemPrompt) context.session.runtime.systemPrompt = context.reloadSystemPrompt();
        context.session.conversationManager.rebuildHistory();
        context.renderRequest();
      },
    },
  };
}
